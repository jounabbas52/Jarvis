// Mark LIV phone Remote Dashboard — the Node port of dashboard/server.py.
//
// An HTTPS server on the LAN (self-signed certificate, generated once per
// install) that a phone opens by scanning the QR code in the desktop HUD. The
// phone logs in with a six-character one-time key, then:
//   - sees the conversation live over /ws (the desktop broadcasts log/status),
//   - types commands (optionally AES-256-CBC encrypted with the session key),
//   - streams its microphone as 16 kHz int16 PCM over /ws/phone-audio,
//   - sends files to the computer and downloads them back.
//
// Endpoints, auth semantics and websocket message shapes are identical to Mark,
// so static/app.html and static/login.html are Mark's pages unchanged.
//
// Phone → desktop goes out on the bus: `phone` {connected}, `remote-command`
// {text}, `remote-audio` {data: base64 PCM}. Desktop → phone comes in through
// the `mark:remote-broadcast` IPC handler.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.MARK_DASHBOARD_PORT) || 8000;
const MAX_UPLOAD_MB = 500;
const KEY_EXPIRY_SECS = 600;
const STATIC_DIR = path.join(__dirname, 'dashboard', 'static');
const CRYPTOJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js';
const CRYPTOJS_FILE = path.join(STATIC_DIR, 'crypto-js.min.js');

// Look-alike characters are left out so a key read off a screen is typed right.
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').filter((c) => !'OIL01'.includes(c));

// Must match _AES_SALT in app.html: the phone derives the same key.
const AES_SALT = Buffer.from('JARVIS-DASHBOARD-v1', 'utf-8');

const say = (...a) => console.log('[Dashboard]', ...a);

// ── helpers ────────────────────────────────────────────────────────────────

function markDir() {
  try {
    return require('./config').MARK_DIR;
  } catch {
    // Outside Electron (plain node) there is no app.getPath; stay usable.
    return path.join(os.homedir(), '.jarvis-lite', 'mark');
  }
}

const certsDir = () => path.join(markDir(), 'certs');
const keyPath = () => path.join(certsDir(), 'jarvis.key');
const crtPath = () => path.join(certsDir(), 'jarvis.crt');

function makeUploadsDir() {
  const candidates = [
    path.join(os.homedir(), 'Downloads', 'JARVIS Uploads'),
    path.join(os.homedir(), 'Documents', 'JARVIS Uploads'),
    path.join(markDir(), 'uploads'),
  ];
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      return c;
    } catch {
      /* try the next one */
    }
  }
  return candidates[candidates.length - 1];
}

/** SHA-256(sessionKey‖salt) → 32-byte AES-256 key, same as CryptoJS.SHA256(key + salt). */
function deriveKey(sessionKey) {
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from(sessionKey, 'utf-8'), AES_SALT])).digest();
}

/** Decrypt base64(IV[16] ‖ ciphertext) with AES-256-CBC + PKCS7. Throws on bad input. */
function decryptCbc(aesKey, encB64) {
  const raw = Buffer.from(encB64, 'base64');
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);
  const d = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  // fatal: invalid UTF-8 is a failed decrypt, as in Mark (bytes.decode raises).
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([d.update(ct), d.final()]));
}

const tokenUrlsafe = (n = 32) => crypto.randomBytes(n).toString('base64url');

/** Best LAN-facing IPv4 address, no internet required (same three methods as Mark). */
async function localIp() {
  // Method 1: route trick — connecting a UDP socket sends nothing but makes the
  // OS pick the outgoing interface.
  const dgram = require('dgram');
  for (const probe of ['8.8.8.8', '1.1.1.1', '192.168.1.1']) {
    const ip = await new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      const done = (v) => {
        clearTimeout(t);
        try {
          s.close();
        } catch {
          /* already closed */
        }
        resolve(v);
      };
      const t = setTimeout(() => done(null), 500);
      s.on('error', () => done(null));
      try {
        s.connect(80, probe, (err) => {
          if (err) return done(null);
          try {
            done(s.address().address);
          } catch {
            done(null);
          }
        });
      } catch {
        done(null);
      }
    });
    if (ip && !ip.startsWith('127.') && ip !== '0.0.0.0') return ip;
  }

  // Methods 2+3: enumerate interfaces (fully offline). Prefer real, non
  // link-local addresses; virtual adapters come last only by accident of order.
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        const fam = typeof a.family === 'string' ? a.family : a.family === 4 ? 'IPv4' : 'IPv6';
        if (fam !== 'IPv4' || a.internal) continue;
        if (a.address.startsWith('127.') || a.address.startsWith('169.254.')) continue;
        return a.address;
      }
    }
  } catch {
    /* fall through */
  }
  return '127.0.0.1';
}

