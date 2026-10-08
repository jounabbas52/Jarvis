const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { registerPilotHandlers, shutdownPilot } = require('./pilot');
const { registerMarkHandlers, shutdownMark } = require('./mark');

const isDev = process.env.NODE_ENV === 'development';
const MEMORY_PATH = path.join(app.getPath('userData'), 'memory.json');

// ---------------------------------------------------------------------------
// Memory persistence
// ---------------------------------------------------------------------------
const DEFAULT_MEMORY = {
  last_command: '',
  last_app: '',
  custom_commands: {},
  contacts: {},
  last_path: '',
  logs: [],
};

function ensureMemoryFile() {
  try {
    if (!fs.existsSync(MEMORY_PATH)) {
      fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
      fs.writeFileSync(MEMORY_PATH, JSON.stringify(DEFAULT_MEMORY, null, 2));
    }
  } catch (err) {
    console.error('Failed to create memory file:', err);
  }
}

function readMemory() {
  ensureMemoryFile();
  try {
    const raw = fs.readFileSync(MEMORY_PATH, 'utf-8');
    return { ...DEFAULT_MEMORY, ...JSON.parse(raw) };
  } catch (err) {
    console.error('Failed to read memory:', err);
    return { ...DEFAULT_MEMORY };
  }
}

function writeMemory(data) {
  try {
    // Write to a temp file then rename, so a crash mid-write cannot leave
    // memory.json truncated and unparseable.
    const tmp = `${MEMORY_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, MEMORY_PATH);
    return true;
  } catch (err) {
    console.error('Failed to write memory:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Safe process launching
// ---------------------------------------------------------------------------
// Everything below uses spawn/execFile with an ARGUMENT ARRAY and never a
// shell string. User-supplied text (app names, profiles, messages) therefore
// cannot inject extra commands - "open a & calc" launches an app literally
// named "a & calc" and fails, instead of also running calc.

/** Spawn a detached process and resolve once it has started (or failed). */
function launch(file, args = []) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let child;
    try {
      child = spawn(file, args, { detached: true, stdio: 'ignore', shell: false });
    } catch (err) {
      done({ success: false, message: err.message });
      return;
    }

    child.on('error', (err) => done({ success: false, message: err.message }));
    child.on('spawn', () => {
      child.unref();
      done({ success: true, message: 'started' });
    });

    // A process that neither errors nor reports spawn within this window is
    // treated as started - some Windows shims exit immediately by design.
    setTimeout(() => done({ success: true, message: 'started' }), 1500);
  });
}

/** Windows: resolve a start-menu / PATH target without invoking cmd.exe. */
function startViaShell(target, args = []) {
  // `cmd /c start` is the only reliable way to resolve registered app names
  // and URI schemes on Windows. Args are passed as an array, so nothing is
  // re-parsed by a shell and the user's text stays a single literal token.
  return launch(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', target, ...args]);
}

/** Known browser executables, checked in order. */
const BROWSER_PATHS = {
  win32: {
    chrome: [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
    edge: [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
    firefox: [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Mozilla Firefox\\firefox.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Mozilla Firefox\\firefox.exe'),
    ],
  },
  darwin: {
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    firefox: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
  },
  linux: {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    edge: ['/usr/bin/microsoft-edge'],
    firefox: ['/usr/bin/firefox'],
  },
};

/** First existing path for a browser key, or null. */
function resolveBrowser(key) {
  const table = BROWSER_PATHS[process.platform] || BROWSER_PATHS.linux;
  for (const candidate of table[key] || []) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable path - keep looking */
    }
  }
  return null;
}

/** Flag each browser family uses to pick a named profile. */
const PROFILE_FLAGS = {
  chrome: '--profile-directory',
  edge: '--profile-directory',
  firefox: '-P',
};

/**
 * Launch a browser, optionally with a named profile and a starting URL.
 * Chrome's --profile-directory takes the on-disk folder name ("Profile 1"),
 * but users say the display name ("saeed"), so we translate via Local State.
 */
async function openBrowser(browserKey, { profile, url } = {}) {
  const exe = resolveBrowser(browserKey);
  const args = [];

  if (profile) {
    const resolved = resolveChromeProfileDir(browserKey, profile);
    const flag = PROFILE_FLAGS[browserKey];
    if (flag === '-P') {
      args.push('-P', resolved);
    } else if (flag) {
      args.push(`${flag}=${resolved}`);
    }
  }
  if (url) args.push(url);

  if (exe) {
    const result = await launch(exe, args);
    if (result.success) {
      return {
        success: true,
        message: profile
          ? `Opened ${browserKey} with profile "${profile}".`
          : `Opened ${browserKey}.`,
      };
    }
    return { success: false, message: `Failed to open ${browserKey}: ${result.message}` };
  }

  // No known install path - fall back to the registered app name. A profile
  // flag cannot be honoured this way, so say so rather than silently ignore.
  const fallback = await startViaShell(browserKey, url ? [url] : []);
  if (!fallback.success) {
    return { success: false, message: `I couldn't find ${browserKey} on this system.` };
  }
  return {
    success: true,
    message: profile
      ? `Opened ${browserKey}, but I couldn't apply the "${profile}" profile (install path not found).`
      : `Opened ${browserKey}.`,
  };
}

