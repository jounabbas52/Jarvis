// browser_control — the Node port of actions/browser_control.py.
//
// Two ways into a browser, as in Mark:
//   • Navigation (go_to / search / new_tab) opens the user's OWN browser
//     natively — their profile, accounts and start page — unless an
//     automation session is already running, in which case it continues there
//     so multi-step tasks are not split across windows.
//   • Interactive actions (click / type / get_text …) attach an automation
//     browser (playwright-core, persistent context on the real profile, a
//     ~/.jarvis_profiles/<name> profile when the real one is locked), which
//     first resumes the last natively-opened page.
//
// playwright-core ships no browsers, so automation drives installed ones:
// Chrome and Edge through their channels, others by executable path. When a
// browser cannot be automated (Firefox/Safari need Playwright's own builds),
// the session falls back to Chrome, then Edge.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run: runProc, launchDetached } = require('../util/ps');

const OS = { win32: 'Windows', darwin: 'Darwin' }[process.platform] || 'Linux';
const HOME = os.homedir();
const JARVIS_PROFILES = path.join(HOME, '.jarvis_profiles');

const exists = (p) => {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
};

/**
 * Bare words like "instagram" → https://instagram.com, domains get https://,
 * full URLs pass through.
 */
function normalizeUrl(url) {
  url = String(url || '').trim();
  if (!url) return 'about:blank';
  if (url.includes('://')) return url;
  if (!url.includes('.')) url += '.com';
  return `https://${url}`;
}

/** shutil.which */
function which(name) {
  const exts = OS === 'Windows' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + (ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ''));
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