/**
 * Make sure MARK_DIR/certs holds a TLS pair, generating a self-signed one the
 * first time. Never shipped: a private key every user downloads is no key.
 * Returns true when a usable pair exists; false leaves us on plain HTTP.
 */
async function ensureCerts(lanIp) {
  if (fs.existsSync(keyPath()) && fs.existsSync(crtPath())) return true;
  let selfsigned;
  try {
    selfsigned = require('selfsigned');
  } catch {
    say('selfsigned not installed — serving over plain HTTP.');
    return false;
  }
  try {
    fs.mkdirSync(certsDir(), { recursive: true });
    // The SAN has to cover every address the phone might use: the LAN IP the QR
    // code encodes, plus localhost when testing on the machine itself.
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
    ];
    if (lanIp && !lanIp.startsWith('127.')) altNames.push({ type: 7, ip: lanIp });
    const now = Date.now();
    const pems = await selfsigned.generate(
      [
        { name: 'commonName', value: 'JARVIS Dashboard' },
        { name: 'organizationName', value: 'JARVIS' },
      ],
      {
        keyType: 'rsa',
        keySize: 2048,
        algorithm: 'sha256',
        notBeforeDate: new Date(now - 86_400_000),
        notAfterDate: new Date(now + 3650 * 86_400_000),
        extensions: [
          { name: 'basicConstraints', cA: false, critical: true },
          { name: 'subjectAltName', altNames },
        ],
      },
    );
    fs.writeFileSync(keyPath(), pems.private, { mode: 0o600 });
    fs.writeFileSync(crtPath(), pems.cert);
    say(`Generated a self-signed certificate for this machine: ${certsDir()}`);
    return true;
  } catch (e) {
    say(`Certificate generation failed (${e?.message || e}) — serving over plain HTTP.`);
    return false;
  }
}

const sslEnabled = () => fs.existsSync(keyPath()) && fs.existsSync(crtPath());

/**
 * Best effort: open the port in the OS firewall for LAN access. Runs in the
 * background, never blocks the server. One-time; a no-op when already done.
 * MARK_DASHBOARD_NO_FIREWALL=1 skips it (headless tests: no UAC dialogs).
 */
