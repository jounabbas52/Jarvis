// Mark LIV long-term memory — the Node port of memory/memory_manager.py.
//
// Storage and prompt budget are separate problems: nothing is deleted short
// of a runaway guard, the prompt carries identity plus a recency-budgeted core,
// and everything else is listed as an index of keys so the model knows to call
// recall_memory for it.

const fs = require('fs');
const path = require('path');
const { MARK_DIR } = require('./config');

const MEMORY_PATH = path.join(MARK_DIR, 'long_term.json');
const MAX_VALUE_LENGTH = 380;
const MEMORY_MAX_CHARS = 200_000;
const PROMPT_CORE_CHARS = 900;
const PROMPT_INDEX_CHARS = 420;
const PROMPT_MAX_PER_CATEGORY = 6;
const SESSION_MAX = 3;

const CATEGORIES = ['identity', 'preferences', 'projects', 'relationships', 'wishes', 'notes'];
const CATEGORY_LABELS = {
  preferences: 'Preferences',
  projects: 'Active projects / goals',
  relationships: 'People in their life',
  wishes: 'Wishes / plans',
  notes: 'Notes',
};
const IDENTITY_FIELDS = ['name', 'age', 'birthday', 'city', 'job', 'language', 'school', 'nationality'];

let trimNotifier = null;
const setTrimNotifier = (fn) => {
  trimNotifier = fn;
};

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function emptyMemory() {
  return Object.fromEntries(CATEGORIES.map((c) => [c, {}]));
}

function loadMemory() {
  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const c of CATEGORIES) if (!data[c] || typeof data[c] !== 'object') data[c] = {};
      return data;
    }
  } catch {
    /* missing or corrupt — start empty */
  }
  return emptyMemory();
}

