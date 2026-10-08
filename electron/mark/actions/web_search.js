// web_search — the Node port of actions/web_search.py.
//
// Gemini grounded search answers first; DuckDuckGo is the fallback that needs
// no key. Mark used the `ddgs` package; here DDG is spoken to directly: the
// no-JS HTML endpoint for web results and the news.js JSON endpoint (behind a
// vqd token from the main page) for articles.
//
// The news mode is the exception to "Gemini first": DDG goes first there, see
// news() below for why.

const gemini = require('../gemini');
const config = require('../config');

// ── Gemini grounding quota circuit breaker ───────────────────────────────────
// The google_search grounding tool has its own small quota, separate from plain
// generation. Once it is spent every call fails — so retrying it at the top of
// every search only adds a dead round-trip before the DDG fallback runs. After
// a failure of the whole grounded ladder, skip Gemini for a cooldown period.
// (gemini.js swallows the error text, so "every rung failed" stands in for
// Mark's 429/RESOURCE_EXHAUSTED check; gemini.js has already cooled the
// individual models that answered 429.)
const QUOTA_COOLDOWN_MS = 900_000; // 15 minutes
let quotaBlockedUntil = 0;

const geminiAvailable = () => Date.now() >= quotaBlockedUntil;

function noteGeminiError(err) {
  if (!err || !err.quota) return;
  const already = Date.now() < quotaBlockedUntil;
  quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
  if (!already) {
    console.log(
      '[WebSearch] Gemini grounding quota exhausted — skipping it for ' +
        `${QUOTA_COOLDOWN_MS / 60000} min and serving results from DDG.`,
    );
  }
}

class QuotaCooldown extends Error {}

/** Log a Gemini failure — silently when it is just the expected cooldown. */
function logGeminiFailure(context, err) {
  if (err instanceof QuotaCooldown) return; // announced once when the breaker tripped
  console.log(`[WebSearch] ⚠️ ${context} failed (${err?.message || err}) — using DDG instead`);
}

