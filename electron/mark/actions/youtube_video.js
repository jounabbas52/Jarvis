// youtube_video — the Node port of actions/youtube_video.py.
//
// play: scrape the first non-Shorts result and open it in the default browser.
// summarize: ask for a URL, fetch the transcript, summarise it with Gemini.
// get_info / trending: scrape the watch / trending pages.
//
// Mark used youtube-transcript-api; that has no Node equivalent installed, so
// the transcript comes straight from the caption track the player itself
// lists (captionTracks), via the watch page and, failing that, the Innertube
// player endpoint.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const YT_VIDEO_FILTER = 'EgIQAQ%3D%3D';
const quotePlus = (s) => encodeURIComponent(s).replace(/%20/g, '+');

async function get(url, timeoutMs) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  return r.text();
}

async function openUrl(url) {
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
  } catch (e) {
    console.log(`[YouTube] ⚠️ open_url failed: ${e?.message || e}`);
  }
}

async function scrapeFirstVideoUrl(query) {
  const searchUrl = `https://www.youtube.com/results?search_query=${quotePlus(query)}&sp=${YT_VIDEO_FILTER}`;
  try {
    const html = await get(searchUrl, 10_000);
    const seen = new Set();
    for (const m of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
      const vid = m[1];
      if (seen.has(vid)) continue;
      seen.add(vid);
      if (html.includes(`/shorts/${vid}`)) continue;
      return `https://www.youtube.com/watch?v=${vid}`;
    }
  } catch (e) {
    console.log(`[YouTube] ⚠️ scrape_first_video_url failed: ${e?.message || e}`);
  }
  return null;
}