/**
 * Map a human profile name to Chrome's directory name.
 * Chrome stores display names in Local State under profile.info_cache.
 */
function resolveChromeProfileDir(browserKey, wanted) {
  if (browserKey === 'firefox') return wanted;
  const localState = chromeLocalStatePath(browserKey);
  if (!localState) return wanted;
  try {
    const raw = JSON.parse(fs.readFileSync(localState, 'utf-8'));
    const cache = raw?.profile?.info_cache || {};
    const target = String(wanted).trim().toLowerCase();
    for (const [dir, info] of Object.entries(cache)) {
      const name = String(info?.name ?? '').trim().toLowerCase();
      const user = String(info?.user_name ?? '').trim().toLowerCase();
      if (name === target || user === target || dir.toLowerCase() === target) return dir;
    }
    // Partial match, so "saeed" finds "Saeed (Work)".
    for (const [dir, info] of Object.entries(cache)) {
      if (String(info?.name ?? '').toLowerCase().includes(target)) return dir;
    }
  } catch {
    /* no Local State readable - fall through to the literal name */
  }
  return wanted;
}

function chromeLocalStatePath(browserKey) {
  const home = os.homedir();
  const local = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
  if (process.platform === 'win32') {
    return browserKey === 'edge'
      ? path.join(local, 'Microsoft\\Edge\\User Data\\Local State')
      : path.join(local, 'Google\\Chrome\\User Data\\Local State');
  }
  if (process.platform === 'darwin') {
    return browserKey === 'edge'
      ? path.join(home, 'Library/Application Support/Microsoft Edge/Local State')
      : path.join(home, 'Library/Application Support/Google/Chrome/Local State');
  }
  return browserKey === 'edge'
    ? path.join(home, '.config/microsoft-edge/Local State')
    : path.join(home, '.config/google-chrome/Local State');
}

