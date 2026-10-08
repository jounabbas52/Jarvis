// One place where every one-shot Gemini call is made — the Node port of
// core/gemini.py.
//
// The user's conversation runs on the Live API in the renderer and is not what
// this file is about. Everything else — reading a document, grounding a web
// search, turning a request into a shell command — comes through here, with a
// deadline on every call and a ladder of models behind it:
//
//   LIVE first: a throwaway Live session per call. It draws on a different
//   quota pool from the REST text models, and on the free tier the text pool
//   is the one that runs dry. Its reply arrives through output transcription,
//   because the Live models only speak.
//   REST behind it: pinned names first, rolling aliases last.
//
// A rung that answers 429 is out of quota and is skipped for five minutes
// instead of being paid for in front of every request.
//
// Contents use the JS SDK's shapes: a string, or an array of parts such as
// { text } and { inlineData: { mimeType, data /* base64 */ } }.

const config = require('./config');

const FAST = 'fast';
const SMART = 'smart';
const SEARCH = 'search';
const LIVE = 'live';

const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

const LADDERS = {
  [FAST]: [LIVE, 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
  [SMART]: [LIVE, 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  // Grounded search needs grounding metadata, which a Live turn cannot carry.
  [SEARCH]: ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'],
};

const ONE_SHOT_SYSTEM =
  'You are a data-processing function, not an assistant and not in a ' +
  'conversation. There is no person listening to you. Produce exactly the ' +
  'output the request asks for and nothing else: no greeting, no ' +
  "acknowledgement, no 'Understood', no explanation, no closing remark, no " +
  'restating of the question. If the request asks for JSON, emit only the ' +
  'JSON. If it asks for code, emit only the code. If it asks for one word, ' +
  'emit that one word. Preserve the exact spelling, punctuation, capitals ' +
  'and whitespace of anything you are asked to copy or return.';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 10_000;
const COOLDOWN_MS = 300_000;
const LIVE_SLOTS = 3;
const LIVE_SLOT_WAIT_MS = 3_000;

const cooldown = new Map();
let liveInUse = 0;

let sdk = null;
function genai() {
  if (!sdk) sdk = require('@google/genai');
  return sdk;
}

function cool(model) {
  cooldown.set(model, Date.now() + COOLDOWN_MS);
}

function cooling(model) {
  const until = cooldown.get(model);
  if (until && Date.now() < until) return true;
  cooldown.delete(model);
  return false;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function toParts(contents) {
  const items = Array.isArray(contents) ? contents : [contents];
  const parts = [];
  for (const item of items) {
    if (item == null) continue;
    if (typeof item === 'string') parts.push({ text: item });
    else if (item.parts && Array.isArray(item.parts)) parts.push(...item.parts);
    else parts.push(item);
  }
  return parts;
}

async function acquireLiveSlot() {
  const deadline = Date.now() + LIVE_SLOT_WAIT_MS;
  while (liveInUse >= LIVE_SLOTS) {
    if (Date.now() > deadline) throw new Error('no free Live slot — leaving them for the conversation');
    await new Promise((r) => setTimeout(r, 100));
  }
  liveInUse++;
}

/** One throwaway Live session. Resolves to the transcript of what it said. */
async function liveTurn(contents, system, key, timeoutMs) {
  const { GoogleGenAI, Modality } = genai();
  const parts = toParts(contents);
  if (!parts.length) return '';
  await acquireLiveSlot();
  let session = null;
  try {
    const ai = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: 'v1beta' } });
    const chunks = [];
    let done;
    let fail;
    const finished = new Promise((res, rej) => {
      done = res;
      fail = rej;
    });
    session = await withTimeout(
      ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          systemInstruction: ONE_SHOT_SYSTEM + (system ? `\n\n${system}` : ''),
        },
        callbacks: {
          onmessage: (msg) => {
            const sc = msg.serverContent;
            if (sc?.outputTranscription?.text) chunks.push(sc.outputTranscription.text);
            // The transcription can trail the audio turn by a beat.
            if (sc?.turnComplete) setTimeout(done, 1500);
          },
          onerror: (e) => fail(new Error(e?.message || 'Live error')),
          onclose: (e) => {
            if (e?.code && e.code !== 1000) fail(new Error(`Live closed ${e.code} ${e.reason || ''}`));
            else done();
          },
        },
      }),
      30_000,
      'Live connect',
    );
    session.sendClientContent({ turns: [{ role: 'user', parts }], turnComplete: true });
    await withTimeout(finished, Math.max(10_000, timeoutMs), 'Live turn');
    return chunks.join('').trim();
  } finally {
    liveInUse--;
    try {
      session?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Run one generation, walking the ladder until a rung answers. Returns
 * `{ text, response }` — `response` is the SDK's own object on REST rungs, so
 * callers needing grounding metadata still get it — or null if every rung
 * failed. `tier` is FAST / SMART / SEARCH, or an explicit model name that is
 * tried first with the SMART ladder behind it.
 */
async function call(contents, { tier = FAST, config: genConfig, timeoutMs = DEFAULT_TIMEOUT_MS, key = '' } = {}) {
  let ladder = LADDERS[tier];
  if (!ladder) ladder = [tier, ...LADDERS[SMART].filter((m) => m !== tier)];

  const apiKey = key || config.getGeminiKey();
  if (!apiKey) {
    console.warn('[Gemini] no Gemini API key is configured');
    return null;
  }
  const tried = ladder.filter((m) => !cooling(m));
  const rungs = tried.length ? tried : ladder;
  const { GoogleGenAI } = genai();
  let ai = null;

  for (const model of rungs) {
    try {
      if (model === LIVE) {
        // Tools and response schemas cannot ride a Live side call.
        if (genConfig?.tools || genConfig?.responseMimeType) continue;
        const text = await liveTurn(contents, genConfig?.systemInstruction || '', apiKey, timeoutMs);
        if (text) return { text, response: null };
        throw new Error('the Live turn came back empty');
      }
      ai ||= new GoogleGenAI({ apiKey, httpOptions: { timeout: Math.max(MIN_TIMEOUT_MS, timeoutMs) } });
      const response = await withTimeout(
        ai.models.generateContent({ model, contents, config: genConfig }),
        Math.max(MIN_TIMEOUT_MS, timeoutMs) + 2_000,
        model,
      );
      return { text: (response.text || '').trim(), response };
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        cool(model);
        console.warn(`[Gemini] ${model}: out of quota — skipping it for ${COOLDOWN_MS / 60000} minutes`);
      } else {
        console.warn(`[Gemini] ${model}: ${msg.slice(0, 160)}`);
      }
    }
  }
  return null;
}

/** `call`, reduced to the reply text. `fallback` when nothing answered. */
async function text(contents, opts = {}, fallback = '') {
  const r = await call(contents, opts);
  return (r && r.text) || fallback;
}

/** `text`, parsed as JSON, tolerating fences and prose around it. */
async function asJson(contents, opts = {}, fallback = null) {
  let raw = await text(contents, opts);
  if (!raw) return fallback;
  if (raw.includes('{') && raw.includes('}')) raw = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  else if (raw.includes('[') && raw.includes(']')) raw = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[Gemini] reply was not JSON: ${e.message}`);
    return fallback;
  }
}

/**
 * Grounded Google Search. Resolves to `{ text, sources: [{title, uri}] }` or
 * null. REST only — a Live turn cannot carry grounding metadata.
 */
async function search(prompt, { timeoutMs = 20_000 } = {}) {
  const r = await call(prompt, { tier: SEARCH, timeoutMs, config: { tools: [{ googleSearch: {} }] } });
  if (!r) return null;
  const chunks = r.response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .map((c) => c.web)
    .filter(Boolean)
    .map((w) => ({ title: w.title || '', uri: w.uri || '' }));
  return { text: r.text, sources };
}

module.exports = {
  FAST,
  SMART,
  SEARCH,
  LIVE,
  LIVE_MODEL,
  DEFAULT_TIMEOUT_MS,
  call,
  text,
  asJson,
  search,
};
