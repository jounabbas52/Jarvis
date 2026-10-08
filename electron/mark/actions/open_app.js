// open_app — the Node port of Mark LIV's actions/open_app.py.
//
// A per-OS alias table turns what the user said into what each OS launches,
// then an OS-specific launcher tries progressively broader routes. Windows
// adds two routes Mark did not have — the App Paths registry and the Start
// menu's own app list (Get-StartApps, which also covers Store apps like
// WhatsApp and Spotify) — before falling back to Mark's last resort of typing
// the name into Start search.

const fs = require('fs');
const path = require('path');
const { run, runPS, launchDetached } = require('../util/ps');
const native = require('./_native');

const SYSTEM = { win32: 'Windows', darwin: 'Darwin' }[process.platform] || 'Linux';

const APP_ALIASES = {
  chrome: { Windows: 'chrome', Darwin: 'Google Chrome', Linux: 'google-chrome' },
  'google chrome': { Windows: 'chrome', Darwin: 'Google Chrome', Linux: 'google-chrome' },
  firefox: { Windows: 'firefox', Darwin: 'Firefox', Linux: 'firefox' },
  edge: { Windows: 'msedge', Darwin: 'Microsoft Edge', Linux: 'microsoft-edge' },
  brave: { Windows: 'brave', Darwin: 'Brave Browser', Linux: 'brave-browser' },
  safari: { Windows: 'msedge', Darwin: 'Safari', Linux: 'firefox' },
  opera: { Windows: 'opera', Darwin: 'Opera', Linux: 'opera' },
  whatsapp: { Windows: 'WhatsApp', Darwin: 'WhatsApp', Linux: 'whatsapp' },
  telegram: { Windows: 'Telegram', Darwin: 'Telegram', Linux: 'telegram' },
  discord: { Windows: 'Discord', Darwin: 'Discord', Linux: 'discord' },
  slack: { Windows: 'Slack', Darwin: 'Slack', Linux: 'slack' },
  zoom: { Windows: 'Zoom', Darwin: 'zoom.us', Linux: 'zoom' },
  teams: { Windows: 'msteams', Darwin: 'Microsoft Teams', Linux: 'teams' },
  skype: { Windows: 'skype', Darwin: 'Skype', Linux: 'skype' },
  signal: { Windows: 'signal', Darwin: 'Signal', Linux: 'signal' },
  spotify: { Windows: 'Spotify', Darwin: 'Spotify', Linux: 'spotify' },
  vlc: { Windows: 'vlc', Darwin: 'VLC', Linux: 'vlc' },
  netflix: { Windows: 'Netflix', Darwin: 'Netflix', Linux: 'firefox' },
  vscode: { Windows: 'code', Darwin: 'Visual Studio Code', Linux: 'code' },
  'visual studio code': { Windows: 'code', Darwin: 'Visual Studio Code', Linux: 'code' },
  code: { Windows: 'code', Darwin: 'Visual Studio Code', Linux: 'code' },
  terminal: { Windows: 'wt', Darwin: 'Terminal', Linux: 'x-terminal-emulator' },
  cmd: { Windows: 'cmd.exe', Darwin: 'Terminal', Linux: 'bash' },
  powershell: { Windows: 'powershell.exe', Darwin: 'Terminal', Linux: 'bash' },
  postman: { Windows: 'Postman', Darwin: 'Postman', Linux: 'postman' },
  git: { Windows: 'git-bash', Darwin: 'Terminal', Linux: 'bash' },
  figma: { Windows: 'Figma', Darwin: 'Figma', Linux: 'figma' },
  blender: { Windows: 'blender', Darwin: 'Blender', Linux: 'blender' },
  word: { Windows: 'winword', Darwin: 'Microsoft Word', Linux: 'libreoffice --writer' },
  excel: { Windows: 'excel', Darwin: 'Microsoft Excel', Linux: 'libreoffice --calc' },
  powerpoint: { Windows: 'powerpnt', Darwin: 'Microsoft PowerPoint', Linux: 'libreoffice --impress' },
  libreoffice: { Windows: 'soffice', Darwin: 'LibreOffice', Linux: 'libreoffice' },
  notepad: { Windows: 'notepad.exe', Darwin: 'TextEdit', Linux: 'gedit' },
  textedit: { Windows: 'notepad.exe', Darwin: 'TextEdit', Linux: 'gedit' },
  explorer: { Windows: 'explorer.exe', Darwin: 'Finder', Linux: 'nautilus' },
  'file explorer': { Windows: 'explorer.exe', Darwin: 'Finder', Linux: 'nautilus' },
  finder: { Windows: 'explorer.exe', Darwin: 'Finder', Linux: 'nautilus' },
  'task manager': { Windows: 'taskmgr.exe', Darwin: 'Activity Monitor', Linux: 'gnome-system-monitor' },
  settings: { Windows: 'ms-settings:', Darwin: 'System Preferences', Linux: 'gnome-control-center' },
  calculator: { Windows: 'calc.exe', Darwin: 'Calculator', Linux: 'gnome-calculator' },
  paint: { Windows: 'mspaint.exe', Darwin: 'Preview', Linux: 'gimp' },
  instagram: { Windows: 'Instagram', Darwin: 'Instagram', Linux: 'firefox' },
  tiktok: { Windows: 'TikTok', Darwin: 'TikTok', Linux: 'firefox' },
  notion: { Windows: 'Notion', Darwin: 'Notion', Linux: 'notion' },
  obsidian: { Windows: 'Obsidian', Darwin: 'Obsidian', Linux: 'obsidian' },
  capcut: { Windows: 'CapCut', Darwin: 'CapCut', Linux: 'capcut' },
  steam: { Windows: 'steam', Darwin: 'Steam', Linux: 'steam' },
  epic: { Windows: 'EpicGamesLauncher', Darwin: 'Epic Games Launcher', Linux: 'legendary' },
  'epic games': { Windows: 'EpicGamesLauncher', Darwin: 'Epic Games Launcher', Linux: 'legendary' },
};