async function ensureNetworkAccess(port) {
  if (process.env.MARK_DASHBOARD_NO_FIREWALL) return;
  const { run, runPS, psQuote } = require('./util/ps');
  try {
    if (process.platform === 'win32') {
      const portRule = `JARVIS Dashboard Port ${port}`;
      const progRule = 'JARVIS Dashboard Electron';
      const exe = process.execPath;
      const ruleExists = async (name) => {
        const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`], { timeout: 5000 });
        return r.ok && !r.stdout.includes('No rules match');
      };
      const networkIsPublic = async () => {
        const r = await runPS(
          "(Get-NetConnectionProfile | Where-Object {$_.NetworkCategory -eq 'Public'} | Measure-Object).Count",
          { timeout: 6000 },
        );
        return !['', '0'].includes(r.stdout.trim());
      };
      const needPort = !(await ruleExists(portRule));
      const needProg = !(await ruleExists(progRule));
      const needPrivate = await networkIsPublic();
      if (!needPort && !needProg && !needPrivate) return;

      // One PowerShell script does all of it: run directly first (works when
      // already admin), otherwise re-launch it elevated for the UAC dialog.
      const lines = [];
      if (needPrivate) {
        lines.push(
          "Get-NetConnectionProfile | Where-Object {$_.NetworkCategory -eq 'Public'} | Set-NetConnectionProfile -NetworkCategory Private",
        );
      }
      if (needPort) {
        lines.push(
          `netsh advfirewall firewall add rule name=${psQuote(portRule)} protocol=TCP dir=in localport=${port} action=allow | Out-Null`,
        );
      }
      if (needProg) {
        lines.push(
          `netsh advfirewall firewall add rule name=${psQuote(progRule)} dir=in action=allow program=${psQuote(exe)} enable=yes | Out-Null`,
        );
      }
      lines.push('if ($LASTEXITCODE -ne 0) { exit 1 }');
      const script = lines.join('\n');
      const direct = await runPS(script, { timeout: 8000 });
      if (direct.ok) {
        say(`Firewall configured for port ${port}.`);
        return;
      }
      say('One-time network setup required.');
      say(">>> A Windows security dialog will appear — click 'Yes' <<<");
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const r = await runPS(
        `try { Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait ` +
          `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit 0 } catch { exit 1 }`,
        { timeout: 120_000 },
      );
      if (r.ok) {
        say(`Network setup complete — port ${port} is open.`);
        say('Refresh your phone browser to connect.');
      } else {
        say('Setup was not allowed.');
        say('Phone connections may fail until JARVIS is run as Administrator.');
      }
      return;
    }

    if (process.platform === 'darwin') {
      const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw';
      const st = await run(fw, ['--getglobalstate'], { timeout: 5000 });
      if (st.stdout.toLowerCase().includes('disabled')) return;
      const exe = process.execPath;
      const listed = await run(fw, ['--listapps'], { timeout: 5000 });
      if (listed.stdout.includes(exe)) return;
      say('One-time network setup — enter your password in the macOS dialog.');
      await run(
        'osascript',
        ['-e', `do shell script "${fw} --add '${exe}' && ${fw} --unblockapp '${exe}'" with administrator privileges`],
        { timeout: 60_000 },
      );
      return;
    }

    // Linux: pkexec GUI → sudo -n → print the manual command.
    const privileged = async (cmd) => {
      for (const prefix of [['pkexec'], ['sudo', '-n']]) {
        const r = await run(prefix[0], [...prefix.slice(1), ...cmd], { timeout: 30_000 });
        if (r.ok) return true;
      }
      return false;
    };
    const ufw = await run('ufw', ['status'], { timeout: 5000 });
    if (ufw.ok || ufw.stdout) {
      if (ufw.stdout.toLowerCase().includes('active') && !ufw.stdout.toLowerCase().includes('inactive')) {
        if (await privileged(['ufw', 'allow', `${port}/tcp`])) say(`ufw: port ${port} allowed.`);
        else say(`Run manually:  sudo ufw allow ${port}/tcp`);
        return;
      }
    }
    const fwd = await run('firewall-cmd', ['--state'], { timeout: 5000 });
    if (fwd.stdout.toLowerCase().includes('running')) {
      const ok =
        (await privileged(['firewall-cmd', '--add-port', `${port}/tcp`, '--permanent'])) &&
        (await privileged(['firewall-cmd', '--reload']));
      if (ok) say(`firewalld: port ${port} allowed.`);
      else say(`Run manually:  sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`);
      return;
    }
    const ipt = await run('iptables', ['-L', 'INPUT', '-n'], { timeout: 5000 });
    if (ipt.ok) {
      if (await privileged(['iptables', '-A', 'INPUT', '-p', 'tcp', '--dport', String(port), '-j', 'ACCEPT'])) {
        say(`iptables: port ${port} opened.`);
      } else {
        say(`Run manually:  sudo iptables -A INPUT -p tcp --dport ${port} -j ACCEPT`);
      }
    }
  } catch (e) {
    say(`Firewall setup error: ${e?.message || e}`);
  }
}

function readStatic(name) {
  return fs.readFileSync(path.join(STATIC_DIR, name), 'utf-8');
}

function safeFilename(raw) {
  let name = path.basename(String(raw || '').replace(/\\/g, '/'));
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  return name || 'upload';
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

function sendHtml(res, html, status = 200) {
  const body = Buffer.from(html, 'utf-8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Stream the first file part of a multipart/form-data request to `destPath`
 * without buffering it (uploads may be 500 MB). Resolves {size} or
 * {error, status}; deletes the partial file on any failure.
 */
function receiveMultipartFile(req, makeDest, maxBytes) {
  return new Promise((resolve) => {
    const ct = String(req.headers['content-type'] || '');
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!/^multipart\/form-data/i.test(ct) || !m) {
      resolve({ error: 'Expected multipart/form-data', status: 400 });
      return;
    }
    const boundary = m[1] || m[2].trim();
    const openDelim = Buffer.from(`--${boundary}`);
    const partDelim = Buffer.from(`\r\n--${boundary}`);
    const HEADER_END = Buffer.from('\r\n\r\n');

    let state = 'preamble'; // preamble → headers → body → done
    let buf = Buffer.alloc(0);
    let out = null;
    let dest = null;
    let size = 0;
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      const cleanup = () => {
        if (result.error && dest) fs.rm(dest, { force: true }, () => {});
        resolve(result);
      };
      if (out) out.end(cleanup);
      else cleanup();
      if (result.error) {
        req.unpipe?.();
        req.resume();
      }
    };

    const write = (chunk) => {
      if (!chunk.length) return;
      size += chunk.length;
      if (size > maxBytes) {
        finish({ error: `File too large (max ${MAX_UPLOAD_MB} MB)`, status: 413 });
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    };

    const process_ = () => {
      for (;;) {
        if (finished) return;
        if (state === 'preamble') {
          const i = buf.indexOf(openDelim);
          if (i < 0) return;
          buf = buf.subarray(i + openDelim.length);
          state = 'headers';
        } else if (state === 'headers') {
          const i = buf.indexOf(HEADER_END);
          if (i < 0) {
            if (buf.length > 16 * 1024) finish({ error: 'Malformed upload', status: 400 });
            return;
          }
          const headers = buf.subarray(0, i).toString('utf-8');
          buf = buf.subarray(i + HEADER_END.length);
          const disp = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] || '';
          const fnStar = /filename\*=(?:UTF-8'')?([^;\r\n]+)/i.exec(disp);
          const fn = /filename="([^"]*)"/i.exec(disp) || /filename=([^;\r\n]+)/i.exec(disp);
          if (!fn && !fnStar) {
            // Not a file field: skip to the next part.
            state = 'skip';
            continue;
          }
          let raw = fn ? fn[1] : '';
          if (fnStar) {
            try {
              raw = decodeURIComponent(fnStar[1].trim());
            } catch {
              /* keep plain filename */
            }
          }
          dest = makeDest(safeFilename(raw || 'upload'));
          try {
            out = fs.createWriteStream(dest);
          } catch (e) {
            finish({ error: String(e?.message || e), status: 500 });
            return;
          }
          out.on('error', (e) => finish({ error: String(e?.message || e), status: 500 }));
          state = 'body';
        } else if (state === 'skip') {
          const i = buf.indexOf(partDelim);
          if (i < 0) {
            if (buf.length > partDelim.length) buf = buf.subarray(buf.length - partDelim.length);
            return;
          }
          buf = buf.subarray(i + 2); // leave "--boundary" for the preamble matcher
          state = 'preamble';
        } else if (state === 'body') {
          const i = buf.indexOf(partDelim);
          if (i >= 0) {
            write(buf.subarray(0, i));
            state = 'done';
            finish({ size, name: path.basename(dest) });
            return;
          }
          // Hold back enough bytes that a delimiter split across chunks is seen.
          const keep = partDelim.length - 1;
          if (buf.length > keep) {
            write(buf.subarray(0, buf.length - keep));
            buf = Buffer.from(buf.subarray(buf.length - keep));
          }
          return;
        } else return;
      }
    };

    req.on('data', (c) => {
      if (finished) return;
      buf = buf.length ? Buffer.concat([buf, c]) : c;
      process_();
    });
    req.on('end', () => {
      if (!finished) finish({ error: state === 'preamble' ? 'No file in upload' : 'Upload incomplete', status: 400 });
    });
    req.on('error', (e) => finish({ error: String(e?.message || e), status: 500 }));
  });
}

// ── DashboardServer ────────────────────────────────────────────────────────

class DashboardServer {
  constructor({ bus, log }) {
    this.bus = bus;
    this.log = log || (() => {});
    this.ip = '127.0.0.1';
    this.tokens = new Set();
    this.tokenKeys = new Map(); // auth token → session key
    this.aesCache = new Map(); // session key → AES key bytes
    this.clients = new Set(); // /ws sockets
    this.audioSockets = new Set(); // /ws/phone-audio sockets
    this.history = [];
    this.pendingKeys = new Map(); // key → expiry (ms)
    this.deviceSessions = new Map(); // device token → {sessionKey}
    this.uploadsDir = makeUploadsDir();
    this.loginHtml = readStatic('login.html');
    this.appHtml = readStatic('app.html');
    this.servers = [];
    this.wss = null;
    this.phoneConnected = false;
  }

  // ── one-time key management ──

  newKey(expirySecs = KEY_EXPIRY_SECS) {
    const now = Date.now();
    for (const [k, exp] of this.pendingKeys) if (exp <= now) this.pendingKeys.delete(k);
    let key = '';
    for (let i = 0; i < 6; i++) key += KEY_CHARS[crypto.randomInt(KEY_CHARS.length)];
    this.pendingKeys.set(key, now + expirySecs * 1000);
    return key;
  }

  getUrl() {
    return `${sslEnabled() ? 'https' : 'http'}://${this.ip}:${PORT}`;
  }

  /** URL for manual browser entry. With HTTPS, the alias port (also HTTPS). */
  getManualUrl() {
    return sslEnabled() ? `${this.ip}:${PORT + 1}` : `${this.ip}:${PORT}`;
  }

  aesKey(sessionKey) {
    if (!this.aesCache.has(sessionKey)) this.aesCache.set(sessionKey, deriveKey(sessionKey));
    return this.aesCache.get(sessionKey);
  }

  decrypt(token, encB64) {
    const sk = this.tokenKeys.get(token);
    if (!sk) return null;
    try {
      return decryptCbc(this.aesKey(sk), encB64);
    } catch {
      return null;
    }
  }

  /** Consume a pending key (one-time) and mint a session for it. */
  takeKey(key) {
    const exp = this.pendingKeys.get(key);
    if (!key || exp == null || exp <= Date.now()) return null;
    this.pendingKeys.delete(key);
    return this.mintToken(key);
  }

  mintToken(sessionKey) {
    const tok = tokenUrlsafe(32);
    this.tokens.add(tok);
    this.tokenKeys.set(tok, sessionKey);
    this.aesKey(sessionKey); // pre-derive & cache
    return tok;
  }

  // ── desktop notifications ──

  setPhoneConnected(on) {
    if (this.phoneConnected === on) return;
    this.phoneConnected = on;
    this.bus.emit('phone', { connected: on });
  }

  /** Mark's _on_phone_connected: a log line + the HUD's phone indicator. */
  onConnect() {
    this.log('SYS: Phone connected via Remote Dashboard.');
    this.phoneConnected = false; // always re-notify on a fresh login
    this.setPhoneConnected(true);
  }

  command(text) {
    const t = String(text || '').trim();
    if (!t) return;
    this.bus.emit('remote-command', { text: t });
  }

  // ── broadcast ──

  broadcast(msg) {
    this.history.push(msg);
    if (this.history.length > 300) this.history = this.history.slice(-300);
    const data = JSON.stringify(msg);
    for (const ws of [...this.clients]) {
      try {
        ws.send(data);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  authOk(req) {
    const tok = String(req.headers.authorization || '')
      .replace(/^Bearer /, '')
      .trim();
    return tok && this.tokens.has(tok) ? tok : null;
  }

  // ── routes ──

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const method = req.method;

    try {
      if (method === 'GET' && p === '/static/crypto.js') {
        if (fs.existsSync(CRYPTOJS_FILE)) {
          const body = fs.readFileSync(CRYPTOJS_FILE);
          res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Length': body.length });
          res.end(body);
        } else {
          res.writeHead(307, { Location: CRYPTOJS_CDN });
          res.end();
        }
        return;
      }

      if (method === 'GET' && p === '/login') return sendHtml(res, this.loginHtml);

      if (method === 'GET' && p === '/') {
        // Auth is client-side (sessionStorage bearer token): browser navigations
        // cannot carry an Authorization header.
        return sendHtml(res, this.appHtml.split('__IP__').join(this.ip).split('__PORT__').join(String(PORT)));
      }

      if (method === 'POST' && p === '/login') {
        let body;
        try {
          body = (await readJson(req)) || {};
        } catch {
          body = {};
        }
        const entered = String(body.pin ?? '')
          .trim()
          .toUpperCase();
        const tok = this.takeKey(entered);
        if (tok) {
          this.onConnect();
          setImmediate(() => this.broadcast({ type: 'sys', text: 'Remote connection established.' }));
          return sendJson(res, 200, { ok: true, token: tok });
        }
        return sendJson(res, 401, { ok: false, error: 'Invalid or expired key' });
      }

      if (method === 'GET' && p === '/auto-login') {
        const key = url.searchParams.get('key') || '';
        const exp = this.pendingKeys.get(key);
        if (!key || exp == null || exp <= Date.now()) return sendHtml(res, EXPIRED_HTML);
        const tok = this.takeKey(key);
        const devTok = tokenUrlsafe(32);
        this.deviceSessions.set(devTok, { sessionKey: key });
        this.onConnect();
        setImmediate(() => this.broadcast({ type: 'sys', text: 'Remote connection established via QR code.' }));
        return sendHtml(res, autoLoginHtml(tok, key, devTok));
      }

      if (method === 'POST' && p === '/api/device-login') {
        let body;
        try {
          body = (await readJson(req)) || {};
        } catch {
          return sendJson(res, 400, { ok: false });
        }
        const devTok = String(body.device_token || '').trim();
        const dev = devTok && this.deviceSessions.get(devTok);
        if (!dev) return sendJson(res, 401, { ok: false });
        const tok = this.mintToken(dev.sessionKey);
        this.onConnect();
        setImmediate(() => this.broadcast({ type: 'sys', text: 'Known device reconnected automatically.' }));
        return sendJson(res, 200, { ok: true, token: tok, key: dev.sessionKey });
      }

      if (method === 'POST' && p === '/api/revoke-devices') {
        if (!this.authOk(req)) return sendJson(res, 401, { error: 'Unauthorized' });
        const count = this.deviceSessions.size;
        this.deviceSessions.clear();
        return sendJson(res, 200, { ok: true, revoked: count });
      }

      if (method === 'POST' && p === '/api/command') {
        const tok = this.authOk(req);
        if (!tok) return sendJson(res, 401, { error: 'Unauthorized' });
        let body;
        try {
          body = (await readJson(req)) || {};
        } catch {
          body = {};
        }
        let text;
        if (body.enc) {
          text = this.decrypt(tok, String(body.enc));
          if (text == null) return sendJson(res, 400, { error: 'Decryption failed' });
        } else {
          text = String(body.text || '').trim();
        }
        this.command(text);
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && p === '/api/wake') {
        if (!this.authOk(req)) return sendJson(res, 401, { error: 'Unauthorized' });
        // Mark exposes a wake callback here; the renderer owns wake state.
        this.bus.emit('remote-wake', {});
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && p === '/api/upload') {
        if (!this.authOk(req)) {
          req.resume();
          return sendJson(res, 401, { error: 'Unauthorized' });
        }
        const makeDest = (safe) => {
          const ext = path.extname(safe);
          const stem = safe.slice(0, safe.length - ext.length);
          let dest = path.join(this.uploadsDir, safe);
          let n = 1;
          while (fs.existsSync(dest)) dest = path.join(this.uploadsDir, `${stem}_${n++}${ext}`);
          return dest;
        };
        const r = await receiveMultipartFile(req, makeDest, MAX_UPLOAD_MB * 1024 * 1024);
        if (r.error) return sendJson(res, r.status || 500, { error: r.error });
        setImmediate(() =>
          this.broadcast({ type: 'file_received', name: r.name, size: r.size, saved_to: this.uploadsDir }),
        );
        return sendJson(res, 200, { ok: true, name: r.name, size: r.size });
      }

      if (method === 'GET' && p === '/api/files') {
        if (!this.authOk(req)) return sendJson(res, 401, { error: 'Unauthorized' });
        let files = [];
        try {
          files = fs
            .readdirSync(this.uploadsDir, { withFileTypes: true })
            .filter((d) => d.isFile())
            .map((d) => {
              const st = fs.statSync(path.join(this.uploadsDir, d.name));
              return { name: d.name, size: st.size, mtime: st.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime)
            .map(({ name, size }) => ({ name, size }));
        } catch {
          /* empty list */
        }
        return sendJson(res, 200, { files });
      }

      if (method === 'GET' && p.startsWith('/uploads/')) {
        // Auth via query param — <a download> can't send custom headers.
        const tok = (url.searchParams.get('token') || '').trim();
        if (!tok || !this.tokens.has(tok)) return sendJson(res, 401, { error: 'Unauthorized' });
        let name;
        try {
          name = decodeURIComponent(p.slice('/uploads/'.length));
        } catch {
          return sendJson(res, 404, { error: 'Not found' });
        }
        const safe = name.replace(/[/\\]/g, '');
        const file = path.join(this.uploadsDir, safe);
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          st = null;
        }
        if (!safe || safe === '.' || safe === '..' || !st || !st.isFile()) {
          return sendJson(res, 404, { error: 'Not found' });
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
        });
        fs.createReadStream(file).pipe(res);
        return;
      }

      sendJson(res, 404, { detail: 'Not Found' });
    } catch (e) {
      console.error('[Dashboard]', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.end();
    }
  }

  // ── websockets ──

  onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' && url.pathname !== '/ws/phone-audio') {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const tok = (url.searchParams.get('token') || '').trim();
      if (!tok || !this.tokens.has(tok)) {
        ws.close(4001);
        return;
      }
      if (url.pathname === '/ws') this.onFeedSocket(ws, tok);
      else this.onAudioSocket(ws);
    });
  }

  onFeedSocket(ws, tok) {
    this.clients.add(ws);
    this.setPhoneConnected(true);
    for (const entry of this.history.slice(-50)) {
      try {
        ws.send(JSON.stringify(entry));
      } catch {
        break;
      }
    }
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let data;
      try {
        data = JSON.parse(raw.toString('utf-8'));
      } catch {
        return;
      }
      if (data && data.type === 'command') {
        const t = data.enc ? this.decrypt(tok, String(data.enc)) : String(data.text || '').trim();
        if (t) this.command(t);
      }
    });
    const gone = () => {
      if (!this.clients.delete(ws)) return;
      if (this.clients.size === 0) this.setPhoneConnected(false);
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  onAudioSocket(ws) {
    this.audioSockets.add(ws);
    setImmediate(() => this.broadcast({ type: 'sys', text: 'Phone microphone live.' }));
    ws.on('message', (raw, isBinary) => {
      if (!isBinary) return;
      // app.html already sends 16 kHz mono int16 little-endian PCM.
      const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      if (buf.length) this.bus.emit('remote-audio', { data: buf.toString('base64') });
    });
    let ended = false;
    const gone = () => {
      if (ended) return;
      ended = true;
      this.audioSockets.delete(ws);
      setImmediate(() => this.broadcast({ type: 'sys', text: 'Phone microphone stopped.' }));
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  // ── serve ──

  listen(server, port, label) {
    return new Promise((resolve) => {
      server.once('error', (e) => {
        say(`${label} could not listen on port ${port}: ${e?.code || e?.message || e}`);
        resolve(false);
      });
      server.listen(port, '0.0.0.0', () => resolve(true));
    });
  }

  async start() {
    const { WebSocketServer } = require('ws');
    this.ip = await localIp();
    ensureNetworkAccess(PORT); // background; never blocks startup
    await ensureCerts(this.ip);

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    const handler = (req, res) => this.handle(req, res);
    const useSsl = sslEnabled();
    let tls = null;
    if (useSsl) {
      try {
        tls = { key: fs.readFileSync(keyPath()), cert: fs.readFileSync(crtPath()) };
      } catch (e) {
        say(`Could not read certificate (${e?.message || e}) — serving over plain HTTP.`);
      }
    }
    const make = () => (tls ? require('https').createServer(tls, handler) : require('http').createServer(handler));

    const main = make();
    main.on('upgrade', (req, sock, head) => this.onUpgrade(req, sock, head));
    const ok = await this.listen(main, PORT, 'Dashboard');
    if (!ok) throw new Error(`port ${PORT} unavailable`);
    this.servers.push(main);
    say(`${tls ? 'https' : 'http'}://${this.ip}:${PORT}`);

    if (tls) {
      // Second HTTPS server on PORT+1 sharing all state. Chrome HTTPS-upgrades
      // any bare IP:PORT the user types, so the manual-entry port needs TLS too.
      ensureNetworkAccess(PORT + 1);
      const alias = make();
      alias.on('upgrade', (req, sock, head) => this.onUpgrade(req, sock, head));
      if (await this.listen(alias, PORT + 1, 'Dashboard alias')) {
        this.servers.push(alias);
        say(`Manual entry:  ${this.ip}:${PORT + 1}  (type in browser, accept cert once)`);
      }
    }
    say("Press 'Remote Control' in JARVIS to get the QR code.");
  }

  stop() {
    for (const ws of [...this.clients, ...this.audioSockets]) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    this.audioSockets.clear();
    try {
      this.wss?.close();
    } catch {
      /* ignore */
    }
    for (const s of this.servers) {
      try {
        s.closeAllConnections?.();
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.servers = [];
  }
}

const EXPIRED_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<style>
  body{background:#07090f;color:#dde3ed;font-family:sans-serif;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
  h2{color:#f87171;margin-bottom:12px}p{color:#5e6a7e;font-size:14px}
</style></head>
<body><div><h2>Link Expired</h2>
<p>Press <strong style="color:#dde3ed">Remote Control</strong> in JARVIS to get a new QR code.</p>
</div></body></html>`;

// Tokens are base64url and the key is [A-Z2-9], so they are safe inside quotes.
const autoLoginHtml = (tok, key, devTok) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<style>
  body{background:#07090f;color:#dde3ed;font-family:sans-serif;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
  p{color:#5e6a7e;font-size:14px}
</style></head>
<body>
<script>
  sessionStorage.setItem('jarvis_token','${tok}');
  sessionStorage.setItem('jarvis_key','${key}');
  localStorage.setItem('jarvis_device_token','${devTok}');
  setTimeout(function(){location.replace('/')},400);
</script>
<p>Connecting to JARVIS…</p>
</body></html>`;

// ── module API ─────────────────────────────────────────────────────────────

let server = null;
let ready = null; // Promise<boolean>: resolves once start() settled

function register({ handle, bus, log, showWindow }) {
  void showWindow; // reserved: Mark's dashboard never raises the window
  const logFn = typeof log === 'function' ? log : () => {};
  server = new DashboardServer({ bus, log: logFn });
  const s = server;
  ready = s
    .start()
    .then(() => true)
    .catch((e) => {
      say(`Disabled: ${e?.message || e}`);
      s.stop();
      return false;
    });

  const keyInfo = async () => {
    if (!server || !(await ready)) {
      logFn('SYS: Dashboard unavailable — the remote server could not start (is port 8000 in use?).');
      return null;
    }
    const key = server.newKey();
    const url = server.getUrl();
    return { url, key, autoLoginUrl: `${url}/auto-login?key=${key}`, manualUrl: server.getManualUrl() };
  };

  handle('mark:remote-key', keyInfo);
  handle('mark:remote-new-key', keyInfo);
  handle('mark:remote-broadcast', async (msg) => {
    if (!server || !msg || typeof msg !== 'object') return;
    await ready;
    server.broadcast(msg);
  });
  return ready;
}

function stop() {
  if (server) server.stop();
  server = null;
}

module.exports = { register, stop };
