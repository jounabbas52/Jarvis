// computer_settings — the Node port of Mark LIV's actions/computer_settings.py.
//
// One tool for every single-shot computer command: volume, brightness, window
// management, browser/tab shortcuts, clipboard keys, typing, dark mode, WiFi,
// restart and shutdown. The split Mark draws is kept exactly:
//
//   irreversible (restart, shutdown, toggle_wifi) → parked behind the HUD's
//     CONFIRM button via ctx.confirm.request; the model cannot confirm itself.
//   everything else → done at once, with an undo pushed when the "before"
//     value could be read (volume, brightness, dark mode).
//
// pyautogui is replaced by the user32 helpers in _native.js; pycaw by Core
// Audio through the same helper; winreg by reg.exe.

const os = require('os');
const { run, runPS, launchDetached } = require('../util/ps');
const native = require('./_native');
const { getCloseMatches } = require('./_difflib');

const PLAT = process.platform; // 'win32' | 'darwin' | 'linux'
const IS_WIN = PLAT === 'win32';
const IS_MAC = PLAT === 'darwin';
const OS_LABEL = { win32: 'Windows', darwin: 'Darwin' }[PLAT] || 'Linux';

const { hotkey, press, sleep } = native;
const mod = () => (IS_MAC ? 'command' : 'ctrl');

async function which(cmd) {
  const r = await run(IS_WIN ? 'where.exe' : 'which', [cmd], { timeout: 5000 });
  return r.ok && r.stdout.trim() ? r.stdout.trim().split(/\r?\n/)[0] : '';
}

/** Start the first of `cmds` that exists (Linux helpers). */
async function firstAvailable(cmds, { wait = false } = {}) {
  for (const cmd of cmds) {
    if (await which(cmd[0])) {
      if (wait) await run(cmd[0], cmd.slice(1), { timeout: 10_000 });
      else launchDetached(cmd[0], cmd.slice(1));
      return true;
    }
  }
  return false;
}

async function macWifiInterface() {
  const r = await run('networksetup', ['-listallhardwareports'], { timeout: 5000 });
  const lines = r.stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Wi-Fi') || lines[i].includes('AirPort')) {
      for (let j = i; j < Math.min(i + 4, lines.length); j++) {
        if (lines[j].startsWith('Device:')) return lines[j].split(':', 2)[1].trim();
      }
    }
  }
  return 'en0';
}

// ── Volume ───────────────────────────────────────────────────────────────────
const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));

async function volumeUp() {
  if (IS_WIN) return press('volumeup', 5);
  if (IS_MAC) return run('osascript', ['-e', 'set volume output volume (output volume of (get volume settings) + 10)']);
  return run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', '+10%']);
}

async function volumeDown() {
  if (IS_WIN) return press('volumedown', 5);
  if (IS_MAC) return run('osascript', ['-e', 'set volume output volume (output volume of (get volume settings) - 10)']);
  return run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', '-10%']);
}

/**
 * mode: 'mute' | 'unmute' | 'toggle'. Mark sent the mute KEY for all three,
 * which turns "unmute" into "mute" when the sound was already on. Core Audio
 * can set the state outright, so on Windows each word does what it says.
 */
async function volumeMute(mode = 'toggle') {
  if (IS_WIN) {
    if (mode === 'toggle') return native.setMute(!(await native.getMute()));
    return native.setMute(mode === 'mute');
  }
  if (IS_MAC) {
    const arg = mode === 'unmute' ? 'set volume without output muted' : 'set volume with output muted';
    return run('osascript', ['-e', arg]);
  }
  return run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', mode === 'toggle' ? 'toggle' : mode === 'mute' ? '1' : '0']);
}

/**
 * Current master volume 0-100, or null if this platform will not say.
 * Undo needs a "before" value; where it is not readable the action simply is
 * not registered as undoable — a wrong undo is worse than no undo.
 */
async function volumeGet() {
  try {
    if (IS_WIN) return clamp(await native.getVolume());
    if (IS_MAC) {
      const r = await run('osascript', ['-e', 'output volume of (get volume settings)'], { timeout: 5000 });
      const n = parseInt(r.stdout.trim(), 10);
      return Number.isFinite(n) ? clamp(n) : null;
    }
    const r = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { timeout: 5000 });
    const m = r.stdout.match(/(\d+)%/);
    return m ? clamp(m[1]) : null;
  } catch {
    return null;
  }
}

