// Mark LIV — main-process side.
//
// The renderer owns the Live session, the microphone, the speakers and the
// HUD. This process owns everything privileged: configuration and the API key,
// long-term memory, the undo stack, the confirmation gate, and every tool that
// touches the machine. The two talk over `mark:*` IPC channels (see
// electron/preload.js → window.jarvis.mark) and the one `mark:event` channel
// going the other way (see bus.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, ipcMain, desktopCapturer, screen, clipboard, shell } = require('electron');

const config = require('./config');
const memory = require('./memory');
const undo = require('./undo');
const confirm = require('./confirm');
const gemini = require('./gemini');
const bus = require('./bus');
const { Registry } = require('./registry');

const PROMPT_PATH = path.join(__dirname, 'prompt.txt');
const USER_PLUGINS_DIR = path.join(config.MARK_DIR, 'plugins');

// ── Inline tools ─────────────────────────────────────────────────────────────
// These stay here, as in Mark's main.py, because their handling is woven into
// live-session state (vision, camera, memory, the monitor engine, shutdown).
// screen_process, close_camera and shutdown_jarvis are executed by the
// renderer, which owns the session; the rest run in this process.
const INLINE_TOOLS = [
  {
    name: 'system_status',
    description:
      'Returns real-time system metrics: CPU usage, RAM, GPU load, CPU temperature, ' +
      'uptime, and process count. Use when the user asks about computer performance, ' +
      'temperature, memory, or resource usage.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'screen_process',
    description:
      'Captures the screen or webcam image and lets you analyze it. ' +
      'MUST be called when user asks what is on screen, what you see, ' +
      'look at camera, analyze my screen, etc. ' +
      'You have NO visual ability without this tool. ' +
      "After the image is captured it is sent directly to you — describe what you see and answer the user's question. " +
      'When using camera: the live view stays open until user says close it or calls close_camera.',
    parameters: {
      type: 'OBJECT',
      properties: {
        angle: { type: 'STRING', description: "'screen' to capture display, 'camera' for webcam. Default: 'screen'" },
        text: { type: 'STRING', description: "The question or instruction about the captured image" },
      },
      required: ['text'],
    },
  },
  {
    name: 'close_camera',
    description:
      'Closes the live camera view shown on screen. ' +
      'Call when the user says (in ANY language): close camera, stop camera, ' +
      "turn off camera, that's creepy, etc.",
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'manage_monitor',
    description:
      'Add, remove, or list background monitoring topics. ' +
      'JARVIS checks these topics once a day and alerts the user when there is a new development. ' +
      "Use 'add' when the user says 'monitor X', 'track X', 'follow X'. " +
      "Use 'remove' when the user says 'stop monitoring X'. " +
      "Use 'list' when the user asks what is being monitored. " +
      'Do NOT add crypto, financial, or trading topics.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'add | remove | list' },
        topic: {
          type: 'STRING',
          description: "Topic to monitor or stop monitoring (e.g. 'space exploration', 'AI news')",
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'shutdown_jarvis',
    description:
      'Shuts down the assistant completely. ' +
      'Call this when the user expresses intent to end the conversation, ' +
      'close the assistant, say goodbye, or stop Jarvis. ' +
      'The user can say this in ANY language.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'save_memory',
    description:
      'Save an important personal fact about the user to long-term memory. ' +
      'Call this silently whenever the user reveals something worth remembering: ' +
      'name, age, city, job, preferences, hobbies, relationships, projects, or future plans. ' +
      'Do NOT call for: weather, reminders, searches, or one-time commands. ' +
      'Do NOT announce that you are saving — just call it silently. ' +
      'Values must be in English regardless of the conversation language.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: {
          type: 'STRING',
          description:
            'identity — name, age, birthday, city, job, language, nationality | ' +
            'preferences — favorite food/color/music/film/game/sport, hobbies | ' +
            'projects — active projects, goals, things being built | ' +
            'relationships — friends, family, partner, colleagues | ' +
            'wishes — future plans, things to buy, travel dreams | ' +
            'notes — habits, schedule, anything else worth remembering',
        },
        key: { type: 'STRING', description: 'Short snake_case key (e.g. name, favorite_food, sister_name)' },
        value: { type: 'STRING', description: 'Concise value in English (e.g. Fatih, pizza, older sister)' },
      },
      required: ['category', 'key', 'value'],
    },
  },
  {
    name: 'recall_memory',
    description:
      'Look up a fact you have stored about the user but which is NOT in ' +
      'the memory block of your system prompt. ' +
      'The prompt lists the keys it did not have room for under ' +
      "'[ALSO REMEMBERED]' — if the user asks about anything named there, " +
      'call this FIRST. ' +
      'Also call it before saying you do not know something personal, and ' +
      'when the user asks what you remember about them (leave query empty ' +
      'for everything). ' +
      'This is a local file search: it is instant and costs nothing.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description:
            'Keyword to search for — a name, a topic, a category ' +
            "(e.g. 'ayse', 'coffee', 'projects'). " +
            'Leave empty to list everything stored.',
        },
      },
      required: [],
    },
  },
  {
    name: 'undo',
    description:
      'Reverse the last change YOU made to this computer — a file you ' +
      'moved, renamed, created or wrote, or a setting you changed such as ' +
      'volume, brightness, dark mode or WiFi. ' +
      'Call this whenever the user says undo, revert, take it back, put it ' +
      'back, cancel that, or tells you that you did the wrong thing, in ANY ' +
      'language. ' +
      "Use action='list' when they ask what can be undone. " +
      'This only covers your own actions — it is not the Ctrl+Z of whatever ' +
      "application is on screen (that is computer_settings with action 'undo').",
    parameters: {
      type: 'OBJECT',
      properties: {
        action: {
          type: 'STRING',
          description: 'undo (default) — reverse the last change | list — show what can be undone',
        },
      },
      required: [],
    },
  },
];
const INLINE_NAMES = new Set(INLINE_TOOLS.map((t) => t.name));
// Executed by the renderer, which owns the session.
const RENDERER_TOOLS = new Set(['screen_process', 'close_camera', 'shutdown_jarvis']);