/** Run fn(); resolve its result, or null if it throws or overruns. */
function runBounded(fn, timeoutMs, label = 'task') {
  let timer;
  return Promise.race([
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        logGeminiFailure(label, e);
        return null;
      }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.log(`[WebSearch] ${label} exceeded ${Math.round(timeoutMs / 1000)}s — moving on`);
        resolve(null);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function geminiSearch(query) {
  if (!geminiAvailable()) throw new QuotaCooldown('Gemini grounding is in quota cooldown');
  if (!config.getGeminiKey()) throw new Error('no Gemini API key is configured');

  // Grounded search reads a live page, so it gets a longer deadline than the
  // default — but it still HAS one, and it still walks the fallback ladder.
  const r = await gemini.search(query, { timeoutMs: 30_000 });
  if (!r) {
    const err = new Error('every Gemini model on the ladder failed');
    err.quota = true;
    noteGeminiError(err);
    throw err;
  }
  const text = String(r.text || '').trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

// ── DuckDuckGo ───────────────────────────────────────────────────────────────
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
}

const cleanHtml = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** DDG HTML results link through /l/?uddg=<real url>; unwrap it. */
function realUrl(href) {
  let h = decodeEntities(href || '');
  if (h.startsWith('//')) h = `https:${h}`;
  try {
    const u = new URL(h);
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/')) return u.searchParams.get('uddg') || h;
  } catch {
    /* relative or odd — return as is */
  }
  return h;
}

async function fetchText(url, opts = {}, timeoutMs = 10_000) {
  const r = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** Results from the html.duckduckgo.com page; ads ("result--ad") skipped. */
function parseHtmlResults(html, maxResults) {
  const results = [];
  for (const b of html.split(/<div class="result results_links/).slice(1)) {
    if (results.length >= maxResults) break;
    if (/result--ad/.test(b.slice(0, 200))) continue;
    const a = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    results.push({ title: cleanHtml(a[2]), snippet: sn ? cleanHtml(sn[1]) : '', url: realUrl(a[1]) });
  }
  return results;
}

/** Results from the lite.duckduckgo.com table layout. */
function parseLiteResults(html, maxResults) {
  const results = [];
  const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<td class='result-snippet'>([\s\S]*?)<\/td>/g)].map((m) => cleanHtml(m[1]));
  links.forEach((m, i) => {
    if (results.length >= maxResults) return;
    const url = realUrl(m[1]);
    if (/duckduckgo\.com\/y\.js/.test(url)) return; // sponsored
    results.push({ title: cleanHtml(m[2]), snippet: snippets[i] || '', url });
  });
  return results;
}

async function ddgSearch(query, maxResults = 6) {
  // DDG answers some request shapes with a 202 bot-check ("anomaly") page, so
  // the three no-JS forms are tried in turn until one returns results.
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = `q=${encodeURIComponent(query)}`;
  const attempts = [
    ['html POST', () => fetchText('https://html.duckduckgo.com/html/', { method: 'POST', headers: form, body }), parseHtmlResults],
    ['html GET', () => fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`), parseHtmlResults],
    ['lite', () => fetchText('https://lite.duckduckgo.com/lite/', { method: 'POST', headers: form, body }), parseLiteResults],
  ];
  let lastErr = null;
  for (const [label, get, parse] of attempts) {
    try {
      const results = parse(await get(), maxResults);
      if (results.length) return results;
      lastErr = new Error(`${label}: no results`);
    } catch (e) {
      lastErr = new Error(`${label}: ${e?.message || e}`);
    }
  }
  console.log(`[WebSearch] ⚠️ DDG text() failed: ${lastErr?.message}`);
  return [];
}

async function ddgVqd(query) {
  const html = await fetchText(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=news`);
  const m = html.match(/vqd=["']?([\d-]+)/);
  if (!m) throw new Error('no vqd token');
  return m[1];
}

/** DDG news search — returns actual articles, not website homepages. */
async function ddgNews(query, maxResults = 8) {
  let results = [];
  try {
    const vqd = await ddgVqd(query);
    const body = await fetchText(
      `https://duckduckgo.com/news.js?l=wt-wt&o=json&noamp=1&q=${encodeURIComponent(query)}&vqd=${vqd}&p=-1`,
      { headers: { Referer: 'https://duckduckgo.com/' } },
    );
    const data = JSON.parse(body);
    for (const r of data.results || []) {
      if (results.length >= maxResults) break;
      results.push({
        title: cleanHtml(r.title || ''),
        snippet: cleanHtml(r.excerpt || ''),
        url: r.url || '',
        source: r.source || '',
      });
    }
  } catch (e) {
    console.log(`[WebSearch] ⚠️ DDG news() failed (${e?.message || e}) — falling back to text search`);
  }
  // Also covers an empty news answer.
  if (!results.length) results = await ddgSearch(query, maxResults);
  return results;
}

function formatDdg(query, results) {
  if (!results.length) return `No results found for: ${query}`;
  const lines = [`Search results for: ${query}\n`];
  results.forEach((r, i) => {
    if (r.title) lines.push(`${i + 1}. ${r.title}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    if (r.url) lines.push(`   Source: ${r.url}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function formatNews(query, results) {
  if (!results.length) return `No news found for: ${query}`;
  const lines = [`Latest news: ${query}\n`];
  results.forEach((r, i) => {
    if (!r.title) return;
    const src = r.source ? `  [${r.source}]` : '';
    lines.push(`${i + 1}. ${r.title}${src}`);
    if (r.snippet) lines.push(`   ${r.snippet.slice(0, 140)}`);
    if (r.url) lines.push(`   ${r.url}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

// ── Briefing helper ──────────────────────────────────────────────────────────
/**
 * Current headlines via Gemini grounded search, minimal prompt.
 * Resolves `[headlines, rawText]`.
 */
async function geminiHeadlines(n = 5) {
  const r = await gemini.call(`Current world news: ${n} headlines. Numbered list, titles only.`, {
    tier: gemini.SEARCH,
    config: { tools: [{ googleSearch: {} }] },
    timeoutMs: 30_000,
  });
  if (!r) return [[], ''];
  const raw = String(r.text || '');
  const headlines = [];
  for (let line of raw.trim().split('\n')) {
    line = line.trim();
    // Only numbered lines — skips preamble/closing sentences.
    if (!line || !/^\d+[.)-]/.test(line)) continue;
    const clean = line.replace(/^\d+[.)-]\s*/, '').replace(/^\*+\s*/, '').trim();
    if (clean && clean.length > 10) headlines.push(clean);
  }
  return [headlines.slice(0, n), raw.trim()];
}

// ── Modes ────────────────────────────────────────────────────────────────────
/** Default search — Gemini grounded, DDG fallback. */
async function search(query) {
  try {
    return await geminiSearch(query);
  } catch (e) {
    logGeminiFailure('Gemini search', e);
    return formatDdg(query, await ddgSearch(query));
  }
}

/**
 * DDG first, Gemini as backup.
 *
 * Racing both burned one grounding call on every news request — including the
 * startup briefing — even when DDG had already won, and grounding's small
 * quota then ran dry for research/compare, the modes that need a synthesised
 * answer. DDG news answers in well under a second with raw headlines, which is
 * what the briefing wants, so Gemini is only touched when DDG comes back empty.
 */
async function news(query) {
  query = String(query || '').trim();
  const geminiQuery = query ? `latest news today: ${query}` : 'top world news today';
  const ddgQuery = query || 'world news today';

  let text = await runBounded(async () => formatNews(ddgQuery, await ddgNews(ddgQuery, 8)), 5_000, 'DDG news');
  if (text && text.length > 60 && !text.startsWith('No news found')) return text;

  text = await runBounded(() => geminiSearch(geminiQuery), 6_000, 'Gemini news');
  if (text && text.length > 60) return text;

  return `No news found for: ${query}`;
}

/** Deep dive — a comprehensive Gemini answer; falls back to a wider DDG fetch. */
async function research(query) {
  const q =
    `Comprehensive, detailed explanation of: ${query}. ` +
    'Include background context, key facts, current state, and important nuances.';
  try {
    return await geminiSearch(q);
  } catch (e) {
    logGeminiFailure('Gemini research', e);
    return formatDdg(query, await ddgSearch(query, 10));
  }
}

/** Product price lookup — searches for current market prices. */
async function price(query) {
  try {
    return await geminiSearch(`current price of ${query} — how much does it cost today`);
  } catch (e) {
    logGeminiFailure('Gemini price', e);
    return formatDdg(query, await ddgSearch(`${query} price buy`, 6));
  }
}

async function compare(items, aspect) {
  const q = `Compare ${items.join(', ')} in terms of ${aspect}. Give specific facts and data.`;
  try {
    return await geminiSearch(q);
  } catch (e) {
    logGeminiFailure('Gemini compare', e);
  }
  const all = {};
  for (const item of items) {
    try {
      all[item] = await ddgSearch(`${item} ${aspect}`, 3);
    } catch {
      all[item] = [];
    }
  }
  const lines = [`Comparison — ${aspect.toUpperCase()}`, '─'.repeat(40)];
  for (const item of items) {
    lines.push(`\n▸ ${item}`);
    for (const r of (all[item] || []).slice(0, 2)) {
      if (r.snippet) lines.push(`  • ${r.snippet}`);
      if (r.url) lines.push(`    ${r.url}`);
    }
  }
  return lines.join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function webSearch(params) {
  params = params || {};
  const query = String(params.query || '').trim();
  let mode = String(params.mode || 'search').toLowerCase().trim();
  const items = Array.isArray(params.items) ? params.items.map(String).filter(Boolean) : [];
  const aspect = String(params.aspect || 'general').trim() || 'general';

  if (!query && !items.length) return 'Please provide a search query.';
  if (items.length && mode !== 'compare') mode = 'compare';

  console.log(`[WebSearch] 🔍 mode='${mode}'  query='${query}'`);
  try {
    if (mode === 'compare' && items.length) return await compare(items, aspect);
    if (mode === 'news') return await news(query);
    if (mode === 'research') return await research(query);
    if (mode === 'price') return await price(query);
    return await search(query);
  } catch (e) {
    console.log(`[WebSearch] ❌ All backends failed: ${e?.message || e}`);
    return `Search failed: ${e?.message || e}`;
  }
}

module.exports = {
  TOOL: {
    name: 'web_search',
    description:
      "Searches the web. Use for ANY question about current facts, events, prices, or topics — always prefer this over guessing. Modes: 'search' (default), 'news' (latest headlines on a topic), 'research' (deep comprehensive answer), 'price' (product cost lookup), 'compare' (side-by-side comparison of items).",
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search query or topic' },
        mode: { type: 'STRING', description: 'search | news | research | price | compare' },
        items: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Items to compare (compare mode)' },
        aspect: { type: 'STRING', description: 'Comparison aspect: price | specs | reviews | features' },
      },
      required: ['query'],
    },
  },

  run: async (parameters, ctx) => {
    const params = parameters || {};
    const query = String(params.query || '').trim();
    const items = Array.isArray(params.items) ? params.items : [];
    const mode = String(params.mode || 'search').toLowerCase().trim();
    ctx?.ui?.log(`[Search:${items.length && mode !== 'compare' ? 'compare' : mode}] ${query || items.join(', ')}`);

    const r = await webSearch(params);

    // Mark's main.py mirrors search results to the content panel after the
    // tool returns; here the tool does it itself.
    if (ctx?.ui && r && !r.startsWith('No results') && !r.startsWith('Search failed')) {
      const m = String(params.mode || 'search');
      const q = String(params.query || '') || items.join(', ');
      const label = q ? `${m.toUpperCase()} — ${q.slice(0, 38)}` : m.toUpperCase();
      ctx.ui.showContent(label, r);
    }
    return r;
  },

  // Used by the morning briefing (index.js mark:news) and background_monitor.
  news,
  ddgNews,
  ddgSearch,
  geminiHeadlines,
  webSearch,
};