/** List the browser profiles Jarvis can see, for the Settings view. */
function listProfiles(browserKey = 'chrome') {
  const localState = chromeLocalStatePath(browserKey);
  try {
    const raw = JSON.parse(fs.readFileSync(localState, 'utf-8'));
    const cache = raw?.profile?.info_cache || {};
    return Object.entries(cache).map(([dir, info]) => ({
      dir,
      name: info?.name || dir,
      email: info?.user_name || '',
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Curated app launch table (file + args, never a shell string)
// ---------------------------------------------------------------------------
const APP_TARGETS = {
  win32: {
    notepad: { file: 'notepad.exe' },
    calculator: { file: 'calc.exe' },
    explorer: { file: 'explorer.exe' },
    taskmanager: { file: 'taskmgr.exe' },
    controlpanel: { file: 'control.exe' },
    paint: { file: 'mspaint.exe' },
    cmd: { shellTarget: 'cmd.exe' },
    powershell: { shellTarget: 'powershell.exe' },
    terminal: { shellTarget: 'wt.exe' },
    vscode: { shellTarget: 'code' },
    settingsapp: { shellTarget: 'ms-settings:' },
    word: { shellTarget: 'winword' },
    excel: { shellTarget: 'excel' },
    powerpoint: { shellTarget: 'powerpnt' },
    outlook: { shellTarget: 'outlook' },
    onenote: { shellTarget: 'onenote' },
    spotify: { shellTarget: 'spotify:' },
    discord: { shellTarget: 'discord:' },
    slack: { shellTarget: 'slack:' },
    zoom: { shellTarget: 'zoommtg:' },
    teams: { shellTarget: 'msteams:' },
    skype: { shellTarget: 'skype:' },
    whatsapp: { shellTarget: 'whatsapp:' },
    telegram: { shellTarget: 'tg:' },
    steam: { shellTarget: 'steam:' },
    epicgames: { shellTarget: 'com.epicgames.launcher:' },
    vlc: { shellTarget: 'vlc' },
    obs: { shellTarget: 'obs64' },
    photoshop: { shellTarget: 'photoshop' },
    illustrator: { shellTarget: 'illustrator' },
    notion: { shellTarget: 'notion:' },
    figma: { shellTarget: 'figma:' },
    postman: { shellTarget: 'postman' },
    docker: { shellTarget: 'Docker Desktop' },
    adobereader: { shellTarget: 'acrord32' },
    itunes: { shellTarget: 'itunes' },
    xboxapp: { shellTarget: 'xbox:' },
    camera: { shellTarget: 'microsoft.windows.camera:' },
  },
  darwin: {
    notepad: { file: 'open', args: ['-a', 'TextEdit'] },
    calculator: { file: 'open', args: ['-a', 'Calculator'] },
    explorer: { file: 'open', args: ['.'] },
    taskmanager: { file: 'open', args: ['-a', 'Activity Monitor'] },
    controlpanel: { file: 'open', args: ['-a', 'System Settings'] },
    settingsapp: { file: 'open', args: ['-a', 'System Settings'] },
    paint: { file: 'open', args: ['-a', 'Preview'] },
    cmd: { file: 'open', args: ['-a', 'Terminal'] },
    powershell: { file: 'open', args: ['-a', 'Terminal'] },
    terminal: { file: 'open', args: ['-a', 'Terminal'] },
    vscode: { file: 'open', args: ['-a', 'Visual Studio Code'] },
  },
  linux: {
    notepad: { file: 'gedit' },
    calculator: { file: 'gnome-calculator' },
    explorer: { file: 'xdg-open', args: ['.'] },
    taskmanager: { file: 'gnome-system-monitor' },
    controlpanel: { file: 'gnome-control-center' },
    settingsapp: { file: 'gnome-control-center' },
    paint: { file: 'gimp' },
    cmd: { file: 'x-terminal-emulator' },
    powershell: { file: 'pwsh' },
    terminal: { file: 'x-terminal-emulator' },
    vscode: { file: 'code' },
  },
};

/** macOS/Linux generic: try `open -a "Name"` / the lowercased binary name. */
function genericTarget(name) {
  if (process.platform === 'darwin') return { file: 'open', args: ['-a', name] };
  if (process.platform === 'linux') return { file: name.toLowerCase().replace(/\s+/g, '-') };
  return { shellTarget: name };
}

async function openApp(appKey, options = {}) {
  const key = String(appKey || '').trim();
  if (!key) return { success: false, message: 'No application given.' };

  // Browsers take the profile/url path.
  if (['chrome', 'edge', 'firefox'].includes(key.toLowerCase())) {
    return openBrowser(key.toLowerCase(), options);
  }

  const table = APP_TARGETS[process.platform] || APP_TARGETS.linux;
  const target = table[key.toLowerCase()] || genericTarget(key);

  const result = target.shellTarget
    ? await startViaShell(target.shellTarget, target.args || [])
    : await launch(target.file, target.args || []);

  if (result.success) return { success: true, message: `Opened ${key}.` };
  return {
    success: false,
    message: `I couldn't find "${key}" on this system. What's the exact command or file path to launch it?`,
  };
}

function openUrl(url) {
  const safe = String(url || '');
  // Only ever hand http(s) to the OS handler. Without this, a crafted
  // "open file:///..." or a custom scheme would execute through the shell.
  if (!/^https?:\/\//i.test(safe)) {
    return Promise.resolve({ success: false, message: `Refused to open unsafe URL: ${safe}` });
  }
  return shell.openExternal(safe).then(
    () => ({ success: true, message: 'Opened in your browser.' }),
    (err) => ({ success: false, message: `Failed to open URL: ${err.message}` }),
  );
}

/** Open a URL in a specific browser profile, falling back to the default. */
async function openUrlInProfile(url, browserKey, profile) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return { success: false, message: `Refused to open unsafe URL: ${url}` };
  }
  if (!profile) return openUrl(url);
  return openBrowser(browserKey || 'chrome', { profile, url });
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------
/**
 * Open a WhatsApp chat with the message pre-filled.
 *
 * WhatsApp's documented click-to-chat link targets a PHONE NUMBER only - there
 * is no supported way to address a contact by display name, which is why the
 * planner asks for a number the first time it sees a new name.
 *
 * The message is pre-filled but NOT sent: pressing send is left to the user
 * unless autoSend is explicitly enabled, because a synthetic Enter keystroke
 * goes to whatever window has focus at that moment.
 */
async function sendWhatsApp({ phone, message, profile, autoSend = false }) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (!digits) {
    return { success: false, message: 'I need a phone number (with country code) to open a WhatsApp chat.' };
  }

  const url = `https://web.whatsapp.com/send?phone=${digits}&text=${encodeURIComponent(message || '')}`;
  const opened = profile
    ? await openUrlInProfile(url, 'chrome', profile)
    : await openUrl(url);

  if (!opened.success) return opened;

  if (!autoSend) {
    return {
      success: true,
      message: `Opened the chat with +${digits} and pre-filled the message. Press Enter in WhatsApp to send it.`,
    };
  }

  const sent = await pressEnterAfterDelay(6000);
  return sent.success
    ? { success: true, message: `Sent the message to +${digits}.` }
    : {
        success: true,
        message: `Opened the chat with +${digits} and pre-filled the message, but auto-send failed (${sent.message}). Press Enter to send.`,
      };
}

/**
 * Best-effort auto-send: wait for WhatsApp Web to load, then deliver a single
 * Enter to the foreground window. Deliberately opt-in - if the user clicks
 * away during the delay, the keystroke lands somewhere else.
 */
function pressEnterAfterDelay(delayMs) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ success: false, message: 'auto-send is Windows-only' });
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      const script =
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")';
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        (error) => {
          resolve(
            error
              ? { success: false, message: error.message }
              : { success: true, message: 'sent' },
          );
        },
      );
    }, delayMs);
  });
}