// ── Optional services ────────────────────────────────────────────────────────
// Each lives in its own file. Loaded lazily and defensively so one broken
// service costs its own feature and nothing else.
function service(name) {
  try {
    return require(`./services/${name}`);
  } catch (e) {
    console.warn(`[Mark] service '${name}' unavailable: ${e?.message || e}`);
    return null;
  }
}

let registry = null;
let sysMonitor = null;
let proactive = null;
let currentFile = null;

const log = (text) => bus.emit('log', { text });

/** What every action receives as its second argument. */
function makeCtx() {
  return {
    gemini,
    undo: { push: undo.push },
    confirm: { request: confirm.request, pendingTitle: confirm.pendingTitle },
    config,
    memory,
    bus,
    os: config.snapshot().os,
    paths: {
      markDir: config.MARK_DIR,
      userData: app.getPath('userData'),
      home: os.homedir(),
      desktop: app.getPath('desktop'),
      documents: app.getPath('documents'),
      downloads: app.getPath('downloads'),
      temp: app.getPath('temp'),
    },
    currentFile,
    ui: {
      log,
      showContent: (title, text) => bus.emit('content', { title: String(title || ''), text: String(text || '') }),
      showQuiz: (topic, questions) => bus.emit('quiz', { topic, questions }),
      hideQuiz: () => bus.emit('quiz-hide'),
      showReview: (title, summary, findings, unclear) => bus.emit('review', { title, summary, findings, unclear }),
      glance: (dx, dy, hold = 1.1) => bus.emit('glance', { dx, dy, hold }),
    },
    /** Ask the assistant to say something mid-task (Mark's plugin_say). */
    speak: (text) => bus.emit('say', { text: String(text || '') }),
  };
}

function loadRegistry() {
  registry = new Registry({
    actionDirs: [path.join(__dirname, 'actions')],
    pluginDirs: [path.join(__dirname, 'plugins'), USER_PLUGINS_DIR],
    reserved: INLINE_NAMES,
    logger: (m) => console.log(`[Mark] ${m}`),
    notify: (m) => log(`SYS: ${m}`),
  });
}

// ── Self-knowledge ───────────────────────────────────────────────────────────
function describeTools(decls) {
  return decls
    .map((d) => {
      const desc = String(d.description || '').split(/\s+/).join(' ');
      return desc ? `- ${d.name}: ${desc.slice(0, 150)}` : `- ${d.name}`;
    })
    .join('\n');
}