async function muteGet() {
  try {
    if (IS_WIN) return await native.getMute();
    if (IS_MAC) {
      const r = await run('osascript', ['-e', 'output muted of (get volume settings)'], { timeout: 5000 });
      return r.ok ? r.stdout.trim() === 'true' : null;
    }
    const r = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@'], { timeout: 5000 });
    return r.ok ? /yes/i.test(r.stdout) : null;
  } catch {
    return null;
  }
}

async function muteSet(m) {
  if (IS_WIN) return native.setMute(m);
  if (IS_MAC) return run('osascript', ['-e', m ? 'set volume with output muted' : 'set volume without output muted']);
  return run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', m ? '1' : '0']);
}

async function volumeSet(value) {
  value = clamp(value);
  if (IS_WIN) return native.setVolume(value);
  if (IS_MAC) return run('osascript', ['-e', `set volume output volume ${value}`]);
  return run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${value}%`]);
}

// ── Brightness ───────────────────────────────────────────────────────────────
const WMI_GET = '(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness';
const wmiSet = (expr) =>
  `$ErrorActionPreference='Stop'; $m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1; ` +
  `Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{Timeout=[uint32]1; Brightness=[byte](${expr})} | Out-Null`;

async function xrandrStep(delta) {
  const v = await run('xrandr', ['--verbose'], { timeout: 5000 });
  const out = (v.stdout.match(/^(\S+) connected/m) || [])[1];
  const cur = parseFloat((v.stdout.split('Brightness:')[1] || '').trim().split(/\s/)[0]);
  if (!out || !Number.isFinite(cur)) throw new Error('xrandr could not read the brightness');
  const next = delta > 0 ? Math.min(1.0, cur + 0.1) : Math.max(0.1, cur - 0.1);
  return run('xrandr', ['--output', out, '--brightness', String(next)]);
}

async function brightnessStep(delta) {
  if (IS_MAC) {
    return run('osascript', ['-e', `tell application "System Events" to key code ${delta > 0 ? 144 : 145}`]);
  }
  if (PLAT === 'linux') {
    if (await which('brightnessctl')) return run('brightnessctl', ['set', delta > 0 ? '+10%' : '10%-']);
    return xrandrStep(delta);
  }
  const expr = delta > 0 ? `[math]::Min(100, (${WMI_GET}) + 10)` : `[math]::Max(0, (${WMI_GET}) - 10)`;
  const r = await runPS(wmiSet(expr), { timeout: 10_000 });
  if (!r.ok) console.warn(`[Settings] Brightness ${delta > 0 ? 'up' : 'down'} failed on Windows: ${r.stderr.trim()}`);
  return r;
}

const brightnessUp = () => brightnessStep(+1);
const brightnessDown = () => brightnessStep(-1);

/** Current brightness 0-100, or null where it cannot be read (e.g. desktop monitors). */
async function brightnessGet() {
  try {
    if (IS_WIN) {
      const r = await runPS(WMI_GET, { timeout: 8000 });
      const n = parseInt(r.stdout.trim(), 10);
      return r.ok && Number.isFinite(n) ? clamp(n) : null;
    }
    if (PLAT === 'linux' && (await which('brightnessctl'))) {
      const cur = parseInt((await run('brightnessctl', ['get'], { timeout: 5000 })).stdout, 10);
      const mx = parseInt((await run('brightnessctl', ['max'], { timeout: 5000 })).stdout, 10);
      return mx ? clamp((cur * 100) / mx) : null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Absolute brightness — only used by undo to restore a captured value. */
async function brightnessSet(value) {
  value = clamp(value);
  if (IS_WIN) return runPS(wmiSet(String(value)), { timeout: 10_000 });
  if (PLAT === 'linux') return run('brightnessctl', ['set', `${value}%`]);
  return null;
}

// ── Window / browser / editing shortcuts ─────────────────────────────────────
const closeApp = () => (IS_MAC ? hotkey('command', 'q') : hotkey('alt', 'f4'));
const closeWindow = () => (IS_MAC ? hotkey('command', 'w') : hotkey('ctrl', 'w'));
const fullScreen = () => (IS_MAC ? hotkey('ctrl', 'command', 'f') : press('f11'));
const minimizeWindow = () => (IS_MAC ? hotkey('command', 'm') : hotkey('win', 'down'));

async function maximizeWindow() {
  if (IS_MAC) {
    return run('osascript', ['-e', 'tell application "System Events" to keystroke "f" using {control down, command down}']);
  }
  if (IS_WIN) return hotkey('win', 'up');
  const r = await run('wmctrl', ['-r', ':ACTIVE:', '-b', 'add,maximized_vert,maximized_horz']);
  if (!r.ok) return hotkey('super', 'up');
  return r;
}

async function snap(side) {
  if (IS_WIN) return hotkey('win', side);
  if (IS_MAC) {
    // macOS has no built-in snap; try the Rectangle app's shortcut if installed.
    await run('open', ['-a', 'Rectangle'], { timeout: 1000 });
    return hotkey('ctrl', 'option', side);
  }
  return run('wmctrl', ['-r', ':ACTIVE:', '-e', side === 'left' ? '0,0,0,960,1080' : '0,960,0,960,1080']);
}
const snapLeft = () => snap('left');
const snapRight = () => snap('right');

const switchWindow = () => (IS_MAC ? hotkey('command', 'tab') : hotkey('alt', 'tab'));

function showDesktop() {
  if (IS_MAC) return hotkey('fn', 'f11');
  if (IS_WIN) return hotkey('win', 'd');
  return hotkey('super', 'd');
}

async function openTaskManager() {
  if (IS_WIN) return hotkey('ctrl', 'shift', 'esc');
  if (IS_MAC) return launchDetached('open', ['-a', 'Activity Monitor']);
  return firstAvailable([['gnome-system-monitor'], ['xfce4-taskmanager'], ['htop']]);
}

const focusSearch = () => hotkey(mod(), 'l');
const pauseVideo = () => press('space');
const refreshPage = () => (IS_MAC ? hotkey('command', 'r') : press('f5'));
const closeTab = () => hotkey(mod(), 'w');
const newTab = () => hotkey(mod(), 't');
const nextTab = () => (IS_MAC ? hotkey('command', 'shift', 'bracketright') : hotkey('ctrl', 'tab'));
const prevTab = () => (IS_MAC ? hotkey('command', 'shift', 'bracketleft') : hotkey('ctrl', 'shift', 'tab'));
const goBack = () => (IS_MAC ? hotkey('command', 'left') : hotkey('alt', 'left'));
const goForward = () => (IS_MAC ? hotkey('command', 'right') : hotkey('alt', 'right'));
const zoomIn = () => hotkey(mod(), 'equal');
const zoomOut = () => hotkey(mod(), 'minus');
const zoomReset = () => hotkey(mod(), '0');
const findOnPage = () => hotkey(mod(), 'f');

async function reloadPageN(n) {
  for (let i = 0; i < Math.max(1, n); i++) {
    await refreshPage();
    await sleep(800);
  }
}

const scrollUp = (amount = 500) => native.scroll(amount);
const scrollDown = (amount = 500) => native.scroll(-amount);
const scrollTop = () => (IS_MAC ? hotkey('command', 'up') : hotkey('ctrl', 'home'));
const scrollBottom = () => (IS_MAC ? hotkey('command', 'down') : hotkey('ctrl', 'end'));
const pageUp = () => press('pageup');
const pageDown = () => press('pagedown');

const copy = () => hotkey(mod(), 'c');
const paste = () => hotkey(mod(), 'v');
const cut = () => hotkey(mod(), 'x');
const undoKey = () => hotkey(mod(), 'z');
const redo = () => (IS_MAC ? hotkey('command', 'shift', 'z') : hotkey('ctrl', 'y'));
const selectAll = () => hotkey(mod(), 'a');
const saveFile = () => hotkey(mod(), 's');
const pressEnter = () => press('enter');
const pressEscape = () => press('escape');
const pressKey = (key) => press(key);

async function typeText(text, pressEnterAfter = false) {
  if (!text) return;
  // Clipboard + paste, like Mark's pyperclip path: instant for long text and
  // immune to the target's autocomplete eating keystrokes.
  if (native.clipboardWrite(String(text))) {
    await sleep(150);
    await paste();
  } else {
    await native.typeText(String(text), 30);
  }
  if (pressEnterAfter) {
    await sleep(100);
    await press('enter');
  }
}

async function takeScreenshot() {
  if (IS_WIN) return hotkey('win', 'shift', 's');
  if (IS_MAC) return hotkey('command', 'shift', '3');
  const ok = await firstAvailable([['scrot'], ['gnome-screenshot'], ['import', '-window', 'root', 'screenshot.png']]);
  if (!ok) return hotkey('ctrl', 'print_screen');
}

async function lockScreen() {
  if (IS_WIN) {
    // Win+L is the one chord Windows refuses to accept from synthetic input,
    // so the pyautogui hotkey is replaced by the API it triggers.
    const r = await run('rundll32.exe', ['user32.dll,LockWorkStation']);
    if (!r.ok) return hotkey('win', 'l');
    return r;
  }
  if (IS_MAC) return run('pmset', ['displaysleepnow']);
  return firstAvailable(
    [['gnome-screensaver-command', '-l'], ['xdg-screensaver', 'lock'], ['loginctl', 'lock-session']],
    { wait: true },
  );
}

async function openSystemSettings() {
  if (IS_WIN) return hotkey('win', 'i');
  if (IS_MAC) return launchDetached('open', ['-a', 'System Preferences']);
  return firstAvailable([['gnome-control-center'], ['xfce4-settings-manager'], ['kcmshell5']]);
}

async function openFileExplorer() {
  if (IS_WIN) return hotkey('win', 'e');
  if (IS_MAC) return launchDetached('open', [os.homedir()]);
  if (!(await firstAvailable([['nautilus'], ['thunar'], ['dolphin'], ['nemo']]))) {
    launchDetached('xdg-open', [os.homedir()]);
  }
}

async function sleepDisplay() {
  if (IS_WIN) {
    try {
      await native.monitorOff();
    } catch (e) {
      console.warn(`[Settings] sleep_display failed: ${e.message}`);
    }
    return;
  }
  if (IS_MAC) return run('pmset', ['displaysleepnow']);
  return run('xset', ['dpms', 'force', 'off']);
}

const openRun = () => (IS_WIN ? hotkey('win', 'r') : null);

// ── Dark mode ────────────────────────────────────────────────────────────────
const THEME_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

async function regGetDword(name) {
  const r = await run('reg.exe', ['query', THEME_KEY, '/v', name], { timeout: 5000 });
  const m = r.stdout.match(/REG_DWORD\s+0x([0-9a-f]+)/i);
  return m ? parseInt(m[1], 16) : null;
}

async function regSetDword(name, value) {
  const r = await run('reg.exe', ['add', THEME_KEY, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f'], { timeout: 5000 });
  if (!r.ok) throw new Error(r.stderr.trim() || `could not write ${name}`);
}

/** Snapshot of the current theme, or null where it cannot be read. */
async function themeGet() {
  try {
    if (IS_WIN) {
      const apps = await regGetDword('AppsUseLightTheme');
      const system = await regGetDword('SystemUsesLightTheme');
      return apps == null ? null : { apps, system: system == null ? apps : system };
    }
    if (IS_MAC) {
      const r = await run('osascript', ['-e', 'tell app "System Events" to tell appearance preferences to get dark mode']);
      return r.ok ? { dark: r.stdout.trim() === 'true' } : null;
    }
    const r = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']);
    return r.ok ? { scheme: r.stdout.trim() } : null;
  } catch {
    return null;
  }
}

async function themeSet(snap) {
  if (IS_WIN) {
    await regSetDword('AppsUseLightTheme', snap.apps);
    await regSetDword('SystemUsesLightTheme', snap.system);
  } else if (IS_MAC) {
    await run('osascript', ['-e', `tell app "System Events" to tell appearance preferences to set dark mode to ${snap.dark}`]);
  } else {
    await run('gsettings', ['set', 'org.gnome.desktop.interface', 'color-scheme', snap.scheme]);
  }
}

async function darkMode() {
  if (IS_MAC) {
    return run('osascript', ['-e', 'tell app "System Events" to tell appearance preferences to set dark mode to not dark mode']);
  }
  if (IS_WIN) {
    try {
      const current = await regGetDword('AppsUseLightTheme');
      if (current == null) throw new Error('AppsUseLightTheme is not set');
      await regSetDword('AppsUseLightTheme', 1 - current);
      await regSetDword('SystemUsesLightTheme', 1 - current);
    } catch (e) {
      console.warn(`[Settings] dark_mode registry failed: ${e.message}`);
    }
    return;
  }
  try {
    const r = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']);
    const next = r.stdout.includes('dark') ? "'default'" : "'prefer-dark'";
    await run('gsettings', ['set', 'org.gnome.desktop.interface', 'color-scheme', next]);
  } catch (e) {
    console.warn(`[Settings] dark_mode Linux failed: ${e.message}`);
  }
}

// ── WiFi / power ─────────────────────────────────────────────────────────────
async function toggleWifi() {
  if (IS_MAC) {
    const iface = await macWifiInterface();
    const r = await run('networksetup', ['-getairportpower', iface]);
    const state = r.stdout.includes('On') ? 'off' : 'on';
    await run('networksetup', ['-setairportpower', iface, state]);
    return `WiFi turned ${state}.`;
  }
  if (IS_WIN) {
    // netsh knows the adapter even while it is disabled (wlan show interfaces
    // does not), so the toggle can go both ways.
    const list = await run('netsh.exe', ['interface', 'show', 'interface'], { timeout: 10_000 });
    const row = list.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().match(/^(Enabled|Disabled)\s+\S+(?:\s\S+)?\s+\S+\s+(.+)$/i))
      .find((m) => m && /wi-?fi|wireless|wlan/i.test(m[2]));
    if (row) {
      const next = /enabled/i.test(row[1]) ? 'disabled' : 'enabled';
      const r = await run('netsh.exe', ['interface', 'set', 'interface', `name=${row[2].trim()}`, `admin=${next}`], { timeout: 15_000 });
      if (r.ok) return `WiFi ${next}.`;
    }
    // Mark's own route, for adapters netsh names differently.
    const r = await runPS(
      "$adapter = Get-NetAdapter | Where-Object {$_.PhysicalMediaType -eq 'Native 802.11'} | Select-Object -First 1;" +
        "if (-not $adapter) { throw 'no WiFi adapter found' }" +
        "if ($adapter.Status -eq 'Up') { Disable-NetAdapter -Name $adapter.Name -Confirm:$false; 'WiFi disabled.' }" +
        "else { Enable-NetAdapter -Name $adapter.Name -Confirm:$false; 'WiFi enabled.' }",
      { timeout: 15_000 },
    );
    if (r.ok && r.stdout.trim()) return r.stdout.trim();
    return `Could not toggle WiFi (switching the adapter needs administrator rights): ${(r.stderr || '').trim().split('\n')[0]}`;
  }
  const r = await run('nmcli', ['radio', 'wifi']);
  const state = r.stdout.includes('enabled') ? 'off' : 'on';
  await run('nmcli', ['radio', 'wifi', state]);
  return `WiFi turned ${state}.`;
}

async function restartComputer() {
  if (IS_WIN) return run('shutdown.exe', ['/r', '/t', '10']);
  if (IS_MAC) return run('osascript', ['-e', 'tell application "System Events" to restart']);
  return run('systemctl', ['reboot']);
}

async function shutdownComputer() {
  if (IS_WIN) return run('shutdown.exe', ['/s', '/t', '10']);
  if (IS_MAC) return run('osascript', ['-e', 'tell application "System Events" to shut down']);
  return run('systemctl', ['poweroff']);
}

const ACTION_MAP = {
  volume_up: volumeUp,
  volume_down: volumeDown,
  mute: () => volumeMute('mute'),
  unmute: () => volumeMute('unmute'),
  toggle_mute: () => volumeMute('toggle'),
  brightness_up: brightnessUp,
  brightness_down: brightnessDown,
  sleep_display: sleepDisplay,
  screen_off: sleepDisplay,
  pause_video: pauseVideo,
  play_pause: pauseVideo,
  close_app: closeApp,
  close_window: closeWindow,
  full_screen: fullScreen,
  fullscreen: fullScreen,
  minimize: minimizeWindow,
  maximize: maximizeWindow,
  snap_left: snapLeft,
  snap_right: snapRight,
  switch_window: switchWindow,
  show_desktop: showDesktop,
  task_manager: openTaskManager,
  focus_search: focusSearch,
  refresh_page: refreshPage,
  reload: refreshPage,
  close_tab: closeTab,
  new_tab: newTab,
  next_tab: nextTab,
  prev_tab: prevTab,
  go_back: goBack,
  go_forward: goForward,
  zoom_in: zoomIn,
  zoom_out: zoomOut,
  zoom_reset: zoomReset,
  find_on_page: findOnPage,
  scroll_up: scrollUp,
  scroll_down: scrollDown,
  scroll_top: scrollTop,
  scroll_bottom: scrollBottom,
  page_up: pageUp,
  page_down: pageDown,
  copy,
  paste,
  cut,
  undo: undoKey,
  redo,
  select_all: selectAll,
  save: saveFile,
  enter: pressEnter,
  escape: pressEscape,
  screenshot: takeScreenshot,
  lock_screen: lockScreen,
  open_settings: openSystemSettings,
  file_explorer: openFileExplorer,
  open_run: openRun,
  dark_mode: darkMode,
  toggle_wifi: toggleWifi,
  restart: restartComputer,
  shutdown: shutdownComputer,
};

// ── What needs a human, and what just needs an undo ──────────────────────────
// The split is about reversibility, not how alarming the word sounds. WiFi is
// here because switching it off cuts the assistant's own Live connection, so
// it could not be asked to turn it back on.
const IRREVERSIBLE = {
  restart: ['Restart this computer', 'Anything unsaved will be lost. The computer restarts in 10 seconds.'],
  shutdown: ['Shut this computer down', 'Anything unsaved will be lost. The computer powers off in 10 seconds.'],
  toggle_wifi: [
    'Switch WiFi off or on',
    'If this switches WiFi off, JARVIS loses its connection and cannot switch it back on by voice.',
  ],
};
const DANGEROUS_ACTIONS = new Set(Object.keys(IRREVERSIBLE));

// ── Local intent resolution (no extra model call) ────────────────────────────
const ALIASES = {
  volume_up: ['louder', 'raise volume', 'turn it up', 'increase volume'],
  volume_down: ['quieter', 'lower volume', 'turn it down', 'decrease volume'],
  mute: ['silence', 'sound off', 'no sound'],
  brightness_up: ['brighter', 'raise brightness', 'increase brightness'],
  brightness_down: ['dimmer', 'dim', 'lower brightness', 'decrease brightness'],
  close_window: ['close this', 'close it'],
  full_screen: ['fullscreen', 'maximise screen'],
  show_desktop: ['minimise everything', 'go to desktop'],
  lock_screen: ['lock', 'lock the pc', 'lock computer'],
  sleep_display: ['screen off', 'turn off the screen', 'display off'],
  dark_mode: ['night mode', 'light mode', 'toggle theme'],
  toggle_wifi: ['wifi', 'wi-fi', 'internet off', 'internet on'],
  task_manager: ['processes', 'task list'],
  screenshot: ['capture screen', 'take a screenshot', 'snip'],
  refresh_page: ['refresh', 'reload page'],
  new_tab: ['open a tab', 'open new tab'],
  shutdown: ['power off', 'turn off the computer', 'switch off the pc'],
  restart: ['reboot', 'restart the pc'],
};

const VALUE_ACTIONS = new Set(['volume_set', 'type_text', 'press_key', 'reload_n', 'scroll_up', 'scroll_down']);

const normalise = (text) => String(text || '').trim().toLowerCase().replace(/-/g, '_').replace(/ /g, '_');
const sortedKeys = (iter) => [...iter].sort();

/** Resolve a free-text description to {action, value}; action '' when nothing matched. */
function detectAction(description) {
  const raw = String(description || '').trim();
  const norm = normalise(raw);
  if (!norm) return { action: '', value: null };

  const known = new Set([...Object.keys(ACTION_MAP), ...VALUE_ACTIONS]);

  // 1. Already an action name.
  if (known.has(norm)) return { action: norm, value: null };

  const low = raw.toLowerCase();

  // 2. "set volume to 30", "sesi 30 yap" — a number next to a volume word.
  const num = low.match(/(\d{1,3})\s*%?/);
  if (num && ['volume', 'ses', 'sound', 'lautstark', 'громкость'].some((w) => low.includes(w))) {
    return { action: 'volume_set', value: clamp(num[1]) };
  }

  // 3. Alias phrases.
  for (const [action, phrases] of Object.entries(ALIASES)) {
    if (phrases.some((p) => normalise(p) === norm || low.includes(p))) return { action, value: null };
  }

  // 4. Fuzzy match on the action names — catches "fullscren", "volumeup".
  const close = getCloseMatches(norm, sortedKeys(known), 1, 0.72);
  if (close.length) return { action: close[0], value: null };

  // 5. Substring: "increase_the_brightness" contains "brightness".
  const byLen = sortedKeys(known).sort((a, b) => b.length - a.length);
  for (const action of byLen) {
    if (action.length > 4 && (norm.includes(action) || action.includes(norm))) return { action, value: null };
  }
  return { action: '', value: null };
}

/** What to tell the model when nothing matched — real names, so its retry lands. */
function suggest(description) {
  const names = sortedKeys(Object.keys(ACTION_MAP));
  const near = getCloseMatches(normalise(description), names, 5, 0.3);
  const hint = near.length ? near.join(', ') : names.slice(0, 12).join(', ');
  return (
    `I could not match '${description}' to a computer action. ` +
    `Call computer_settings again with an exact \`action\` from: ${hint}.`
  );
}

