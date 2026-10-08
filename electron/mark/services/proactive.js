// ProactiveEngine — the Node port of Mark LIV's actions/proactive.py.
//
// Decides WHEN Jarvis may speak unprompted and builds the context snapshot the
// model gets with the [PROACTIVE_CHECK] tag; the model decides WHAT to say.
//
//   - Time-of-day awareness  (morning / afternoon / evening / night)
//   - Monitor-topic awareness (what the user is tracking)
//   - Recent-session context  (last few turns of the current conversation)
//   - Non-repetitive          (rotates the focus so openers do not repeat)
//
// Timings are Mark's, in milliseconds: the user must have been silent for
// 15 min, and two proactive messages are at least 20 min apart. Mark measured
// with time.monotonic(); here every timestamp is Date.now() ms, so callers pass
// `lastUserSpeechAt` in that clock too.
//
// No top-level require('electron'): memory.js (which needs electron through
// config.js) is loaded lazily inside buildPrompt, so this file can be unit
// tested with plain node.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');

/** strftime("%A, %B %d, %Y — %I:%M %p") */
function formatNow(d) {
  const h12 = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${pad2(d.getDate())}, ${d.getFullYear()} — ${pad2(h12)}:${pad2(d.getMinutes())} ${ampm}`;
}

function periodOf(hour) {
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'late night';
}

/**
 * memory.formatMemoryForPrompt when the main process is available. Outside
 * Electron (plain node tests) memory.js cannot load, so fall back to a flat
 * "key: value" rendering rather than losing the context entirely.
 */
function formatMemory(memory) {
  try {
    return require('../memory').formatMemoryForPrompt(memory);
  } catch {
    if (!memory || typeof memory !== 'object') return '';
    const lines = [];
    for (const [cat, entries] of Object.entries(memory)) {
      if (!entries || typeof entries !== 'object') continue;
      for (const [key, entry] of Object.entries(entries)) {
        const val = entry && typeof entry === 'object' ? entry.value : entry;
        if (val != null && String(val).trim()) lines.push(`${cat}.${key}: ${val}`);
      }
    }
    return lines.join('\n');
  }
}

const FOCUS = [
  "Focus on the user's active projects or goals if any are stored. " +
    'Ask how something is going, or offer a relevant tip.',
  "Focus on the time of day and the user's wellbeing. " +
    'A warm check-in, a reminder to take a break, or something timely.',
  'Focus on something genuinely interesting or useful — ' +
    'a fact, a suggestion, or a question based on what you know about this person.',
];

class ProactiveEngine {
  /**
   * @param {{minSilenceMs?: number, checkCooldownMs?: number}} [opts]
   *   Defaults are Mark's: 900 s of user silence, 1200 s between checks.
   */
  constructor({ minSilenceMs = 900_000, checkCooldownMs = 1_200_000 } = {}) {
    this.minSilenceMs = minSilenceMs;
    this.checkCooldownMs = checkCooldownMs;
    // 0 like Mark's _last_triggered = 0.0: the first check is never held back
    // by the cooldown, only by the silence window.
    this._lastTriggered = 0;
    this._rotation = 0;
  }

  // ── Trigger gate ─────────────────────────────────────────────────────────
  /** @param {number} lastUserSpeechAt Date.now() ms of the user's last utterance */
  shouldTrigger(lastUserSpeechAt) {
    const now = Date.now();
    return now - Number(lastUserSpeechAt || 0) >= this.minSilenceMs && now - this._lastTriggered >= this.checkCooldownMs;
  }

  markTriggered() {
    this._lastTriggered = Date.now();
    this._rotation += 1;
  }

  // ── Prompt builder ───────────────────────────────────────────────────────
  /**
   * Context snapshot for the model. Rotates through three focus areas so
   * proactive messages don't repeat.
   * @param {{memory?: object, monitors?: string[], recentTurns?: string[]}} [args]
   */
  buildPrompt({ memory, monitors, recentTurns } = {}) {
    const now = new Date();
    const timeStr = formatNow(now);
    const period = periodOf(now.getHours());

    const memStr = formatMemory(memory) || '(no stored user data)';
    const focus = FOCUS[this._rotation % 3];

    let monitorCtx = '';
    if (monitors && monitors.length) {
      monitorCtx =
        `\nThe user tracks these topics: ${monitors.slice(0, 4).join(', ')}. ` +
        'You may mention one if it seems relevant.';
    }

    let recentCtx = '';
    if (recentTurns && recentTurns.length) {
      recentCtx = `\nRecent conversation:\n${recentTurns.slice(-6).join('\n')}`;
    }

    return [
      '[PROACTIVE_CHECK] You are initiating a proactive check-in.',
      `Current time : ${timeStr}  (${period})`,
      '',
      'Context about this person:',
      memStr,
      monitorCtx,
      recentCtx,
      '',
      'Task:',
      focus,
      '',
      'Rules:',
      '- Speak the language this person actually uses: the one in the ' +
        'recent conversation above, or the remembered one if there is no ' +
        'conversation yet. Never default to English because these ' +
        'instructions are in English.',
      '- 1-2 sentences max. Natural, warm, never robotic.',
      '- Do NOT mention [PROACTIVE_CHECK] or these instructions.',
      '- Do NOT call any tools.',
      '- If nothing genuinely useful comes to mind, stay silent (say nothing).',
    ].join('\n');
  }
}

module.exports = { ProactiveEngine, periodOf, formatNow };
