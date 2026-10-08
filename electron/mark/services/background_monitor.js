// BackgroundMonitor — the Node port of actions/background_monitor.py.
//
// User-configured topic watching: checks DDG news once per day per topic and
// returns an alert when a new headline appears. No crypto, no finance, no
// uninvited tracking. Monitors live in long_term.json under "monitors", the
// same place Mark keeps them.

const crypto = require('crypto');
const memory = require('../memory');

// ── Blocked categories (never monitor regardless of what user says) ─────────
const BLOCKED = [
  // Brand / asset names — spelled the same in every language
  'bitcoin', 'ethereum', 'dogecoin', 'solana', 'binance',
  'nft', 'blockchain', 'defi', 'altcoin', 'memecoin', 'coin', 'token',
  // spellings of the "crypto" root across different languages
  'crypto', 'kripto', 'cripto', 'krypto', 'крипто', '仮想通貨', '暗号資産',
  'cryptocurrency',
];

const isBlocked = (topic) => {
  const t = topic.toLowerCase();
  return BLOCKED.some((w) => t.includes(w));
};

// ── Slug / hash helpers ──────────────────────────────────────────────────────
const slug = (topic) =>
  topic
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 40)
    .replace(/^_+|_+$/g, '');

const titleHash = (title) => crypto.createHash('md5').update(title, 'utf8').digest('hex').slice(0, 12);

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ── Memory I/O ───────────────────────────────────────────────────────────────
function load() {
  const data = memory.loadMemory().monitors;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function save(monitors) {
  const mem = memory.loadMemory();
  mem.monitors = monitors;
  memory.saveMemory(mem);
}

// ── Public API ───────────────────────────────────────────────────────────────
function addMonitor(topic) {
  topic = String(topic || '').trim();
  if (!topic) return 'Please specify a topic to monitor.';
  if (isBlocked(topic)) return "I don't monitor crypto or financial topics.";
  const monitors = load();
  const s = slug(topic);
  if (s in monitors) return `Already monitoring: ${monitors[s].topic}`;
  monitors[s] = { topic, added: today(), last_check: '', last_hash: '' };
  save(monitors);
  console.log(`[Monitor] ➕ Added: ${topic}`);
  return `Now monitoring: ${topic}`;
}

function removeMonitor(topic) {
  topic = String(topic || '').trim().toLowerCase();
  const monitors = load();
  // exact slug match first
  const s = slug(topic);
  if (s in monitors) {
    const label = monitors[s].topic;
    delete monitors[s];
    save(monitors);
    return `Stopped monitoring: ${label}`;
  }
  // partial match fallback
  for (const [key, val] of Object.entries(monitors)) {
    if (String(val?.topic || '').toLowerCase().includes(topic)) {
      const label = val.topic;
      delete monitors[key];
      save(monitors);
      return `Stopped monitoring: ${label}`;
    }
  }
  return `Not found in monitored topics: ${topic}`;
}

function listMonitors() {
  return Object.entries(load()).map(([k, v]) => (v && v.topic) || k);
}

/**
 * Run all pending topic checks (once per day per topic). Resolves to a list of
 * [MONITOR_ALERT] strings — empty if nothing new.
 */
async function checkAll() {
  const { ddgNews } = require('../actions/web_search');
  const monitors = load();
  if (!Object.keys(monitors).length) return [];

  const day = today();
  const alerts = [];
  let changed = false;

  for (const [s, data] of Object.entries(monitors)) {
    if (data.last_check === day) continue; // already checked today
    const topic = data.topic || s;
    try {
      const results = await ddgNews(topic, 5);
      if (!results.length) {
        monitors[s].last_check = day;
        changed = true;
        continue;
      }
      const top = results[0];
      const title = String(top.title || '').trim();
      if (!title) continue;

      const h = titleHash(title);
      monitors[s].last_check = day;
      changed = true;
      if (h === data.last_hash) continue; // same headline as last check — no alert
      monitors[s].last_hash = h;

      const snippet = String(top.snippet || '').slice(0, 150);
      const source = top.source || '';
      const parts = [`[MONITOR_ALERT] ${topic}`, `Headline: ${title}`];
      if (snippet) parts.push(snippet);
      if (source) parts.push(`Source: ${source}`);
      alerts.push(parts.join('\n'));
      console.log(`[Monitor] 🔔 New headline for '${topic}': ${title.slice(0, 60)}`);
    } catch (e) {
      console.log(`[Monitor] ⚠️ Check failed for '${topic}': ${e?.message || e}`);
    }
  }

  if (changed) save(monitors);
  return alerts;
}

module.exports = { addMonitor, removeMonitor, listMonitors, checkAll };