const toInt = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

async function computerSettings(parameters, ctx) {
  const params = parameters || {};
  let rawAction = String(params.action || '').trim();
  const description = String(params.description || '').trim();
  let value = params.value ?? null;

  if (!rawAction && description) {
    const detected = detectAction(description);
    rawAction = detected.action || '';
    if (value == null) value = detected.value;
  }

  const action = rawAction.toLowerCase().trim().replace(/ /g, '_').replace(/-/g, '_');
  if (!action) return suggest(description || rawAction);

  console.log(`[Settings] Action: ${action}  Value: ${value}  OS: ${OS_LABEL}`);
  ctx?.ui?.log?.(`[Settings] ${action}`);

  // ── The gate: a human presses a button, or this does not happen. ──────────
  if (IRREVERSIBLE[action]) {
    const [title, detail] = IRREVERSIBLE[action];
    const func = ACTION_MAP[action];
    if (!func) return `Unknown action: '${rawAction}'.`;
    if (ctx?.confirm?.pendingTitle?.()) {
      return 'There is already a confirmation waiting on screen. Ask the user to answer that one first.';
    }
    if (!ctx?.confirm?.request) {
      return `I cannot confirm '${title}' right now because the interface is not available, so I have not done it.`;
    }
    return ctx.confirm.request(action, title, detail, async () => {
      const out = await func();
      return typeof out === 'string' ? out : `${action} done.`;
    });
  }

  if (action === 'volume_set') {
    try {
      const target = clamp(toInt(value, 50));
      const before = await volumeGet();
      await volumeSet(target);
      if (before != null) {
        ctx?.undo?.push(`volume ${before}% → ${target}%`, async () => {
          await volumeSet(before);
          return `Back to ${before}%.`;
        });
      }
      return `Volume set to ${target}%.`;
    } catch (e) {
      return `Could not set volume: ${e.message || e}`;
    }
  }

  try {
    if (['type_text', 'write_on_screen', 'type', 'write'].includes(action)) {
      const text = String(value || params.text || '').trim();
      if (!text) return 'No text provided to type.';
      const enterAfter = ['true', '1', 'yes'].includes(String(params.press_enter ?? 'false').toLowerCase());
      await typeText(text, enterAfter);
      return `Typed: ${text.slice(0, 80)}`;
    }

    if (action === 'press_key') {
      const key = String(value || params.key || '').trim();
      if (!key) return 'No key specified.';
      await pressKey(key);
      return `Pressed: ${key}`;
    }

    if (['reload_n', 'refresh_n', 'reload_page_n'].includes(action)) {
      try {
        await reloadPageN(toInt(value || 1, 1));
        return `Reloaded ${value || 1} time(s).`;
      } catch (e) {
        return `Reload failed: ${e.message || e}`;
      }
    }

    if (action === 'scroll_up') {
      await scrollUp(toInt(value || 500, 500));
      return 'Scrolled up.';
    }
    if (action === 'scroll_down') {
      await scrollDown(toInt(value || 500, 500));
      return 'Scrolled down.';
    }
  } catch (e) {
    return `Action failed (${action}): ${e.message || e}`;
  }

  const func = ACTION_MAP[action];
  if (!func) return suggest(rawAction || description);

  // ── Capture "before" so the change can be taken back ─────────────────────
  // Read-then-write is the whole mechanism: where the platform will not tell
  // us the current value, nothing is registered.
  let before = null;
  if (['volume_up', 'volume_down', 'mute', 'unmute', 'toggle_mute'].includes(action)) {
    before = { kind: 'volume', value: await volumeGet(), muted: await muteGet() };
  } else if (['brightness_up', 'brightness_down'].includes(action)) {
    before = { kind: 'brightness', value: await brightnessGet() };
  } else if (action === 'dark_mode') {
    before = { kind: 'theme', value: await themeGet() };
  }

  try {
    await func();
  } catch (e) {
    console.warn(`[Settings] Action failed (${action}): ${e.message || e}`);
    return `Action failed (${action}): ${e.message || e}`;
  }

  if (before && before.value != null) {
    if (before.kind === 'volume') {
      const { value: old, muted } = before;
      ctx?.undo?.push(`volume (${action})`, async () => {
        await volumeSet(old);
        if (muted != null) await muteSet(muted);
        return `Volume back to ${old}%${muted ? ' (muted)' : ''}.`;
      });
    } else if (before.kind === 'brightness') {
      const old = before.value;
      ctx?.undo?.push(`brightness (${action})`, async () => {
        await brightnessSet(old);
        return `Brightness back to ${old}%.`;
      });
    } else if (before.kind === 'theme') {
      const old = before.value;
      ctx?.undo?.push('dark mode toggled', async () => {
        await themeSet(old);
        return 'Theme switched back.';
      });
    }
  } else if (action === 'dark_mode') {
    // Could not read the theme first: it is a pure toggle, so toggling again is the undo.
    ctx?.undo?.push('dark mode toggled', async () => {
      await darkMode();
      return 'Theme switched back.';
    });
  }

  return `Done: ${action}.`;
}