function normalize(raw) {
  const key = raw.toLowerCase().trim();
  if (APP_ALIASES[key]) return APP_ALIASES[key][SYSTEM] || raw;
  for (const [aliasKey, osMap] of Object.entries(APP_ALIASES)) {
    if (key.includes(aliasKey) || aliasKey.includes(key)) return osMap[SYSTEM] || raw;
  }
  return raw;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** shutil.which: PATH (+PATHEXT on Windows). */
function which(name) {
  if (!name) return '';
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : '';
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())]
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* next */
      }
    }
  }
  return '';
}

// ── Windows ──────────────────────────────────────────────────────────────────

// `cmd /c start` re-parses its arguments, so a name carrying a cmd operator
// could chain a second command. Such names skip the start routes entirely.
const CMD_UNSAFE = /[&|<>^%"\r\n]/;
const winStart = (target) =>
  launchDetached(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', target], { windowsHide: true });

async function appPathsHas(name) {
  const exe = /\.exe$/i.test(name) ? name : `${name}.exe`;
  for (const hive of ['HKCU', 'HKLM']) {
    const r = await run('reg.exe', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], { timeout: 5000 });
    if (r.ok) return true;
  }
  return false;
}

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best Start-menu entry for `name`, or null. */
async function findStartApp(name) {
  const r = await runPS(
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | ForEach-Object { "$($_.Name)`t$($_.AppID)" }',
    { timeout: 15_000 },
  );
  if (!r.ok) return null;
  const apps = r.stdout.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length === 2 && p[0]);
  const want = squash(name);
  if (!want) return null;
  const score = ([n]) => {
    const s = squash(n);
    if (s === want) return 3;
    if (s.startsWith(want)) return 2;
    if (s.includes(want)) return 1;
    return 0;
  };
  // Uninstallers and help links match "includes" too often; never pick them.
  const ranked = apps
    .filter(([n]) => !/uninstall|readme|help|documentation|release notes/i.test(n))
    .map((a) => [score(a), a])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1][0].length - b[1][0].length);
  return ranked.length ? { name: ranked[0][1][0], appId: ranked[0][1][1] } : null;
}

async function launchWindows(appName) {
  const safe = !CMD_UNSAFE.test(appName);

  if (safe && (which(appName) || which(appName.split('.')[0]))) {
    if (winStart(appName)) {
      await sleep(1500);
      return true;
    }
  }

  if (safe && appName.includes(':')) {
    if (winStart(appName)) {
      await sleep(1000);
      return true;
    }
  }

  if (safe && /^[\w .-]+$/.test(appName) && (await appPathsHas(appName))) {
    if (winStart(appName)) {
      await sleep(1500);
      return true;
    }
  }

  const hit = await findStartApp(appName);
  if (hit && launchDetached('explorer.exe', [`shell:AppsFolder\\${hit.appId}`])) {
    console.log(`[open_app] Start menu entry: ${hit.name}`);
    await sleep(1500);
    return true;
  }

  // Mark's last resort: type the name into Start search.
  try {
    await native.press('win');
    await sleep(700);
    await native.typeText(appName, 50);
    await sleep(900);
    await native.press('enter');
    await sleep(2500);
    return true;
  } catch (e) {
    console.warn(`[open_app] Start Menu search failed: ${e.message || e}`);
  }
  return false;
}