// ── Profiles ─────────────────────────────────────────────────────────────────
function realProfileDir(browser) {
  const local = process.env.LOCALAPPDATA || '';
  const roam = process.env.APPDATA || '';
  let m = {};
  if (OS === 'Windows') {
    m = {
      chrome: [path.join(local, 'Google', 'Chrome', 'User Data')],
      edge: [path.join(local, 'Microsoft', 'Edge', 'User Data')],
      brave: [path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
      vivaldi: [path.join(local, 'Vivaldi', 'User Data')],
      opera: [path.join(roam, 'Opera Software', 'Opera Stable'), path.join(local, 'Opera Software', 'Opera Stable')],
      operagx: [
        path.join(roam, 'Opera Software', 'Opera GX Stable'),
        path.join(local, 'Opera Software', 'Opera GX Stable'),
      ],
    };
  } else if (OS === 'Darwin') {
    const lib = path.join(HOME, 'Library', 'Application Support');
    m = {
      chrome: [path.join(lib, 'Google', 'Chrome')],
      edge: [path.join(lib, 'Microsoft Edge')],
      brave: [path.join(lib, 'BraveSoftware', 'Brave-Browser')],
      vivaldi: [path.join(lib, 'Vivaldi')],
      opera: [path.join(lib, 'com.operasoftware.Opera')],
      operagx: [path.join(lib, 'com.operasoftware.OperaGX')],
    };
  } else {
    const cfg = path.join(HOME, '.config');
    m = {
      chrome: [path.join(cfg, 'google-chrome'), path.join(cfg, 'chromium')],
      edge: [path.join(cfg, 'microsoft-edge')],
      brave: [path.join(cfg, 'BraveSoftware', 'Brave-Browser')],
      vivaldi: [path.join(cfg, 'vivaldi')],
      opera: [path.join(cfg, 'opera')],
      operagx: [path.join(cfg, 'opera-gx')],
    };
  }
  for (const p of m[browser] || []) {
    if (exists(p)) {
      console.log(`[Browser] ✅ Real profile found for ${browser}: ${p}`);
      return p;
    }
  }
  const fallback = path.join(JARVIS_PROFILES, browser);
  fs.mkdirSync(fallback, { recursive: true });
  console.log(`[Browser] ⚠️  Real profile not found for ${browser}, using: ${fallback}`);
  return fallback;
}

function firefoxProfileDir() {
  let base;
  if (OS === 'Windows') base = path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox');
  else if (OS === 'Darwin') base = path.join(HOME, 'Library', 'Application Support', 'Firefox');
  else base = path.join(HOME, '.mozilla', 'firefox');

  const ini = path.join(base, 'profiles.ini');
  if (!exists(ini)) return null;
  let current = {};
  let defaultPath = null;
  const take = () => {
    const p = current.Path || '';
    if (p && current.Default === '1') {
      defaultPath = (current.IsRelative || '1') === '1' ? path.join(base, p) : p;
    }
  };
  for (let line of fs.readFileSync(ini, 'utf-8').split(/\r?\n/)) {
    line = line.trim();
    if (line.startsWith('[')) {
      take();
      current = {};
    } else if (line.includes('=')) {
      const i = line.indexOf('=');
      current[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  take();
  if (defaultPath && exists(defaultPath)) {
    console.log(`[Browser] Firefox real profile: ${defaultPath}`);
    return defaultPath;
  }
  return null;
}

// ── Windows registry lookups ─────────────────────────────────────────────────
async function regDefault(hive, keyPath) {
  const r = await runProc('reg.exe', ['query', `${hive}\\${keyPath}`, '/ve'], { timeout: 5_000 });
  if (!r.ok) return null;
  const m = r.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
  return m ? m[1].trim() : null;
}

const exeFromCommand = (val) =>
  String(val || '')
    .trim()
    .replace(/^"/, '')
    .split('"')[0]
    .split(' --')[0]
    .trim();

async function findExeWindowsKeys(keys) {
  for (const key of keys) {
    for (const hive of ['HKLM', 'HKCU']) {
      const val = await regDefault(hive, key);
      const exe = val ? exeFromCommand(val) : '';
      if (exe && exists(exe)) return exe;
    }
  }
  return null;
}

async function findOperaWindows() {
  const local = process.env.LOCALAPPDATA || '';
  const prog = process.env.PROGRAMFILES || '';
  const prog86 = process.env['PROGRAMFILES(X86)'] || '';
  for (const p of [
    path.join(local, 'Programs', 'Opera', 'opera.exe'),
    path.join(local, 'Programs', 'Opera GX', 'opera.exe'),
    path.join(prog, 'Opera', 'opera.exe'),
    path.join(prog86, 'Opera', 'opera.exe'),
  ]) {
    if (exists(p)) {
      console.log(`[Browser] Opera found at: ${p}`);
      return p;
    }
  }
  const exe = await findExeWindowsKeys([
    'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\opera.exe',
    'SOFTWARE\\Clients\\StartMenuInternet\\OperaStable\\shell\\open\\command',
    'SOFTWARE\\Clients\\StartMenuInternet\\OperaGXStable\\shell\\open\\command',
    'SOFTWARE\\Clients\\StartMenuInternet\\opera\\shell\\open\\command',
  ]);
  if (exe) {
    console.log(`[Browser] Opera found via registry: ${exe}`);
    return exe;
  }
  return which('opera');
}

function findExeWindows(progName) {
  return findExeWindowsKeys([
    `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${progName}.exe`,
    `SOFTWARE\\Clients\\StartMenuInternet\\${progName}\\shell\\open\\command`,
  ]);
}

// ── Browser specs ────────────────────────────────────────────────────────────
const BROWSER_SPECS = {
  Windows: {
    chrome: { engine: 'chromium', channel: 'chrome', bins: [] },
    edge: { engine: 'chromium', channel: 'msedge', bins: [] },
    firefox: { engine: 'firefox', channel: null, bins: ['firefox.exe'] },
    opera: { engine: 'chromium', channel: null, bins: ['opera.exe'], special: 'opera_windows' },
    operagx: { engine: 'chromium', channel: null, bins: [], special: 'opera_windows' },
    brave: { engine: 'chromium', channel: null, bins: ['brave.exe'] },
    vivaldi: { engine: 'chromium', channel: null, bins: ['vivaldi.exe'] },
    safari: null,
  },
  Darwin: {
    chrome: { engine: 'chromium', channel: 'chrome', bins: [] },
    edge: { engine: 'chromium', channel: 'msedge', bins: ['microsoft-edge'] },
    firefox: { engine: 'firefox', channel: null, bins: ['firefox'] },
    opera: { engine: 'chromium', channel: null, bins: ['opera'] },
    operagx: { engine: 'chromium', channel: null, bins: ['opera'] },
    brave: { engine: 'chromium', channel: null, bins: ['brave browser', 'brave'] },
    vivaldi: { engine: 'chromium', channel: null, bins: ['vivaldi'] },
    safari: { engine: 'webkit', channel: null, bins: [] },
  },
  Linux: {
    chrome: {
      engine: 'chromium',
      channel: null,
      bins: ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'],
    },
    edge: { engine: 'chromium', channel: null, bins: ['microsoft-edge', 'microsoft-edge-stable'] },
    firefox: { engine: 'firefox', channel: null, bins: ['firefox'] },
    opera: { engine: 'chromium', channel: null, bins: ['opera', 'opera-stable'] },
    operagx: { engine: 'chromium', channel: null, bins: ['opera', 'opera-stable'] },
    brave: { engine: 'chromium', channel: null, bins: ['brave-browser', 'brave'] },
    vivaldi: { engine: 'chromium', channel: null, bins: ['vivaldi-stable', 'vivaldi'] },
    safari: null,
  },
};

const ALIASES = {
  'google chrome': 'chrome',
  'google-chrome': 'chrome',
  'microsoft edge': 'edge',
  'ms edge': 'edge',
  msedge: 'edge',
  'mozilla firefox': 'firefox',
  'opera gx': 'operagx',
  opera_gx: 'operagx',
};

const canon = (name) => {
  const n = String(name || '').toLowerCase().trim();
  return ALIASES[n] || n;
};

async function resolveBrowser(name) {
  name = canon(name);
  const spec = (BROWSER_SPECS[OS] || {})[name];
  if (!spec) return null;
  const { engine, channel, bins = [] } = spec;
  let exe = null;

  if (spec.special === 'opera_windows') {
    exe = await findOperaWindows();
    if (!exe) console.log('[Browser] ⚠️  Opera executable not found on Windows.');
    return { engine, exe, channel };
  }
  for (const b of bins) {
    const found = which(b);
    if (found) {
      exe = found;
      break;
    }
  }
  if (!exe && OS === 'Darwin') {
    const appNames = {
      chrome: ['Google Chrome.app'],
      edge: ['Microsoft Edge.app'],
      firefox: ['Firefox.app'],
      opera: ['Opera.app', 'Opera GX.app'],
      brave: ['Brave Browser.app'],
      vivaldi: ['Vivaldi.app'],
    };
    for (const app of appNames[name] || []) {
      const dir = path.join('/Applications', app, 'Contents', 'MacOS');
      if (exists(dir)) {
        const found = fs.readdirSync(dir);
        if (found.length) {
          exe = path.join(dir, found[0]);
          break;
        }
      }
    }
  }
  if (!exe && OS === 'Windows' && !channel) exe = await findExeWindows(name);
  return { engine, exe, channel };
}

async function detectDefaultBrowser() {
  try {
    if (OS === 'Windows') {
      const r = await runProc(
        'reg.exe',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId'],
        { timeout: 5_000 },
      );
      const m = r.stdout.match(/ProgId\s+REG_SZ\s+(.+)/i);
      const progId = m ? m[1].trim().toLowerCase() : '';
      for (const kw of ['edge', 'firefox', 'opera', 'brave', 'vivaldi', 'chrome']) if (progId.includes(kw)) return kw;
    } else if (OS === 'Darwin') {
      const r = await runProc(
        'defaults',
        ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers'],
        { timeout: 5_000 },
      );
      const out = r.stdout.toLowerCase();
      for (const kw of ['firefox', 'opera', 'brave', 'vivaldi', 'safari', 'chrome', 'edge']) if (out.includes(kw)) return kw;
    } else {
      const r = await runProc('xdg-settings', ['get', 'default-web-browser'], { timeout: 5_000 });
      const out = r.stdout.toLowerCase();
      for (const kw of ['firefox', 'opera', 'brave', 'vivaldi', 'chrome', 'edge']) if (out.includes(kw)) return kw;
    }
  } catch {
    /* fall through */
  }
  return 'chrome';
}

const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  yandex: 'https://yandex.com/search/?text=',
};

const MAC_APP_NAMES = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  firefox: 'Firefox',
  opera: 'Opera',
  operagx: 'Opera GX',
  brave: 'Brave Browser',
  vivaldi: 'Vivaldi',
  safari: 'Safari',
};

// Windows registry lookup names for browsers whose spec has no explicit binary
const WIN_EXE_HINTS = { chrome: 'chrome', edge: 'msedge' };

/**
 * Open the user's REAL browser normally — their profile, accounts and
 * extensions; no automation attaches. With no URL the browser starts on its
 * own start page, as if the user had opened it.
 */
async function openNative(url, browserName) {
  url = url && String(url).trim() ? normalizeUrl(url) : '';
  if (url === 'about:blank') url = '';

  let name = null;
  if (browserName) name = canon(browserName);
  else if (!url) name = await detectDefaultBrowser(); // only a window will open; needs an exe

  if (name) {
    if (OS === 'Darwin') {
      const app = MAC_APP_NAMES[name];
      if (app) {
        const r = await runProc('open', ['-a', app, ...(url ? [url] : [])], { timeout: 10_000 });
        if (r.ok) return url ? `Opened in ${name}: ${url}` : `Opened ${name}.`;
        console.log(`[Browser] 'open -a ${app}' failed (${r.stderr.trim()}), trying binary…`);
      }
    }
    const spec = await resolveBrowser(name);
    let exe = spec ? spec.exe : null;
    if (!exe && OS === 'Windows') {
      exe = name === 'opera' || name === 'operagx' ? await findOperaWindows() : await findExeWindows(WIN_EXE_HINTS[name] || name);
    }
    if (exe) {
      if (launchDetached(exe, url ? [url] : [])) return url ? `Opened in ${name}: ${url}` : `Opened ${name}.`;
      console.log(`[Browser] Native launch failed for ${name}`);
    }
    console.log(`[Browser] '${name}' not found — falling back to default browser.`);
  }

  if (!url) return 'Could not find a browser to open.';

  // Default browser via the OS — exactly like the user clicking a link.
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return `Opened in your default browser: ${url}`;
  } catch {
    const r =
      OS === 'Windows'
        ? await runProc('explorer.exe', [url], { timeout: 10_000 })
        : await runProc(OS === 'Darwin' ? 'open' : 'xdg-open', [url], { timeout: 10_000 });
    // explorer.exe exits 1 even on success, so only a spawn error counts.
    if (r.ok || OS === 'Windows') return `Opened in your default browser: ${url}`;
    return `Could not open a browser for: ${url}`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTimeout = (e) => e && (e.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(String(e.message)));

class BrowserSession {
  constructor(browserName) {
    this.browserName = browserName;
    this.spec = undefined; // resolved lazily (registry lookups are async)
    this.context = null;
    this.page = null;
    this.launching = null;
  }

  async adoptPage() {
    // The persistent context already opens a tab; use it instead of adding
    // an about:blank one.
    await sleep(300);
    const pages = this.context.pages();
    return pages[0] || (await this.context.newPage());
  }

  async launch() {
    if (this.context) return;
    // Two actions arriving together share one launch.
    this.launching ||= this.doLaunch().finally(() => {
      this.launching = null;
    });
    await this.launching;
  }

  async doLaunch() {
    if (this.spec === undefined) this.spec = await resolveBrowser(this.browserName);
    if (!this.spec) throw new Error(`'${this.browserName}' is not supported on this platform (${OS}).`);
    const pw = require('playwright-core');
    const { engine, exe, channel } = this.spec;
    const base = { headless: false, viewport: null, timeout: 25_000 };

    const onClose = (ctx) =>
      ctx.on('close', () => {
        if (this.context === ctx) this.context = this.page = null;
      });

    if (engine === 'firefox' || engine === 'webkit') {
      // These need Playwright's patched builds, which playwright-core does not
      // download; try, then fall back to an installed Chromium browser.
      try {
        const profile =
          engine === 'firefox'
            ? firefoxProfileDir() || path.join(JARVIS_PROFILES, 'firefox')
            : path.join(JARVIS_PROFILES, 'safari');
        fs.mkdirSync(profile, { recursive: true });
        const opts = { ...base };
        if (exe && engine === 'firefox') opts.executablePath = exe;
        try {
          this.context = await pw[engine].launchPersistentContext(profile, opts);
        } catch (e) {
          if (engine !== 'firefox') throw e;
          console.log(`[Browser] Firefox real profile failed (${e.message.split('\n')[0]}), using JARVIS profile`);
          const jarvis = path.join(JARVIS_PROFILES, 'firefox_jarvis');
          fs.mkdirSync(jarvis, { recursive: true });
          this.context = await pw.firefox.launchPersistentContext(jarvis, opts);
        }
        onClose(this.context);
        this.page = await this.adoptPage();
        console.log(`[Browser] ✅ ${engine === 'firefox' ? 'Firefox' : 'Safari'} launched`);
        return;
      } catch (e) {
        console.log(`[Browser] ⚠️  ${this.browserName} cannot be automated here (${String(e.message).split('\n')[0]}) — using Chrome/Edge`);
        return this.launchChromiumFallback(pw, base, onClose);
      }
    }

    const args = [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--disable-default-apps',
      '--no-default-browser-check',
    ];
    const opts = { ...base, args };
    if (exe) opts.executablePath = exe;
    else if (channel) opts.channel = channel;
    const label = `${this.browserName}${channel ? `/${channel}` : ''}${exe ? ` @ ${exe}` : ''}`;

    const profile = realProfileDir(this.browserName);
    try {
      this.context = await pw.chromium.launchPersistentContext(profile, opts);
      onClose(this.context);
      this.page = await this.adoptPage();
      console.log(`[Browser] ✅ Launched [${label}] profile=${profile}`);
      return;
    } catch (e) {
      console.log(`[Browser] ⚠️  Real profile failed for ${label}: ${String(e.message).split('\n')[0]}`);
    }

    // The real profile could not be opened (browser already open / locked
    // profile / newer Chrome blocks the real profile under automation). Fall
    // back to a persistent JARVIS automation profile — sign-ins made there
    // persist across sessions.
    const jarvisProfile = path.join(JARVIS_PROFILES, this.browserName);
    fs.mkdirSync(jarvisProfile, { recursive: true });
    console.log(`[Browser] Retrying with JARVIS profile: ${jarvisProfile}`);
    try {
      this.context = await pw.chromium.launchPersistentContext(jarvisProfile, opts);
      onClose(this.context);
      this.page = await this.adoptPage();
      console.log(`[Browser] ✅ Launched [${label}] with JARVIS profile (sign-ins persist across sessions)`);
    } catch (e2) {
      // The browser itself is missing or broken: Chrome → Edge.
      if (this.browserName !== 'edge') {
        console.log(`[Browser] ${label} failed (${String(e2.message).split('\n')[0]}) — trying Chrome/Edge`);
        try {
          return await this.launchChromiumFallback(pw, base, onClose);
        } catch {
          /* report the original failure */
        }
      }
      throw new Error(`Could not launch ${this.browserName}: ${String(e2.message).split('\n')[0]}`);
    }
  }

  /** Installed Chrome, then Edge, on a JARVIS profile. */
  async launchChromiumFallback(pw, base, onClose) {
    let last = null;
    for (const channel of ['chrome', 'msedge']) {
      if (channel === 'chrome' && this.browserName === 'chrome') continue;
      const profile = path.join(JARVIS_PROFILES, channel === 'chrome' ? 'chrome' : 'edge');
      fs.mkdirSync(profile, { recursive: true });
      try {
        this.context = await pw.chromium.launchPersistentContext(profile, {
          ...base,
          channel,
          args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
        });
        onClose(this.context);
        this.page = await this.adoptPage();
        console.log(`[Browser] ✅ Launched fallback [${channel}] for ${this.browserName}`);
        return;
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`Could not launch ${this.browserName}: ${String(last?.message || last).split('\n')[0]}`);
  }

  async getPage() {
    await this.launch();
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      await sleep(200);
    }
    return this.page;
  }

  async goTo(url) {
    url = normalizeUrl(url);
    const page = await this.getPage();
    const prevUrl = page.url();
    const blank = (u) => !u || u === 'about:blank';

    const doGoto = async (p) => {
      try {
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(300);
      } catch (e) {
        // A timeout may still have partially loaded — check the URL below.
        if (!isTimeout(e)) console.log(`[Browser] goto exception (non-fatal): ${String(e.message).split('\n')[0]}`);
      }
      return p.url();
    };

    let resultUrl = await doGoto(page);
    if ((blank(resultUrl) || resultUrl === prevUrl) && blank(prevUrl)) {
      console.log(`[Browser] Still blank after goto — retrying on new tab: ${url}`);
      try {
        const np = await this.context.newPage();
        this.page = np;
        resultUrl = await doGoto(np);
      } catch (e) {
        console.log(`[Browser] New-tab retry failed: ${e.message}`);
      }
    }
    if (!blank(resultUrl)) return `Opened: ${resultUrl}`;
    return `Could not open: ${url}`;
  }

  search(query, engine = 'google') {
    const base = SEARCH_ENGINES[String(engine || 'google').toLowerCase()] || SEARCH_ENGINES.google;
    return this.goTo(base + String(query || '').replace(/ /g, '+'));
  }

  async click(selector, text) {
    const page = await this.getPage();
    try {
      if (text) {
        await page.getByText(text, { exact: false }).first().click({ timeout: 8_000 });
        return `Clicked text: '${text}'`;
      }
      if (selector) {
        await page.click(selector, { timeout: 8_000 });
        return `Clicked selector: ${selector}`;
      }
      return 'No selector or text provided.';
    } catch (e) {
      if (isTimeout(e)) return 'Element not found (timeout).';
      return `Click error: ${e.message}`;
    }
  }

  async typeText(selector, text = '', clearFirst = true) {
    const page = await this.getPage();
    try {
      const el = selector ? page.locator(selector).first() : page.locator(':focus');
      if (clearFirst) await el.clear();
      await el.pressSequentially(String(text), { delay: 50 });
      return 'Text typed.';
    } catch (e) {
      return `Type error: ${e.message}`;
    }
  }

  async scroll(direction = 'down', amount = 500) {
    const page = await this.getPage();
    try {
      await page.mouse.wheel(0, direction === 'down' ? amount : -amount);
      return `Scrolled ${direction}.`;
    } catch (e) {
      return `Scroll error: ${e.message}`;
    }
  }

  async press(key) {
    const page = await this.getPage();
    try {
      await page.keyboard.press(key);
      return `Pressed: ${key}`;
    } catch (e) {
      return `Key error: ${e.message}`;
    }
  }

  async getText() {
    const page = await this.getPage();
    try {
      return (await page.innerText('body')).slice(0, 4_000);
    } catch (e) {
      return `Could not get page text: ${e.message}`;
    }
  }

  async getUrl() {
    return (await this.getPage()).url();
  }

  async fillForm(fields) {
    const page = await this.getPage();
    const results = [];
    for (const [selector, value] of Object.entries(fields || {})) {
      try {
        const el = page.locator(selector).first();
        await el.clear();
        await el.pressSequentially(String(value), { delay: 40 });
        results.push(`✓ ${selector}`);
      } catch (e) {
        results.push(`✗ ${selector}: ${String(e.message).split('\n')[0]}`);
      }
    }
    return `Form filled: ${results.join(', ')}`;
  }

  async smartClick(description) {
    const page = await this.getPage();
    for (const role of ['button', 'link', 'searchbox', 'textbox', 'menuitem', 'tab']) {
      try {
        const loc = page.getByRole(role, { name: description });
        if ((await loc.count()) > 0) {
          await loc.first().click({ timeout: 5_000 });
          return `Clicked (${role}): '${description}'`;
        }
      } catch {
        /* next role */
      }
    }
    for (const attempt of [
      () => page.getByText(description, { exact: false }).first().click({ timeout: 5_000 }),
      () => page.getByPlaceholder(description, { exact: false }).first().click({ timeout: 5_000 }),
      () =>
        page
          .locator(`[alt*="${description}" i],[title*="${description}" i],[aria-label*="${description}" i]`)
          .first()
          .click({ timeout: 5_000 }),
    ]) {
      try {
        await attempt();
        return `Clicked: '${description}'`;
      } catch {
        /* next strategy */
      }
    }
    return `Could not find element: '${description}'`;
  }

  async smartType(description, text) {
    const page = await this.getPage();
    const candidates = [
      ['placeholder', page.getByPlaceholder(description, { exact: false })],
      ['label', page.getByLabel(description, { exact: false })],
      ['role', page.getByRole('textbox', { name: description })],
      ['searchbox', page.getByRole('searchbox')],
      ['combobox', page.getByRole('combobox', { name: description })],
    ];
    for (const [method, loc] of candidates) {
      try {
        const el = loc.first();
        if ((await el.count()) === 0) continue;
        await el.clear();
        await el.pressSequentially(String(text), { delay: 50 });
        return `Typed into (${method}): '${description}'`;
      } catch {
        /* next candidate */
      }
    }
    return `Could not find input: '${description}'`;
  }

  async newTab(url = '') {
    const page = await this.getPage();
    this.page = await page.context().newPage();
    if (url) return this.goTo(url);
    return 'New tab opened.';
  }

  async closeTab() {
    const page = this.page;
    if (page && !page.isClosed()) {
      const ctx = page.context();
      await page.close();
      const pages = ctx.pages();
      this.page = pages.length ? pages[pages.length - 1] : null;
      return 'Tab closed.';
    }
    return 'No active tab to close.';
  }

  async screenshot(savePath) {
    const page = await this.getPage();
    try {
      const p = savePath || path.join(HOME, 'Desktop', 'jarvis_screenshot.png');
      await page.screenshot({ path: p, fullPage: false });
      return `Screenshot saved: ${p}`;
    } catch (e) {
      return `Screenshot error: ${e.message}`;
    }
  }

  async back() {
    const page = await this.getPage();
    try {
      await page.goBack({ timeout: 10_000 });
      return `Navigated back: ${page.url()}`;
    } catch (e) {
      return `Back error: ${e.message}`;
    }
  }

  async forward() {
    const page = await this.getPage();
    try {
      await page.goForward({ timeout: 10_000 });
      return `Navigated forward: ${page.url()}`;
    } catch (e) {
      return `Forward error: ${e.message}`;
    }
  }

  async reload() {
    const page = await this.getPage();
    try {
      await page.reload({ timeout: 15_000 });
      return `Page reloaded: ${page.url()}`;
    } catch (e) {
      return `Reload error: ${e.message}`;
    }
  }

  async close() {
    const ctx = this.context;
    this.context = this.page = null;
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        /* already gone */
      }
    }
  }
}

/** All active browser sessions. */
class SessionRegistry {
  constructor() {
    this.sessions = new Map();
    this.activeBrowser = '';
    this.lastNativeUrl = '';
  }

  has(browserName) {
    if (!browserName) return this.sessions.size > 0;
    return this.sessions.has(canon(browserName));
  }

  noteNativeUrl(url) {
    this.lastNativeUrl = url;
  }

  /** The last natively-opened URL, once (consumed to avoid repeats). */
  popNativeUrl() {
    const url = this.lastNativeUrl;
    this.lastNativeUrl = '';
    return url;
  }

  getOrCreate(name) {
    if (!this.sessions.has(name)) {
      this.sessions.set(name, new BrowserSession(name));
      console.log(`[Registry] New session: ${name}`);
    }
    return this.sessions.get(name);
  }

  async get(browserName) {
    const name = canon(browserName || this.activeBrowser || (await detectDefaultBrowser()));
    const sess = this.getOrCreate(name);
    this.activeBrowser = name;
    return sess;
  }

  switch(browserName) {
    const name = canon(browserName);
    this.getOrCreate(name);
    this.activeBrowser = name;
    return `Active browser → ${name}`;
  }

  async closeOne(browserName) {
    const sess = this.sessions.get(browserName);
    if (sess) {
      this.sessions.delete(browserName);
      await sess.close();
      if (this.activeBrowser === browserName) this.activeBrowser = '';
      return `${browserName} closed.`;
    }
    return `No active session for: ${browserName}`;
  }

  async closeAll() {
    const names = [...this.sessions.keys()];
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.activeBrowser = '';
    for (const s of sessions) {
      try {
        await s.close();
      } catch {
        /* keep closing the rest */
      }
    }
    return `All browsers closed: ${names.length ? names.join(', ') : 'none'}`;
  }

  listSessions() {
    if (!this.sessions.size) return 'No active browser sessions.';
    const lines = [...this.sessions.keys()].map((n) => `  • ${n}${n === this.activeBrowser ? ' ◀ active' : ''}`);
    return `Open browsers:\n${lines.join('\n')}`;
  }
}

const registry = new SessionRegistry();

/** Mark's sess.run(coro, timeout=60). */
function bounded(promise, action, ms = 60_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(`Browser action '${action}' timed out (60s).`), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function browserControl(parameters, ctx) {
  const params = parameters || {};
  const action = String(params.action || '').toLowerCase().trim();
  const browser = String(params.browser || '').toLowerCase().trim() || null;
  let result = 'Unknown action.';
  const log = (text) => {
    const short = String(text).slice(0, 80);
    console.log(`[Browser] ${short}`);
    ctx?.ui?.log(`[browser] ${short.slice(0, 60)}`);
  };

  if (action === 'switch') {
    const target = browser || String(params.target || '').toLowerCase().trim();
    result = target ? registry.switch(target) : 'Please specify a browser.';
    log(result);
    return result;
  }
  if (action === 'list_browsers') {
    result = registry.listSessions();
    log(result);
    return result;
  }
  if (action === 'close_all') {
    result = await registry.closeAll();
    log(result);
    return result;
  }
  if (action === 'close') {
    const target = browser ? canon(browser) : registry.activeBrowser;
    result = target ? await registry.closeOne(target) : 'No browser specified.';
    log(result);
    return result;
  }

  // ── Navigation is ALWAYS native, unless an automation flow is running ─────
  if (['go_to', 'search', 'new_tab'].includes(action)) {
    if (registry.has(browser)) {
      const sess = await registry.get(browser);
      try {
        if (action === 'search') result = await bounded(sess.search(params.query || '', params.engine || 'google'), action);
        else if (action === 'new_tab') result = await bounded(sess.newTab(params.url || ''), action);
        else result = await bounded(sess.goTo(params.url || ''), action);
      } catch (e) {
        result = `Browser error (${action}): ${e?.message || e}`;
      }
      log(result);
      return result;
    }

    let navUrl;
    if (action === 'search') {
      const base = SEARCH_ENGINES[String(params.engine || 'google').toLowerCase()] || SEARCH_ENGINES.google;
      navUrl = base + String(params.query || '').replace(/ /g, '+');
    } else {
      navUrl = String(params.url || '').trim();
    }
    result = await openNative(navUrl, browser);
    if (result.startsWith('Opened') && navUrl) registry.noteNativeUrl(normalizeUrl(navUrl));
    log(result);
    return result;
  }

  // ── Interactive actions (click/type/read…) ───────────────────────────────
  // These need a controllable browser; the automation window opens here and
  // first goes to the user's last navigated page instead of sitting blank.
  let sess;
  try {
    sess = await registry.get(browser);
  } catch (e) {
    result = `Could not start browser session: ${e?.message || e}`;
    log(result);
    return result;
  }

  try {
    const last = registry.popNativeUrl();
    if (last) {
      try {
        await bounded(sess.goTo(last), 'go_to');
      } catch (e) {
        console.log(`[Browser] Could not resume last page (${last}): ${e?.message || e}`);
      }
    }
    const p = params;
    const ops = {
      click: () => sess.click(p.selector, p.text),
      type: () => sess.typeText(p.selector, p.text || '', p.clear_first ?? true),
      scroll: () => sess.scroll(p.direction || 'down', parseInt(p.amount ?? 500, 10) || 500),
      fill_form: () => sess.fillForm(p.fields || {}),
      smart_click: () => sess.smartClick(p.description || ''),
      smart_type: () => sess.smartType(p.description || '', p.text || ''),
      get_text: () => sess.getText(),
      get_url: () => sess.getUrl(),
      press: () => sess.press(p.key || 'Enter'),
      close_tab: () => sess.closeTab(),
      screenshot: () => sess.screenshot(p.path),
      back: () => sess.back(),
      forward: () => sess.forward(),
      reload: () => sess.reload(),
    };
    result = ops[action] ? await bounded(ops[action](), action) : `Unknown browser action: '${action}'`;
  } catch (e) {
    result = `Browser error (${action}): ${e?.message || e}`;
  }
  log(result);
  return result;
}

module.exports = {
  TOOL: {
    name: 'browser_control',
    description:
      "Controls any web browser. Use for: opening websites, searching the web, clicking elements, filling forms, scrolling, screenshots, navigation, any web-based task. Simple open/search requests launch the user's own browser normally (their real profile and logged-in accounts); interactive actions (click, type, fill_form...) attach an automation browser. Always pass the 'browser' parameter when the user specifies a browser (e.g. 'open in Edge', 'use Firefox', 'open Chrome'). Multiple browsers can run simultaneously.",
    parameters: {
      type: 'OBJECT',
      properties: {
        action: {
          type: 'STRING',
          description:
            'go_to | search | click | type | scroll | fill_form | smart_click | smart_type | get_text | get_url | press | new_tab | close_tab | screenshot | back | forward | reload | switch | list_browsers | close | close_all',
        },
        browser: {
          type: 'STRING',
          description:
            'Target browser: chrome | edge | firefox | opera | operagx | brave | vivaldi | safari. Omit to use the currently active browser.',
        },
        url: { type: 'STRING', description: 'URL for go_to / new_tab action' },
        query: { type: 'STRING', description: 'Search query for search action' },
        engine: { type: 'STRING', description: 'Search engine: google | bing | duckduckgo | yandex (default: google)' },
        selector: { type: 'STRING', description: 'CSS selector for click/type' },
        text: { type: 'STRING', description: 'Text to click or type' },
        description: { type: 'STRING', description: 'Element description for smart_click/smart_type' },
        direction: { type: 'STRING', description: 'up | down for scroll' },
        amount: { type: 'INTEGER', description: 'Scroll amount in pixels (default: 500)' },
        key: { type: 'STRING', description: 'Key name for press action (e.g. Enter, Escape, F5)' },
        path: { type: 'STRING', description: 'Save path for screenshot' },
        incognito: { type: 'BOOLEAN', description: 'Open in private/incognito mode' },
        clear_first: { type: 'BOOLEAN', description: 'Clear field before typing (default: true)' },
      },
      required: ['action'],
    },
  },
  run: browserControl,
  // flight_finder drives the browser through this, as Mark's does.
  browserControl,
  normalizeUrl,
  closeAll: () => registry.closeAll(),
};