module.exports = {
  TOOL: {
    name: 'computer_settings',
    description:
      "Controls the computer: volume, brightness, window management, keyboard shortcuts, typing text on screen, closing apps, fullscreen, dark mode, WiFi, restart, shutdown, scrolling, tab management, zoom, screenshots, lock screen, refresh/reload page. Use for ANY single computer control command. restart, shutdown and toggle_wifi put a confirmation on the user's screen and do NOT happen until they press it — never claim they are done. Volume, brightness and dark mode can be reversed with the `undo` tool.",
    parameters: {
      type: 'OBJECT',
      properties: {
        action: {
          type: 'STRING',
          description:
            'The exact action. Prefer this over `description` — pick one of: ' +
            'volume_up | volume_down | volume_set | mute | ' +
            'brightness_up | brightness_down | sleep_display | ' +
            'pause_video | close_app | close_window | full_screen | ' +
            'minimize | maximize | snap_left | snap_right | ' +
            'switch_window | show_desktop | task_manager | focus_search | ' +
            'refresh_page | close_tab | new_tab | next_tab | prev_tab | ' +
            'go_back | go_forward | zoom_in | zoom_out | zoom_reset | ' +
            'find_on_page | scroll_up | scroll_down | scroll_top | ' +
            'scroll_bottom | page_up | page_down | copy | paste | cut | ' +
            'undo | redo | select_all | save | enter | escape | press_key | ' +
            'type_text | screenshot | lock_screen | open_settings | ' +
            'file_explorer | open_run | dark_mode | toggle_wifi | ' +
            'restart | shutdown',
        },
        description: {
          type: 'STRING',
          description: 'Fallback only, when no action name above fits. Resolved locally — no extra model call.',
        },
        value: {
          type: 'STRING',
          description: 'Optional value: volume level 0-100, text to type, key name, etc.',
        },
      },
      required: [],
    },
  },
  run: computerSettings,
  // Shared with other actions / tests.
  ACTION_MAP,
  IRREVERSIBLE,
  DANGEROUS_ACTIONS,
  detectAction,
  suggest,
  volumeGet,
  volumeSet,
  muteGet,
  brightnessGet,
  brightnessSet,
  themeGet,
};