// ---------------------------------------------------------------------------
// System actions
// ---------------------------------------------------------------------------
const SYSTEM_COMMANDS = {
  win32: {
    shutdown: { file: 'shutdown.exe', args: ['/s', '/t', '5'] },
    restart: { file: 'shutdown.exe', args: ['/r', '/t', '5'] },
    lock: { file: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
    sleep: { file: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] },
  },
  darwin: {
    shutdown: { file: 'osascript', args: ['-e', 'tell app "System Events" to shut down'] },
    restart: { file: 'osascript', args: ['-e', 'tell app "System Events" to restart'] },
    lock: { file: 'pmset', args: ['displaysleepnow'] },
    sleep: { file: 'pmset', args: ['sleepnow'] },
  },
  linux: {
    shutdown: { file: 'systemctl', args: ['poweroff'] },
    restart: { file: 'systemctl', args: ['reboot'] },
    lock: { file: 'loginctl', args: ['lock-session'] },
    sleep: { file: 'systemctl', args: ['suspend'] },
  },
};

async function systemAction(action) {
  const table = SYSTEM_COMMANDS[process.platform] || SYSTEM_COMMANDS.linux;
  const entry = table[action];
  if (!entry) return { success: false, message: `Unknown system action: ${action}` };

  const result = await launch(entry.file, entry.args);
  return result.success
    ? { success: true, message: `${action} initiated.` }
    : { success: false, message: `Failed to ${action}: ${result.message}` };
}