function extractVideoId(url) {
  const m = String(url || '').match(/(?:v=|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

const isValidYoutubeUrl = (url) => /(youtube\.com|youtu\.be)/.test(url || '');

/**
 * Mark's tkinter askstring: a small always-on-top input window. Resolves the
 * trimmed text, or null when cancelled or closed. The page reports back by
 * changing its title, so no preload or IPC channel is needed.
 */
function askForUrl(promptText = 'YouTube video URL:') {
  return new Promise((resolve) => {
    let BrowserWindow;
    try {
      ({ BrowserWindow } = require('electron'));
    } catch (e) {
      console.log(`[YouTube] ⚠️ URL dialog failed: ${e?.message || e}`);
      resolve(null);
      return;
    }
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>J.A.R.V.I.S</title><style>
      body{margin:0;padding:16px;background:#0a0f14;color:#cfefff;font:13px Segoe UI,sans-serif}
      input{width:100%;box-sizing:border-box;padding:8px;margin:10px 0;background:#051018;color:#fff;border:1px solid #00d4ff;border-radius:4px}
      button{padding:6px 16px;margin-left:8px;background:#00303f;color:#cfefff;border:1px solid #00d4ff;border-radius:4px;cursor:pointer}
      .row{text-align:right}</style></head><body>
      <div>${esc(promptText)}</div><input id="u" autofocus>
      <div class="row"><button id="c">Cancel</button><button id="o">OK</button></div>
      <script>
        const u=document.getElementById('u');
        const done=(t)=>{document.title=t};
        document.getElementById('o').onclick=()=>done('OK:'+u.value);
        document.getElementById('c').onclick=()=>done('CANCEL:');
        u.addEventListener('keydown',e=>{if(e.key==='Enter')done('OK:'+u.value);if(e.key==='Escape')done('CANCEL:')});
      </script></body></html>`;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const win = new BrowserWindow({
        width: 460,
        height: 170,
        resizable: false,
        minimizable: false,
        maximizable: false,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        title: 'J.A.R.V.I.S',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      win.webContents.on('page-title-updated', (_e, title) => {
        if (title.startsWith('OK:')) {
          const v = title.slice(3).trim();
          finish(v || null);
          win.destroy();
        } else if (title.startsWith('CANCEL:')) {
          finish(null);
          win.destroy();
        }
      });
      win.on('closed', () => finish(null));
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      win.once('ready-to-show', () => win.focus());
    } catch (e) {
      console.log(`[YouTube] ⚠️ URL dialog failed: ${e?.message || e}`);
      finish(null);
    }
  });
}

// ── Transcript ───────────────────────────────────────────────────────────────
const LANG_PRIORITY = ['en', 'tr', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'ar', 'zh'];

/** Pull the captionTracks array out of a JSON-ish blob. */
function captionTracksFrom(text) {
  const i = text.indexOf('"captionTracks":');
  if (i < 0) return [];
  const start = text.indexOf('[', i);
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, j + 1));
      } catch {
        return [];
      }
    }
  }
  return [];
}

async function listTracks(videoId) {
  // The Innertube player endpoint with the Android client hands out caption
  // URLs that are fetchable without a browser-bound token; the watch page is
  // the fallback.
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
        videoId,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const data = await r.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(tracks) && tracks.length) return tracks;
  } catch (e) {
    console.log(`[YouTube] Innertube caption list failed: ${e?.message || e}`);
  }
  const html = await get(`https://www.youtube.com/watch?v=${videoId}`, 12_000);
  return captionTracksFrom(html);
}

function pickTrack(tracks) {
  const lang = (t) => String(t.languageCode || '').split('-')[0];
  const manual = tracks.filter((t) => t.kind !== 'asr');
  const generated = tracks.filter((t) => t.kind === 'asr');
  for (const pool of [manual, generated]) {
    for (const l of LANG_PRIORITY) {
      const t = pool.find((x) => lang(x) === l);
      if (t) return t;
    }
  }
  return tracks[0] || null;
}

async function fetchTrackText(baseUrl) {
  const url = new URL(baseUrl.replace(/\\u0026/g, '&'));
  url.searchParams.set('fmt', 'json3');
  const body = await get(url.toString(), 15_000);
  if (body.trim().startsWith('{')) {
    const data = JSON.parse(body);
    return (data.events || [])
      .flatMap((e) => (e.segs || []).map((s) => s.utf8 || ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }
  // XML (srv1/srv3) fallback
  return body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getTranscript(videoId) {
  try {
    const tracks = await listTracks(videoId);
    const t = pickTrack(tracks);
    if (!t || !t.baseUrl) return null;
    const text = await fetchTrackText(t.baseUrl);
    return text || null;
  } catch (e) {
    console.log(`[YouTube] ⚠️ Transcript fetch failed: ${e?.message || e}`);
    return null;
  }
}

async function summarizeWithGemini(ctx, transcript) {
  const maxChars = 80000;
  const truncated = transcript.slice(0, maxChars) + (transcript.length > maxChars ? '...' : '');
  // A whole transcript can be 80k characters, hence the long deadline.
  const r = await ctx.gemini.call(`Please summarize this YouTube video transcript:\n\n${truncated}`, {
    tier: ctx.gemini.SMART,
    timeoutMs: 60_000,
    config: {
      systemInstruction:
        'You are JARVIS, an AI assistant. ' +
        'Summarize YouTube video transcripts clearly and concisely. ' +
        'Structure: 1-sentence overview, then 3-5 key points. ' +
        "Be direct. Address the user as 'sir'. " +
        'Match the language of the transcript.',
    },
  });
  if (!r) return "I couldn't reach Gemini to summarise that transcript, sir.";
  return String(r.text || '').trim();
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    file: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
    human: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

/** Write a text file to the Desktop and open it in the platform's editor. */
function saveAndOpen(ctx, filename, content) {
  const desktop = ctx?.paths?.desktop || path.join(os.homedir(), 'Desktop');
  fs.mkdirSync(desktop, { recursive: true });
  const filepath = path.join(desktop, filename);
  fs.writeFileSync(filepath, content, 'utf-8');
  const { launchDetached } = require('../util/ps');
  const osName = ctx?.os || { win32: 'windows', darwin: 'mac' }[process.platform] || 'linux';
  if (osName === 'windows') launchDetached('notepad.exe', [filepath]);
  else if (osName === 'mac') launchDetached('open', ['-t', filepath]);
  else launchDetached('xdg-open', [filepath]);
  return filepath;
}

async function scrapeVideoInfo(videoId) {
  try {
    const html = await get(`https://www.youtube.com/watch?v=${videoId}`, 12_000);
    const info = {};
    for (const [key, re] of [
      ['title', /"title":\{"runs":\[\{"text":"([^"]+)"/],
      ['channel', /"ownerChannelName":"([^"]+)"/],
      ['views', /"viewCount":"(\d+)"/],
      ['duration', /"lengthSeconds":"(\d+)"/],
      ['likes', /"label":"([0-9,]+ likes)"/],
    ]) {
      const m = html.match(re);
      if (!m) continue;
      const raw = m[1];
      if (key === 'views') info[key] = Number(raw).toLocaleString('en-US');
      else if (key === 'duration') {
        const secs = parseInt(raw, 10);
        info[key] = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      } else info[key] = raw;
    }
    return info;
  } catch (e) {
    console.log(`[YouTube] ⚠️ Info scrape failed: ${e?.message || e}`);
    return {};
  }
}

/**
 * Titles and channels, taken only from inside videoRenderer blocks. Mark
 * matched every "title" run on the page, which on today's YouTube also picks
 * up menu labels ("Keyboard shortcuts", "Playback" …).
 */
function videoEntries(html, maxResults) {
  const results = [];
  const seen = new Set();
  for (const block of html.split('"videoRenderer":{').slice(1)) {
    if (results.length >= maxResults) break;
    const t = block.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)+)"/);
    if (!t) continue;
    const title = JSON.parse(`"${t[1]}"`);
    if (seen.has(title) || title.length < 5) continue;
    seen.add(title);
    const c = block.match(/"ownerText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)+)"/);
    results.push({ rank: results.length + 1, title, channel: c ? JSON.parse(`"${c[1]}"`) : 'Unknown' });
  }
  return results;
}

async function scrapeTrending(region = 'TR', maxResults = 8) {
  try {
    // YouTube has retired the Trending feed and it currently renders no
    // videos, so this honestly reports "could not fetch" rather than
    // passing off menu labels or keyword search results as trending.
    const html = await get(`https://www.youtube.com/feed/trending?gl=${region.toUpperCase()}`, 12_000);
    return videoEntries(html, maxResults);
  } catch (e) {
    console.log(`[YouTube] ⚠️ Trending scrape failed: ${e?.message || e}`);
    return [];
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function handlePlay(params, ctx) {
  const query = String(params.query || '').trim();
  if (!query) return "Please tell me what you'd like to watch, sir.";
  ctx?.ui?.log(`[YouTube] Searching: ${query}`);
  console.log(`[YouTube] 🔍 Scraping first non-Shorts video for: ${query}`);

  const videoUrl = await scrapeFirstVideoUrl(query);
  if (videoUrl) {
    console.log(`[YouTube] ▶️ Opening: ${videoUrl}`);
    await openUrl(videoUrl);
    return `Playing: ${query}`;
  }
  console.log('[YouTube] ⚠️ Scrape failed, opening filtered search page');
  await openUrl(`https://www.youtube.com/results?search_query=${quotePlus(query)}&sp=${YT_VIDEO_FILTER}`);
  return `Opened YouTube search for: ${query} (manual selection required)`;
}

async function handleSummarize(params, ctx) {
  // Mark always asks; a URL the model already has is used directly.
  const url = String(params.url || '').trim() || (await askForUrl('Please paste the YouTube video URL:'));
  if (!url) return 'No URL provided, sir. Summary cancelled.';
  if (!isValidYoutubeUrl(url)) return "That doesn't appear to be a valid YouTube URL, sir.";
  const videoId = extractVideoId(url);
  if (!videoId) return 'Could not extract video ID from that URL, sir.';

  ctx?.ui?.log(`[YouTube] Summarizing: ${url}`);
  ctx?.speak?.('Fetching the transcript now, sir. One moment.');

  const transcript = await getTranscript(videoId);
  if (!transcript) return "I couldn't retrieve a transcript for that video, sir.";

  ctx?.speak?.('Transcript retrieved. Generating summary now.');
  let summary;
  try {
    summary = await summarizeWithGemini(ctx, transcript);
  } catch (e) {
    return `Summary generation failed, sir: ${e?.message || e}`;
  }
  ctx?.speak?.(summary);

  if (params.save) {
    const s = stamp();
    const header =
      'JARVIS — YouTube Summary\n' +
      `${'─'.repeat(50)}\n` +
      `URL    : ${url}\n` +
      `Date   : ${s.human}\n` +
      `${'─'.repeat(50)}\n\n`;
    const saved = saveAndOpen(ctx, `youtube_summary_${s.file}.txt`, header + summary);
    return `Summary complete and saved to Desktop: ${saved}`;
  }
  return summary;
}

async function handleGetInfo(params, ctx) {
  let url = String(params.url || '').trim();
  if (!url) url = (await askForUrl('Please paste the YouTube video URL:')) || '';
  if (!url || !isValidYoutubeUrl(url)) return 'Please provide a valid YouTube URL, sir.';
  const videoId = extractVideoId(url);
  if (!videoId) return 'Could not extract video ID, sir.';
  ctx?.ui?.log(`[YouTube] Getting info: ${url}`);

  const info = await scrapeVideoInfo(videoId);
  if (!Object.keys(info).length) return 'Could not retrieve video information, sir.';
  const result = ['title', 'channel', 'views', 'duration', 'likes']
    .filter((k) => k in info)
    .map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${info[k]}`)
    .join('\n');
  ctx?.speak?.(`Here's the video info, sir. ${result.replace(/\n/g, '. ')}`);
  return result;
}

async function handleTrending(params, ctx) {
  const region = String(params.region || 'TR').toUpperCase();
  ctx?.ui?.log(`[YouTube] Trending: ${region}`);
  const trending = await scrapeTrending(region, 8);
  if (!trending.length) return `Could not fetch trending videos for region ${region}, sir.`;
  const result = [`Top trending videos in ${region}:`, ...trending.map((v) => `${v.rank}. ${v.title} — ${v.channel}`)].join(
    '\n',
  );
  ctx?.speak?.(
    'Here are the top trending videos, sir. ' +
      trending
        .slice(0, 3)
        .map((v) => `Number ${v.rank}: ${v.title} by ${v.channel}`)
        .join('. '),
  );
  return result;
}

const ACTION_MAP = { play: handlePlay, summarize: handleSummarize, get_info: handleGetInfo, trending: handleTrending };

async function run(parameters, ctx) {
  const params = parameters || {};
  const action = String(params.action || 'play').toLowerCase().trim();
  ctx?.ui?.log(`[YouTube] Action: ${action}`);
  console.log(`[YouTube] ▶️  Action: ${action}  Params: ${JSON.stringify(params)}`);

  const handler = ACTION_MAP[action];
  if (!handler) return `Unknown YouTube action: '${action}'. Available: play, summarize, get_info, trending.`;
  try {
    return (await handler(params, ctx)) || 'Done.';
  } catch (e) {
    console.log(`[YouTube] ❌ Error in ${action}: ${e?.message || e}`);
    return `YouTube ${action} failed, sir: ${e?.message || e}`;
  }
}

module.exports = {
  TOOL: {
    name: 'youtube_video',
    description:
      "Controls YouTube. Use for: playing videos, summarizing a video's content, getting video info, or showing trending videos.",
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'play | summarize | get_info | trending (default: play)' },
        query: { type: 'STRING', description: 'Search query for play action' },
        save: { type: 'BOOLEAN', description: 'Save summary to Notepad (summarize only)' },
        region: { type: 'STRING', description: 'Country code for trending e.g. TR, US' },
        url: { type: 'STRING', description: 'Video URL for get_info action' },
      },
      required: [],
    },
  },
  run,
  // helpers, exported for tests
  scrapeFirstVideoUrl,
  getTranscript,
  extractVideoId,
  saveAndOpen,
};