function describeLimits(hasVision, hasMic) {
  const out = [
    '- Anything not listed above is outside your reach. Say so in one clause ' +
      'and offer the nearest thing you can actually do — never mime an action ' +
      'you cannot take, and never report a result you did not get.',
    "- You act on this machine only. You cannot reach the user's other " +
      'devices, accounts or hardware except through the tools listed above.',
    '- You remember what is in the memory block and what has been said this ' +
      'session. Anything else you were told before is gone unless it was saved.',
  ];
  out.push(
    hasVision
      ? '- Your sight is not continuous. You see nothing until you call a ' +
          'vision tool, and then only that single frame at that moment — you ' +
          'cannot watch, monitor or notice something changing on screen.'
      : '- You have no sight at all in this build.',
  );
  if (hasMic) {
    out.push('- You hear nothing while the microphone is muted, and you cannot unmute it yourself.');
  }
  return out.join('\n');
}

function renderPrompt(template, values) {
  let out = template || '';
  for (const [k, v] of Object.entries(values)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

function loadSystemPrompt() {
  try {
    return fs.readFileSync(PROMPT_PATH, 'utf-8');
  } catch {
    return (
      "You are JARVIS, Tony Stark's AI assistant. " +
      'Be concise, direct, and always use the provided tools to complete tasks. ' +
      'Never simulate or guess results — always call the appropriate tool.'
    );
  }
}

function platformLabel() {
  const name = { win32: 'Windows', darwin: 'Darwin', linux: 'Linux' }[process.platform] || process.platform;
  return `${name} ${os.release()}`.trim();
}

/** Everything the renderer needs to open a Live session. */
function sessionSetup() {
  const asstName = config.getAssistantName();
  const userName = config.getUserName();
  const now = new Date();
  const timeStr = now.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  const timeCtx = `[CURRENT DATE & TIME]\nRight now it is: ${timeStr}\nUse this to calculate exact times for reminders.\n\n`;
  const addr = userName
    ? `ADDRESS: Always call the user '${userName}'.`
    : 'ADDRESS: Address the user with the ordinary respectful form ' +
      'for a superior in the language you are currently speaking — ' +
      '"sir" in English, its everyday equivalent in any other ' +
      'language. Never an archaic or aristocratic form, and never ' +
      'the form from a different language than the one you are ' +
      'speaking in this sentence.';
  const identityCtx = `[IDENTITY]\nYour name is ${asstName}. Always refer to yourself as ${asstName}.\n${addr}\n\n`;

  const decls = [...INLINE_TOOLS, ...registry.declarations()];
  const names = new Set(decls.map((d) => d.name));
  const sysPrompt = renderPrompt(loadSystemPrompt(), {
    assistant_name: asstName,
    platform: platformLabel(),
    capabilities: describeTools(decls),
    limits: describeLimits(names.has('screen_process'), true),
  });

  const parts = [timeCtx, identityCtx];
  const mem = memory.formatMemoryForPrompt(memory.loadMemory());
  if (mem) parts.push(mem);
  parts.push(sysPrompt);

  const snap = config.snapshot();
  return {
    apiKey: config.getGeminiKey(),
    model: gemini.LIVE_MODEL,
    assistantName: asstName,
    systemInstruction: parts.join('\n'),
    tools: decls,
    voice: snap.voice_name,
    proactiveAudio: snap.proactive_audio,
    thinking: snap.thinking_enabled,
    mediaResolution: snap.media_resolution,
    turnTuning: snap.turn_tuning,
  };
}

// ── Tool execution ───────────────────────────────────────────────────────────
async function runInline(name, args) {
  switch (name) {
    case 'save_memory': {
      const { category = 'notes', key = '', value = '' } = args;
      if (key && value) memory.updateMemory({ [category]: { [key]: { value } } });
      return { result: 'ok', silent: true };
    }
    case 'recall_memory':
      return memory.searchMemory(args.query || '', 8);
    case 'undo': {
      if (String(args.action || '').toLowerCase().trim() === 'list') {
        const items = undo.history();
        return items.length
          ? `Things I can undo, most recent first:\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
          : 'I have not changed anything I can undo yet.';
      }
      return undo.undoLast();
    }
    case 'system_status': {
      const sm = service('system_monitor');
      return sm ? String(await sm.getSystemStatus()) : 'System monitoring is unavailable.';
    }
    case 'manage_monitor': {
      const bm = service('background_monitor');
      if (!bm) return 'Background monitoring is unavailable.';
      const action = String(args.action || '').toLowerCase().trim();
      const topic = String(args.topic || '').trim();
      if (action === 'add' && topic) return bm.addMonitor(topic);
      if (action === 'remove' && topic) return bm.removeMonitor(topic);
      if (action === 'list') {
        const topics = await bm.listMonitors();
        return topics.length ? `Monitoring: ${topics.join(', ')}` : 'No topics are being monitored.';
      }
      return 'Specify action (add/remove/list) and a topic.';
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

async function runTool(name, args, extra = {}) {
  if (extra && 'currentFile' in extra) currentFile = extra.currentFile || null;
  args = args && typeof args === 'object' ? { ...args } : {};
  console.log(`[Mark] 🔧 ${name} ${JSON.stringify(args).slice(0, 200)}`);
  let result;
  try {
    if (RENDERER_TOOLS.has(name)) result = `Tool '${name}' must be executed by the interface.`;
    else if (INLINE_NAMES.has(name)) result = await runInline(name, args);
    else if (registry.has(name)) {
      // file_processor falls back to the file dropped on the HUD.
      if (name === 'file_processor' && !args.file_path && currentFile) args.file_path = currentFile;
      result = await registry.run(name, args, makeCtx());
    } else result = `Unknown tool: ${name}`;
  } catch (e) {
    result = `Tool '${name}' failed: ${e?.message || e}`;
    log(`ERR: ${name} — ${String(e?.message || e).slice(0, 120)}`);
  }
  console.log(`[Mark] 📤 ${name} → ${String(typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 100)}`);
  return { result, scheduling: registry.scheduling(name) };
}

// ── Vision ───────────────────────────────────────────────────────────────────
const IMG_MAX_W = 1280;
const IMG_MAX_H = 720;

async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = Math.min(IMG_MAX_W / width, IMG_MAX_H / height, 1);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src) throw new Error('no screen could be captured');
  const jpeg = src.thumbnail.toJPEG(82);
  return { data: jpeg.toString('base64'), mimeType: 'image/jpeg', bytes: jpeg.length };
}

// ── Session summary ──────────────────────────────────────────────────────────
async function saveSessionSummary(logLines) {
  if (!Array.isArray(logLines) || logLines.length < 3) return false;
  const lang = memory.identityValue('language') || 'English';
  const convo = logLines.slice(-40).join('\n');
  const prompt =
    `Summarize this conversation in 1-2 sentences in ${lang}. ` +
    'Focus on what the user accomplished or discussed. ' +
    `Output ONLY the summary text, nothing else:\n\n${convo}`;
  const summary = await gemini.text(prompt, { tier: gemini.SMART, timeoutMs: 30_000 });
  if (summary) memory.saveSessionSummary(summary, lang);
  return Boolean(summary);
}

// ── Clipboard intelligence ───────────────────────────────────────────────────
let clipTimer = null;
let lastClip = '';
function watchClipboard(on) {
  clearInterval(clipTimer);
  clipTimer = null;
  if (!on) return;
  lastClip = clipboard.readText();
  clipTimer = setInterval(() => {
    const t = clipboard.readText();
    if (t && t !== lastClip) {
      lastClip = t;
      bus.emit('clipboard', { text: t });
    }
  }, 800);
}

// ── Auto-start on boot ───────────────────────────────────────────────────────
function autostartGet() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}
function autostartSet(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
  } catch (e) {
    log(`ERR: Auto-start — ${e?.message || e}`);
  }
  return autostartGet();
}

// ── Desktop shortcut ─────────────────────────────────────────────────────────
function createDesktopShortcut() {
  if (process.platform !== 'win32') return { ok: false, message: 'Desktop shortcuts are created on Windows only.' };
  const lnk = path.join(app.getPath('desktop'), `${config.getAssistantName()}.lnk`);
  const ok = shell.writeShortcutLink(lnk, 'create', {
    target: process.execPath,
    args: app.isPackaged ? '' : `"${path.join(__dirname, '..', '..')}"`,
    description: `${config.getAssistantName()} — personal assistant`,
    icon: process.execPath,
    iconIndex: 0,
  });
  return { ok, message: ok ? `Shortcut created: ${lnk}` : 'Could not create the shortcut.' };
}

// ── IPC ──────────────────────────────────────────────────────────────────────
function registerMarkHandlers({ getWindow, showWindow, quit }) {
  bus.bind(getWindow);
  confirm.bind({
    show: (title, detail) => bus.emit('confirm-show', { title, detail }),
    hide: () => bus.emit('confirm-hide'),
    log,
  });
  memory.setTrimNotifier(log);
  loadRegistry();

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        console.error(`[Mark] ${channel}:`, e);
        throw e;
      }
    });

  handle('mark:config-get', () => config.snapshot());
  handle('mark:config-set', (fields) => config.setFromRenderer(fields));
  handle('mark:api-key-save', (key) => {
    config.saveApiKey(key);
    return config.isConfigured();
  });
  handle('mark:session-setup', () => sessionSetup());
  handle('mark:tool-run', (name, args, extra) => runTool(name, args, extra));
  handle('mark:capture-screen', () => captureScreen());

  handle('mark:memory-list', () => memory.allEntriesForUi());
  handle('mark:memory-forget', (category, key) => memory.forget(key, category));
  handle('mark:memory-identity', () => ({
    language: memory.identityValue('language'),
    name: memory.identityValue('name'),
  }));
  handle('mark:pop-last-session', () => memory.popLastSession());
  handle('mark:session-summary', (lines) => saveSessionSummary(lines));

  handle('mark:undo-history', () => undo.history());
  handle('mark:confirm-resolve', (accepted) => confirm.resolve(Boolean(accepted)));

  handle('mark:plugins-list', () => registry.listPluginsForUi());
  handle('mark:plugin-toggle', (name, enabled) => {
    config.savePluginEnabled(name, enabled);
    return registry.listPluginsForUi();
  });
  handle('mark:plugin-settings', () => registry.settingsSchemas());
  handle('mark:plugin-settings-save', (ns, values) => config.savePluginConfig(ns, values));
  handle('mark:plugin-settings-action', (ns, values) => registry.runSettingsAction(ns, values));
  handle('mark:open-plugins-folder', () => {
    fs.mkdirSync(USER_PLUGINS_DIR, { recursive: true });
    return shell.openPath(USER_PLUGINS_DIR);
  });

  // Background engines. The renderer runs the timers because it knows whether
  // the assistant is awake, speaking or mid-conversation; these do the work.
  handle('mark:news', async (query) => {
    const ws = (() => {
      try {
        return require('./actions/web_search');
      } catch {
        return null;
      }
    })();
    if (!ws || typeof ws.news !== 'function') return 'Search failed: news is unavailable.';
    return ws.news(query || 'top world news today');
  });
  handle('mark:metrics', async () => {
    const sm = service('system_monitor');
    return sm && sm.metrics ? sm.metrics() : null;
  });
  handle('mark:sysmon-check', async () => {
    const sm = service('system_monitor');
    if (!sm) return null;
    sysMonitor ||= new sm.SystemMonitor();
    return sysMonitor.check();
  });
  handle('mark:bg-check', async () => {
    const bm = service('background_monitor');
    return bm ? bm.checkAll() : [];
  });
  handle('mark:proactive', async ({ lastUserSpeechAt, recentTurns }) => {
    const pe = service('proactive');
    if (!pe) return null;
    proactive ||= new pe.ProactiveEngine();
    if (!proactive.shouldTrigger(lastUserSpeechAt)) return null;
    proactive.markTriggered();
    const bm = service('background_monitor');
    const monitors = bm ? await bm.listMonitors() : [];
    return proactive.buildPrompt({
      memory: memory.loadMemory(),
      monitors: monitors.length ? monitors : null,
      recentTurns: recentTurns && recentTurns.length ? recentTurns : null,
    });
  });

  handle('mark:clipboard-watch', (on) => watchClipboard(Boolean(on)));
  handle('mark:clipboard-write', (text) => clipboard.writeText(String(text || '')));
  handle('mark:autostart-get', () => autostartGet());
  handle('mark:autostart-set', (enabled) => autostartSet(enabled));
  handle('mark:desktop-shortcut', () => createDesktopShortcut());
  handle('mark:set-current-file', (file) => {
    currentFile = file || null;
    return currentFile;
  });
  handle('mark:shutdown', () => {
    undo.clear();
    setTimeout(() => quit(), 200);
    return true;
  });

  // Push-to-talk and the phone dashboard live in their own files.
  try {
    require('./ptt').register({ handle, bus });
  } catch (e) {
    console.warn(`[Mark] push-to-talk unavailable: ${e?.message || e}`);
  }
  try {
    require('./dashboard').register({ handle, bus, log, showWindow });
  } catch (e) {
    console.warn(`[Mark] remote dashboard unavailable: ${e?.message || e}`);
  }
}

function shutdownMark() {
  watchClipboard(false);
  service('system_monitor')?.stop?.();
  try {
    require('./ptt').stop();
  } catch {
    /* not loaded */
  }
  try {
    require('./dashboard').stop();
  } catch {
    /* not loaded */
  }
}

module.exports = { registerMarkHandlers, shutdownMark, INLINE_TOOLS, runTool, captureScreen };