/** Run a command the user explicitly taught Jarvis. */
async function openCustom(target) {
  const trimmed = String(target || '').trim();
  if (!trimmed) return { success: false, message: 'Nothing to run.' };

  if (/^https?:\/\//i.test(trimmed) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(trimmed)) {
    return openUrl(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  }
  // A taught command is a path or executable name, launched as one literal
  // token - it is not re-parsed by a shell.
  const result = await startViaShell(trimmed);
  return result.success
    ? { success: true, message: 'Done.' }
    : { success: false, message: `Failed to run "${trimmed}": ${result.message}` };
}

// ---------------------------------------------------------------------------
// Filesystem navigation
// ---------------------------------------------------------------------------
// "open d drive" then "go to the projects folder" has to work, which means
// resolving a spoken folder name against somewhere sensible rather than
// demanding a full path. Resolution is deliberately explicit about ambiguity:
// three folders that all match get handed back as a question, not a guess.

/** "d drive" / "drive d" / "d:" / "the d drive" -> "D:\" */
function driveFromPhrase(text) {
  const match = String(text || '')
    .trim()
    .match(/^(?:the\s+)?(?:([a-z])\s*(?:drive|:)\\?|drive\s+([a-z]))$/i);
  if (!match) return null;
  const letter = (match[1] || match[2]).toUpperCase();
  return `${letter}:\\`;
}

/** Folders Windows users name out loud but never by path. */
function wellKnownPath(name) {
  const key = String(name || '').trim().toLowerCase().replace(/^(?:my|the)\s+/, '');
  const table = {
    desktop: 'desktop',
    documents: 'documents',
    docs: 'documents',
    downloads: 'downloads',
    download: 'downloads',
    pictures: 'pictures',
    photos: 'pictures',
    music: 'music',
    videos: 'videos',
    home: 'home',
  };
  if (!table[key]) return null;
  try {
    return app.getPath(table[key]);
  } catch {
    return null;
  }
}

/** Every drive root that currently exists, cheapest possible probe. */
function driveRoots() {
  if (process.platform !== 'win32') return ['/'];
  const roots = [];
  for (let code = 67; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root)) roots.push(root);
    } catch {
      /* not ready (empty card reader) - skip it */
    }
  }
  return roots;
}