function writeRaw(memory) {
  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  const tmp = `${MEMORY_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(memory, null, 2));
  fs.renameSync(tmp, MEMORY_PATH);
}

function allEntries(memory) {
  const out = [];
  for (const [cat, items] of Object.entries(memory)) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) continue;
    for (const [key, entry] of Object.entries(items)) {
      if (entry && typeof entry === 'object' && 'value' in entry) out.push([cat, key, entry]);
    }
  }
  return out;
}

function trimToLimit(memory) {
  if (JSON.stringify(memory).length <= MEMORY_MAX_CHARS) return memory;
  const entries = allEntries(memory).sort((a, b) =>
    String(a[2].updated || '0000-00-00').localeCompare(String(b[2].updated || '0000-00-00')),
  );
  const dropped = [];
  for (const [cat, key] of entries) {
    if (JSON.stringify(memory).length <= MEMORY_MAX_CHARS) break;
    delete memory[cat][key];
    dropped.push(`${cat}/${key}`);
  }
  if (dropped.length && trimNotifier) {
    try {
      trimNotifier(
        `SYS: Memory full — forgot ${dropped.length} oldest entries ` +
          `(${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '…' : ''})`,
      );
    } catch {
      /* the notice is best effort */
    }
  }
  return memory;
}

function saveMemory(memory) {
  if (!memory || typeof memory !== 'object') return;
  writeRaw(trimToLimit(memory));
}

function truncateValue(v) {
  return typeof v === 'string' && v.length > MAX_VALUE_LENGTH ? `${v.slice(0, MAX_VALUE_LENGTH).trimEnd()}…` : v;
}

function recursiveUpdate(target, updates) {
  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (value && typeof value === 'object' && !('value' in value)) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
        changed = true;
      }
      if (recursiveUpdate(target[key], value)) changed = true;
    } else {
      const newVal = truncateValue(String(value && typeof value === 'object' ? value.value : value));
      const existing = target[key];
      if (!existing || typeof existing !== 'object' || existing.value !== newVal) {
        target[key] = { value: newVal, updated: today() };
        changed = true;
      }
    }
  }
  return changed;
}

function updateMemory(update) {
  if (!update || typeof update !== 'object') return loadMemory();
  const memory = loadMemory();
  if (recursiveUpdate(memory, update)) saveMemory(memory);
  return memory;
}

const entryValue = (e) => String((e && typeof e === 'object' ? e.value : e) ?? '').trim();
const pretty = (k) => String(k).replace(/_/g, ' ').trim();
const title = (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

function formatMemoryForPrompt(memory) {
  if (!memory) return '';
  const core = [];

  const identity = memory.identity || {};
  for (const field of IDENTITY_FIELDS) {
    const val = entryValue(identity[field]);
    if (!val) continue;
    if (field === 'language') {
      core.push(
        `Has spoken to you in: ${val} (an observation about the past — ` +
          'always answer in the language of their CURRENT message)',
      );
    } else {
      core.push(`${title(field)}: ${val}`);
    }
  }
  for (const [key, entry] of Object.entries(identity)) {
    if (IDENTITY_FIELDS.includes(key)) continue;
    const val = entryValue(entry);
    if (val) core.push(`${title(pretty(key))}: ${val}`);
  }

  const rest = [];
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    for (const [key, entry] of Object.entries(memory[cat] || {})) {
      const val = entryValue(entry);
      if (!val) continue;
      const updated = (entry && typeof entry === 'object' && entry.updated) || '0000-00-00';
      rest.push([updated, cat, key, val]);
    }
  }
  rest.sort((a, b) => b[0].localeCompare(a[0]));

  let used = core.reduce((n, l) => n + l.length + 1, 0);
  const shown = {};
  const overflow = {};
  const perCat = {};
  for (const [, cat, key, val] of rest) {
    const line = `  - ${title(pretty(key))}: ${val}`;
    if ((perCat[cat] || 0) < PROMPT_MAX_PER_CATEGORY && used + line.length + 1 <= PROMPT_CORE_CHARS) {
      (shown[cat] ||= []).push(line);
      perCat[cat] = (perCat[cat] || 0) + 1;
      used += line.length + 1;
    } else {
      (overflow[cat] ||= []).push(pretty(key));
    }
  }

  // Interleaved across categories: a table of contents, not a recency list.
  const indexed = [];
  const cats = Object.keys(CATEGORY_LABELS).filter((c) => overflow[c]?.length);
  for (let i = 0; cats.length; i++) {
    for (const cat of [...cats]) {
      if (i >= overflow[cat].length) cats.splice(cats.indexOf(cat), 1);
      else indexed.push(overflow[cat][i]);
    }
  }

  for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
    if (shown[cat]?.length) core.push('', `${label}:`, ...shown[cat]);
  }
  if (!core.length && !indexed.length) return '';

  const out = ['[WHAT YOU KNOW ABOUT THIS PERSON — use naturally, never recite like a list]', ...core];
  if (indexed.length) {
    let budget = PROMPT_INDEX_CHARS;
    const names = [];
    for (const n of indexed) {
      if (budget - n.length - 2 < 0) break;
      names.push(n);
      budget -= n.length + 2;
    }
    if (names.length) {
      out.push(
        '',
        '[ALSO REMEMBERED — values not shown here. Call recall_memory ' +
          'with a keyword to read any of these before saying you do not know]',
        names.join(', ') + (indexed.length > names.length ? ` (+${indexed.length - names.length} more)` : ''),
      );
    }
  }
  return `${out.join('\n')}\n`;
}

function score(words, cat, key, value) {
  const hk = pretty(key).toLowerCase();
  const hv = value.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (!w) continue;
    if (w === hk) s += 10;
    else if (hk.includes(w)) s += 6;
    if (hv.includes(w)) s += 3;
    if (cat.includes(w)) s += 1;
  }
  return s;
}

function searchMemory(query, limit = 8) {
  const memory = loadMemory();
  const words = String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 1);
  const rows = [];
  for (const [cat, items] of Object.entries(memory)) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) continue;
    for (const [key, entry] of Object.entries(items)) {
      const val = entryValue(entry);
      if (!val) continue;
      const s = words.length ? score(words, cat, key, val) : 1;
      if (s > 0) rows.push([s, cat, key, val]);
    }
  }
  if (!rows.length) {
    return query ? `Nothing stored about '${query}'.` : 'I have not stored anything about this person yet.';
  }
  rows.sort((a, b) => b[0] - a[0] || a[2].localeCompare(b[2]));
  const lines = rows.slice(0, Math.max(1, limit)).map(([, c, k, v]) => `${c}/${pretty(k)}: ${v}`);
  const head = query ? `Stored facts matching '${query}':` : 'Everything currently stored:';
  const more =
    rows.length > lines.length ? `\n(+${rows.length - lines.length} more — search with a narrower keyword)` : '';
  return `${head}\n${lines.join('\n')}${more}`;
}

function allEntriesForUi() {
  const memory = loadMemory();
  const rows = [];
  for (const [cat, items] of Object.entries(memory)) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) continue;
    for (const [key, entry] of Object.entries(items)) {
      const val = entryValue(entry);
      if (val) rows.push({ category: cat, key, value: val, updated: (entry && entry.updated) || '' });
    }
  }
  return rows.sort((a, b) => (b.updated || '0000-00-00').localeCompare(a.updated || '0000-00-00'));
}

function forget(key, category = 'notes') {
  const memory = loadMemory();
  if (memory[category] && key in memory[category]) {
    delete memory[category][key];
    saveMemory(memory);
    return `Forgotten: ${category}/${key}`;
  }
  return `Not found: ${category}/${key}`;
}

function identityValue(k) {
  return entryValue((loadMemory().identity || {})[k]);
}

// ── Session memory ───────────────────────────────────────────────────────────
function saveSessionSummary(summary, language = '') {
  const s = String(summary || '').trim();
  if (!s) return;
  const memory = loadMemory();
  const sessions = Array.isArray(memory.sessions) ? memory.sessions : [];
  const entry = { date: today(), summary: s.slice(0, 280) };
  if (language) entry.language = language;
  sessions.push(entry);
  memory.sessions = sessions.slice(-SESSION_MAX);
  writeRaw(memory);
}

/** Return AND remove the most recent session, so a briefing never repeats it. */
function popLastSession() {
  const memory = loadMemory();
  if (!Array.isArray(memory.sessions) || !memory.sessions.length) return null;
  const entry = memory.sessions.pop();
  writeRaw(memory);
  return entry;
}

module.exports = {
  MEMORY_PATH,
  CATEGORIES,
  loadMemory,
  saveMemory,
  updateMemory,
  formatMemoryForPrompt,
  searchMemory,
  allEntriesForUi,
  forget,
  identityValue,
  saveSessionSummary,
  popLastSession,
  setTrimNotifier,
};