// ── macOS ────────────────────────────────────────────────────────────────────
async function launchMacos(appName) {
  if ((await run('open', ['-a', appName], { timeout: 8000 })).ok) {
    await sleep(1000);
    return true;
  }
  if ((await run('open', ['-a', `${appName}.app`], { timeout: 8000 })).ok) {
    await sleep(1000);
    return true;
  }
  const binary = which(appName) || which(appName.toLowerCase());
  if (binary && launchDetached(binary, [])) {
    await sleep(1000);
    return true;
  }
  try {
    await native.hotkey('command', 'space');
    await sleep(600);
    await native.typeText(appName, 50);
    await sleep(800);
    await native.press('enter');
    await sleep(1500);
    return true;
  } catch (e) {
    console.warn(`[open_app] Spotlight failed: ${e.message || e}`);
  }
  return false;
}

// ── Linux ────────────────────────────────────────────────────────────────────
const LINUX_TERMINAL_FALLBACKS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal',
  'xterm', 'lxterminal', 'mate-terminal', 'tilix', 'alacritty', 'kitty'];

async function launchLinux(appName) {
  if (['x-terminal-emulator', 'gnome-terminal', 'terminal'].includes(appName)) {
    for (const term of LINUX_TERMINAL_FALLBACKS) {
      if (which(term) && launchDetached(term, [])) {
        await sleep(1000);
        return true;
      }
    }
  }
  // "libreoffice --writer": the alias carries arguments.
  const [bin, ...args] = appName.split(/\s+/);
  const binary =
    which(appName) || which(appName.toLowerCase()) || which(appName.toLowerCase().replace(/ /g, '-')) ||
    which(appName.toLowerCase().replace(/ /g, '_')) || (args.length ? which(bin) : '');
  if (binary && launchDetached(binary, binary === which(bin) && args.length ? args : [])) {
    await sleep(1000);
    return true;
  }
  const x = await run('xdg-open', [appName], { timeout: 5000 });
  if (!/ENOENT/.test(x.stderr)) return true;
  for (const desktopName of [appName.toLowerCase(), appName.toLowerCase().replace(/ /g, '-'), appName.toLowerCase().replace(/ /g, '')]) {
    if ((await run('gtk-launch', [desktopName], { timeout: 5000 })).ok) return true;
  }
  return false;
}

const OS_LAUNCHERS = { Windows: launchWindows, Darwin: launchMacos, Linux: launchLinux };

async function openApp(parameters, ctx) {
  const appName = String((parameters || {}).app_name || '').trim();
  if (!appName) return 'No application name provided.';

  const launcher = OS_LAUNCHERS[SYSTEM];
  if (!launcher) return `Unsupported operating system: ${SYSTEM}`;

  const normalized = normalize(appName);
  console.log(`[open_app] Launching: '${appName}' → '${normalized}' (${SYSTEM})`);
  ctx?.ui?.log?.(`[open_app] ${appName}`);

  try {
    if (await launcher(normalized)) return `Opened ${appName}.`;
    if (normalized.toLowerCase() !== appName.toLowerCase()) {
      if (await launcher(appName)) return `Opened ${appName}.`;
    }
    return `Could not confirm that ${appName} launched. It may still be loading, or it might not be installed.`;
  } catch (e) {
    console.warn(`[open_app] Error: ${e.message || e}`);
    return `Failed to open ${appName}: ${e.message || e}`;
  }
}

module.exports = {
  TOOL: {
    name: 'open_app',
    description:
      'Opens any application on the computer. Use this whenever the user asks to open, launch, or start any app, website, or program. Always call this tool — never just say you opened it.',
    parameters: {
      type: 'OBJECT',
      properties: {
        app_name: {
          type: 'STRING',
          description: "Exact name of the application (e.g. 'WhatsApp', 'Chrome', 'Spotify')",
        },
      },
      required: ['app_name'],
    },
  },
  run: openApp,
  normalize,
  findStartApp,
  APP_ALIASES,
};