/** Directory entries of `dir`, or [] if it cannot be read. */
function subdirectories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('$'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Exact, then prefix, then substring — so "project" finds "projects". */
function matchNames(names, wanted) {
  const needle = wanted.trim().toLowerCase();
  const exact = names.filter((n) => n.toLowerCase() === needle);
  if (exact.length) return exact;
  const prefix = names.filter((n) => n.toLowerCase().startsWith(needle));
  if (prefix.length) return prefix;
  return names.filter((n) => n.toLowerCase().includes(needle));
}

/**
 * Work out what a spoken location means.
 *
 * `base` is where the conversation currently is — the last place Jarvis
 * opened — so "go to the projects folder" means inside it, and only falls back
 * to searching elsewhere when that misses.
 */
function resolvePath(query, base) {
  const raw = String(query || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return { success: false, message: 'Which folder?' };

  // --- already a path ------------------------------------------------------
  if (/^[a-z]:[\\/]/i.test(raw) || /^\\\\/.test(raw) || raw.startsWith('/')) {
    return fs.existsSync(raw)
      ? { success: true, path: path.normalize(raw) }
      : { success: false, message: `There's nothing at ${raw}.` };
  }

  // --- a drive -------------------------------------------------------------
  const drive = driveFromPhrase(raw);
  if (drive) {
    return fs.existsSync(drive)
      ? { success: true, path: drive }
      : { success: false, message: `There's no ${drive.replace('\\', '')} drive on this machine.` };
  }

  // --- a well-known folder -------------------------------------------------
  const known = wellKnownPath(raw);
  if (known) return { success: true, path: known };

  // --- a folder name, searched somewhere sensible --------------------------
  const name = raw.replace(/\s+folder$/i, '').replace(/^(?:the|my)\s+/i, '').trim();

  // "projects/src" spoken as one phrase still has to land.
  const segments = name.split(/[\\/]+/).filter(Boolean);
  if (segments.length > 1 && base) {
    const joined = path.join(base, ...segments);
    if (fs.existsSync(joined)) return { success: true, path: joined };
  }

  const searchRoots = [];
  if (base && fs.existsSync(base)) searchRoots.push(base);
  const home = app.getPath('home');
  if (!searchRoots.includes(home)) searchRoots.push(home);
  for (const root of driveRoots()) {
    if (!searchRoots.includes(root)) searchRoots.push(root);
  }

  const hits = [];
  for (const root of searchRoots) {
    for (const match of matchNames(subdirectories(root), name)) {
      hits.push(path.join(root, match));
    }
    // The first root that matches wins outright: a folder inside where we
    // already are beats an identically-named one three drives away.
    if (hits.length) break;
  }

  if (hits.length === 1) return { success: true, path: hits[0] };
  if (hits.length > 1) {
    return {
      success: false,
      candidates: hits.slice(0, 8),
      message: `I found ${hits.length} of those: ${hits.slice(0, 8).join(', ')}. Which one?`,
    };
  }

  return {
    success: false,
    message: `I couldn't find a folder called "${name}"${base ? ` in ${base}, your home folder or any drive root` : ''}.`,
  };
}

/** Resolve, then open it in Explorer. */
function openPath(query, base) {
  const resolved = resolvePath(query, base);
  if (!resolved.success) return Promise.resolve(resolved);

  return shell.openPath(resolved.path).then((error) =>
    error
      ? { success: false, message: `Couldn't open ${resolved.path}: ${error}` }
      : { success: true, message: `Opened ${resolved.path}`, path: resolved.path },
  );
}

/** What's in a folder — so Jarvis can answer without opening a window. */
function listPath(query, base) {
  const resolved = resolvePath(query, base);
  if (!resolved.success) return resolved;
  try {
    const entries = fs.readdirSync(resolved.path, { withFileTypes: true });
    return {
      success: true,
      path: resolved.path,
      folders: entries.filter((e) => e.isDirectory()).map((e) => e.name).slice(0, 200),
      files: entries.filter((e) => e.isFile()).map((e) => e.name).slice(0, 200),
      message: `${resolved.path} holds ${entries.filter((e) => e.isDirectory()).length} folders and ${entries.filter((e) => e.isFile()).length} files.`,
    };
  } catch (err) {
    return { success: false, message: `Couldn't read ${resolved.path}: ${err.message}` };
  }
}

function createFile(filePath, content = '') {
  try {
    fs.writeFileSync(filePath, content);
    return { success: true, message: `File created at ${filePath}` };
  } catch (err) {
    return { success: false, message: `Failed to create file: ${err.message}` };
  }
}

function openFile(filePath) {
  return shell.openPath(filePath).then((result) =>
    result
      ? { success: false, message: `Failed to open file: ${result}` }
      : { success: true, message: `Opened ${filePath}` },
  );
}

// ---------------------------------------------------------------------------
// IPC - registered exactly once, before any window exists
// ---------------------------------------------------------------------------
let mainWindow = null;

function registerIpcHandlers() {
  ipcMain.handle('memory:get', () => readMemory());
  ipcMain.handle('memory:set', (_event, data) => writeMemory(data));

  ipcMain.handle('action:open-app', (_event, appKey, options) => openApp(appKey, options || {}));
  ipcMain.handle('action:open-url', (_event, url) => openUrl(url));
  ipcMain.handle('action:open-url-profile', (_event, { url, browser, profile }) =>
    openUrlInProfile(url, browser, profile),
  );
  ipcMain.handle('action:open-custom', (_event, target) => openCustom(target));
  ipcMain.handle('action:system', (_event, action) => systemAction(action));
  ipcMain.handle('action:whatsapp', (_event, payload) => sendWhatsApp(payload || {}));
  ipcMain.handle('action:open-path', (_event, { query, base }) => openPath(query, base));
  ipcMain.handle('action:list-path', (_event, { query, base }) => listPath(query, base));
  ipcMain.handle('action:resolve-path', (_event, { query, base }) => resolvePath(query, base));
  ipcMain.handle('action:create-file', (_event, { filePath, content }) => createFile(filePath, content));
  ipcMain.handle('action:open-file', (_event, filePath) => openFile(filePath));
  ipcMain.handle('action:list-profiles', (_event, browser) => listProfiles(browser || 'chrome'));

  ipcMain.handle('system:stats', () => {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
      platform: os.platform(),
      cpuModel: cpus[0]?.model || 'Unknown',
      cpuCount: cpus.length,
      memUsedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
      uptime: os.uptime(),
    };
  });

  ipcMain.handle('system:datetime', () => {
    const now = new Date();
    return {
      time: now.toLocaleTimeString(),
      date: now.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      iso: now.toISOString(),
    };
  });

  // Window controls act on the current window, so reopening one after all
  // windows close does not re-register (and throw on) a duplicate handler.
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () =>
    mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize(),
  );
  ipcMain.handle('window:close', () => mainWindow?.close());

  // The wake word fires while the window is hidden in the tray, so the
  // renderer needs a way to ask for itself back.
  ipcMain.handle('window:show', () => showWindow());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // Pilot's own surface. It pushes events back (a stop pressed on the global
  // shortcut has to reach a renderer that is not asking for anything), so it
  // gets a sender rather than only answering invokes.
  registerPilotHandlers((channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  });
}

// ---------------------------------------------------------------------------
// Tray — Jarvis has to stay resident for a wake word to mean anything
// ---------------------------------------------------------------------------
// Nothing can hear "jarvis" when no process is running, so closing the window
// hides it instead of quitting. Quitting is still available, from the tray
// menu and from a real app quit.

let tray = null;
let quitting = false;

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * A tray icon drawn in code.
 * electron-builder only supplies an icon when the developer dropped one into
 * build/, and a tray with no image is an invisible tray - which looks exactly
 * like the app having crashed.
 */
function trayIcon() {
  const file = path.join(__dirname, '..', 'build', 'icon.png');
  try {
    if (fs.existsSync(file)) {
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
    }
  } catch {
    /* fall through to the drawn one */
  }

  // A 16x16 filled circle, as a data URL, so there is always something there.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
    '<circle cx="8" cy="8" r="7" fill="none" stroke="#3b82f6" stroke-width="2"/>' +
    '<circle cx="8" cy="8" r="3" fill="#3b82f6"/></svg>';
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip('Jarvis Lite — say “Jarvis”');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Jarvis', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1536,
    height: 1024,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0e17',
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The Live session, the microphone and the background check-ins keep
      // running while the window sits hidden behind the tray.
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Closing hides. The renderer keeps the microphone open behind the tray
  // icon, which is the only way a wake word can work at all.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  // Never let the app frame itself navigate away or spawn popups; external
  // links go to the real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    // Opt-in (JARVIS_DEVTOOLS=1): a detached DevTools window costs as much
    // as the app itself.
    if (process.env.JARVIS_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'out', 'index.html'));
  }
}

app.whenReady().then(() => {
  ensureMemoryFile();
  registerIpcHandlers();
  registerMarkHandlers({
    getWindow: () => mainWindow,
    showWindow: () => showWindow(),
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
  createWindow();
  createTray();

  // Summon Jarvis from anywhere, for when the wake word mishears or the mic
  // is off entirely.
  if (!globalShortcut.register('CommandOrControl+Alt+J', () => showWindow())) {
    console.warn('Jarvis: Ctrl+Alt+J is taken — the summon shortcut is unavailable.');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

// Deliberately does NOT quit: the tray icon is the app now, and the renderer
// behind it is what is listening for the wake word.
app.on('window-all-closed', () => {});

// Pilot holds a long-lived helper process and a global shortcut; neither
// should outlive the app.
app.on('will-quit', () => {
  globalShortcut.unregister('CommandOrControl+Alt+J');
  shutdownPilot();
  shutdownMark();
});
