// desktop_control — the Node port of Mark LIV's actions/desktop.py.
//
// Wallpaper (set from a file or URL, read the current one), organize / clean /
// list / stats for the Desktop folder, and a free-form "task" that asks Gemini
// for a small script and runs it in a restricted sandbox.
//
// Differences from Mark, all in the direction of safety:
//  - organize and clean journal every move, and ONE undo puts every file back
//    and removes the folders they created (only when empty again).
//  - setting the wallpaper registers an undo back to the previous one.
//  - the generated task code is JavaScript run in a `vm` context holding only
//    the same read-mostly API Mark's Python sandbox exposed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { run, runPS } = require('../util/ps');
const native = require('./_native');

const OS_LABEL = { win32: 'Windows', darwin: 'Darwin' }[process.platform] || 'Linux';
const IS_WIN = process.platform === 'win32';

function getDesktop(ctx) {
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_DESKTOP_DIR || '';
    if (xdg && fs.existsSync(xdg)) return xdg;
  }
  // Electron resolves OneDrive-redirected Desktops; home/Desktop is Mark's default.
  const p = ctx?.paths?.desktop;
  if (p && fs.existsSync(p)) return p;
  return path.join(os.homedir(), 'Desktop');
}

const tmpFile = (suffix) => path.join(os.tmpdir(), `mark-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);

// ── Wallpaper ────────────────────────────────────────────────────────────────
async function getCurrentWallpaperPath() {
  if (IS_WIN) {
    const r = await run('reg.exe', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'], { timeout: 5000 });
    const m = r.stdout.match(/Wallpaper\s+REG_\w+\s+(.*)$/m);
    return m ? m[1].trim() : '';
  }
  if (process.platform === 'darwin') {
    const r = await run('osascript', ['-e', 'tell application "System Events" to get picture of desktop 1']);
    return r.stdout.trim();
  }
  const de = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  if (de.includes('gnome') || de.includes('unity')) {
    const r = await run('gsettings', ['get', 'org.gnome.desktop.background', 'picture-uri']);
    return r.stdout.trim().replace(/^'|'$/g, '').replace(/^file:\/\//, '');
  }
  return '';
}

async function applyWallpaper(file) {
  if (IS_WIN) {
    if (!(await native.setWallpaperWin(file))) throw new Error('Windows refused the wallpaper change');
    return;
  }
  if (process.platform === 'darwin') {
    const script = `tell application "System Events" to tell every desktop to set picture to POSIX file ${JSON.stringify(file)}`;
    await run('osascript', ['-e', script]);
    return;
  }
  const de = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const uri = `file://${file}`;
  if (de.includes('gnome') || de.includes('unity')) {
    await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri', uri]);
    await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri-dark', uri]);
  } else if (de.includes('kde')) {
    const script = `
var allDesktops = desktops();
for (var i = 0; i < allDesktops.length; i++) {
    d = allDesktops[i];
    d.wallpaperPlugin = "org.kde.image";
    d.currentConfigGroup = ["Wallpaper", "org.kde.image", "General"];
    d.writeConfig("Image", ${JSON.stringify(uri)});
}
`;
    await run('qdbus', ['org.kde.plasmashell', '/PlasmaShell', 'org.kde.PlasmaShell.evaluateScript', script]);
  } else if (de.includes('xfce')) {
    await run('xfconf-query', ['-c', 'xfce4-desktop', '-p', '/backdrop/screen0/monitor0/workspace0/last-image', '-s', file]);
  } else {
    const r = await run('feh', ['--bg-scale', file]);
    if (!r.ok) {
      const err = new Error(`Could not set wallpaper automatically on ${de}. Try manually or install 'feh'.`);
      err.userFacing = true;
      throw err;
    }
  }
}

/**
 * Windows before 10 only accepted BMP; Mark converted png/webp to BMP with PIL
 * when it could. PNG is fine on 10/11, so only webp is converted — through
 * WIC (PowerShell), which decodes it when the WebP codec is installed.
 */
async function toWindowsFriendly(file) {
  if (path.extname(file).toLowerCase() !== '.webp') return file;
  const out = tmpFile('.bmp');
  const r = await runPS(
    'Add-Type -AssemblyName PresentationCore\n' +
      `$d = [System.Windows.Media.Imaging.BitmapDecoder]::Create([Uri]'${file.replace(/'/g, "''")}', 'None', 'OnLoad')\n` +
      '$e = New-Object System.Windows.Media.Imaging.BmpBitmapEncoder\n' +
      '$e.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($d.Frames[0]))\n' +
      `$s = [IO.File]::Create('${out.replace(/'/g, "''")}'); $e.Save($s); $s.Close()`,
    { timeout: 20_000 },
  );
  return r.ok && fs.existsSync(out) ? out : file;
}

async function setWallpaper(imagePath, ctx, { persistCopy = false } = {}) {
  let p = path.resolve(String(imagePath).replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(p)) return `Image not found: ${imagePath}`;
  const ext = path.extname(p).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.bmp', '.webp'].includes(ext)) {
    return `Unsupported format: ${ext}. Use jpg, png, bmp or webp.`;
  }
  const name = path.basename(p);
  try {
    // A downloaded wallpaper lives in temp; Windows needs the file to stay.
    if (persistCopy) {
      const dir = path.join(ctx?.paths?.markDir || path.join(os.homedir(), '.jarvis-mark'), 'wallpapers');
      fs.mkdirSync(dir, { recursive: true });
      const keep = path.join(dir, `${Date.now()}${ext}`);
      fs.copyFileSync(p, keep);
      p = keep;
    }
    if (IS_WIN) p = await toWindowsFriendly(p);
    const previous = await getCurrentWallpaperPath().catch(() => '');
    await applyWallpaper(p);
    if (previous && fs.existsSync(previous)) {
      ctx?.undo?.push(`wallpaper → ${name}`, async () => {
        await applyWallpaper(previous);
        return `Wallpaper back to ${path.basename(previous)}.`;
      });
    }
    return `Wallpaper set: ${name}`;
  } catch (e) {
    if (e.userFacing) return e.message;
    return `Could not set wallpaper: ${e.message || e}`;
  }
}

async function setWallpaperFromUrl(url, ctx) {
  try {
    if (!/^https?:\/\//i.test(url)) return `Could not download wallpaper: only http(s) URLs are supported.`;
    const suffix = path.extname(new URL(url).pathname) || '.jpg';
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return `Could not download wallpaper: HTTP ${res.status}`;
    const tmp = tmpFile(suffix);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    try {
      return await setWallpaper(tmp, ctx, { persistCopy: true });
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  } catch (e) {
    return `Could not download wallpaper: ${e.message || e}`;
  }
}

async function getCurrentWallpaper() {
  try {
    if (process.platform === 'linux') {
      const de = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
      if (!(de.includes('gnome') || de.includes('unity'))) {
        return 'Wallpaper path retrieval not supported for this desktop environment.';
      }
    }
    return `Current wallpaper: ${await getCurrentWallpaperPath()}`;
  } catch (e) {
    return `Could not get wallpaper: ${e.message || e}`;
  }
}

// ── Organize / clean ─────────────────────────────────────────────────────────
const FILE_TYPE_MAP = {
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.heic'],
  Documents: ['.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.odt', '.ods', '.odp'],
  Videos: ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v'],
  Music: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'],
  Code: ['.py', '.js', '.ts', '.html', '.css', '.json', '.xml', '.cpp', '.java', '.cs', '.go', '.rs', '.sh', '.php'],
  Executables: ['.exe', '.msi', '.bat', '.cmd', '.sh', '.appimage', '.deb', '.rpm'],
};

const SKIP_EXTENSIONS = { Windows: ['.lnk', '.url'], Darwin: ['.webloc'], Linux: ['.desktop'] };
// Windows keeps these hidden-by-attribute files on every Desktop; moving them breaks icons.
const SKIP_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

function movableFiles(desktop) {
  const skip = SKIP_EXTENSIONS[OS_LABEL] || [];
  const out = [];
  for (const ent of fs.readdirSync(desktop, { withFileTypes: true })) {
    if (ent.isDirectory() || ent.name.startsWith('.')) continue;
    if (!ent.isFile()) continue;
    if (SKIP_NAMES.has(ent.name.toLowerCase())) continue;
    if (skip.includes(path.extname(ent.name).toLowerCase())) continue;
    out.push(ent.name);
  }
  return out;
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/**
 * Register one undo for a whole batch of moves. Reversed newest-first; a file
 * is only put back when its original spot is still free, and a folder this
 * batch created is removed only if it is empty again — anything the user has
 * since put there is never touched.
 */
function pushBatchUndo(ctx, label, moves, createdDirs) {
  if (!moves.length) {
    for (const d of createdDirs) {
      try {
        fs.rmdirSync(d);
      } catch {
        /* not empty / gone */
      }
    }
    return;
  }
  ctx?.undo?.push(label, async () => {
    let back = 0;
    const stuck = [];
    for (const { from, to } of [...moves].reverse()) {
      try {
        if (!fs.existsSync(to)) {
          stuck.push(path.basename(from));
          continue;
        }
        if (fs.existsSync(from)) {
          stuck.push(path.basename(from));
          continue;
        }
        moveFile(to, from);
        back++;
      } catch {
        stuck.push(path.basename(from));
      }
    }
    let removed = 0;
    for (const d of createdDirs) {
      try {
        if (fs.readdirSync(d).length === 0) {
          fs.rmdirSync(d);
          removed++;
        }
      } catch {
        /* leave it */
      }
    }
    let msg = `${back} file(s) moved back`;
    if (removed) msg += `, ${removed} empty folder(s) removed`;
    msg += '.';
    if (stuck.length) msg += ` ${stuck.length} could not be restored (moved or replaced since): ${stuck.slice(0, 5).join(', ')}.`;
    return msg;
  });
}

const pad = (n) => String(n).padStart(2, '0');

function organizeDesktop(mode = 'by_type', ctx) {
  const desktop = getDesktop(ctx);
  const moved = [];
  const skipped = [];
  const journal = [];
  const createdDirs = [];

  for (const name of movableFiles(desktop)) {
    const item = path.join(desktop, name);
    let folderName;
    if (mode === 'by_date') {
      const m = fs.statSync(item).mtime;
      folderName = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
    } else {
      const ext = path.extname(name).toLowerCase();
      folderName = 'Others';
      for (const [folder, exts] of Object.entries(FILE_TYPE_MAP)) {
        if (exts.includes(ext)) {
          folderName = folder;
          break;
        }
      }
    }

    const targetDir = path.join(desktop, folderName);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir);
      createdDirs.push(targetDir);
    }
    const newPath = path.join(targetDir, name);
    if (fs.existsSync(newPath)) {
      skipped.push(name);
      continue;
    }
    try {
      moveFile(item, newPath);
      journal.push({ from: item, to: newPath });
      moved.push(`${name} → ${folderName}/`);
    } catch {
      skipped.push(name);
    }
  }

  pushBatchUndo(ctx, `organize desktop (${mode}, ${journal.length} files)`, journal, createdDirs);

  let result = `Desktop organized (${mode}): ${moved.length} files moved.`;
  if (moved.length) {
    result += `\n${moved.slice(0, 8).join('\n')}`;
    if (moved.length > 8) result += `\n... and ${moved.length - 8} more.`;
  }
  if (skipped.length) result += `\n${skipped.length} file(s) skipped (name conflict).`;
  return result;
}

function fmtSize(size) {
  return size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function listDesktop(ctx) {
  const desktop = getDesktop(ctx);
  const items = [];
  for (const name of fs.readdirSync(desktop).sort()) {
    if (name.startsWith('.')) continue;
    const p = path.join(desktop, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let count;
      try {
        count = fs.readdirSync(p).length;
      } catch {
        count = '?';
      }
      items.push(`📁 ${name}/ (${count} items)`);
    } else {
      items.push(`📄 ${name} (${fmtSize(st.size)})`);
    }
  }
  if (!items.length) return 'Desktop is empty.';
  return `Desktop (${items.length} items):\n${items.join('\n')}`;
}

function cleanDesktop(ctx) {
  const desktop = getDesktop(ctx);
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const archiveDir = path.join(desktop, `Desktop Archive ${today}`);
  const createdDirs = [];
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir);
    createdDirs.push(archiveDir);
  }
  const journal = [];
  for (const name of movableFiles(desktop)) {
    const from = path.join(desktop, name);
    const to = path.join(archiveDir, name);
    if (fs.existsSync(to)) continue;
    try {
      moveFile(from, to);
      journal.push({ from, to });
    } catch {
      /* skip locked files */
    }
  }
  pushBatchUndo(ctx, `clean desktop (${journal.length} files)`, journal, createdDirs);
  return `Desktop cleaned: ${journal.length} files archived to '${path.basename(archiveDir)}'.`;
}

function getDesktopStats(ctx) {
  const desktop = getDesktop(ctx);
  let files = 0;
  let folders = 0;
  let total = 0;
  for (const ent of fs.readdirSync(desktop, { withFileTypes: true })) {
    if (ent.isDirectory()) folders++;
    else if (ent.isFile()) {
      files++;
      try {
        total += fs.statSync(path.join(desktop, ent.name)).size;
      } catch {
        /* vanished */
      }
    }
  }
  return `Desktop stats (${OS_LABEL}):\n  Files   : ${files}\n  Folders : ${folders}\n  Size    : ${fmtSize(total)}\n  Path    : ${desktop}`;
}

// ── AI-generated desktop task ────────────────────────────────────────────────

/** The only things generated code can touch — Mark's Python sandbox, in JS. */
function buildSandbox(output, ctx) {
  const readOnlyFs = {
    exists: (p) => fs.existsSync(p),
    isFile: (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
    isDir: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    list: (p) => fs.readdirSync(p),
    stat: (p) => {
      const s = fs.statSync(p);
      return { size: s.size, mtime: s.mtime.toISOString(), isDir: s.isDirectory() };
    },
    readText: (p) => fs.readFileSync(p, 'utf8'),
  };
  const shutil = {
    copy2: (src, dst) => {
      const d = fs.existsSync(dst) && fs.statSync(dst).isDirectory() ? path.join(dst, path.basename(src)) : dst;
      if (fs.existsSync(d)) throw new Error(`refusing to overwrite ${d}`);
      fs.copyFileSync(src, d);
      return d;
    },
    copytree: (src, dst) => {
      if (fs.existsSync(dst)) throw new Error(`destination exists: ${dst}`);
      fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false });
      return dst;
    },
    disk_usage: async (p) => {
      const s = await fs.promises.statfs(p);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
    },
  };
  const input = {
    hotkey: (...keys) => native.hotkey(...keys),
    press: (key, times = 1) => native.press(key, times),
    write: (text, intervalMs = 30) => native.typeText(text, intervalMs),
    click: (x, y, button = 'left', clicks = 1) => native.click({ x, y, button, clicks }),
    moveTo: (x, y, durationMs = 300) => native.moveTo(x, y, durationMs),
    scroll: (notches) => native.scroll(Number(notches) * 120),
    size: () => native.screenSize(),
  };
  const sandbox = {
    print: (...a) => output.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    sleep: (sec) => new Promise((r) => setTimeout(r, Math.min(30, Number(sec) || 0) * 1000)),
    path: { join: path.join, basename: path.basename, dirname: path.dirname, extname: path.extname, resolve: path.resolve },
    fs: readOnlyFs,
    shutil,
    input,
    DESKTOP: getDesktop(ctx),
    HOME: os.homedir(),
    JSON,
    Math,
    Date,
  };
  if (IS_WIN) {
    sandbox.registry = {
      /** Read-only registry query: returns the value's data string or ''. */
      query: async (key, name) => {
        if (!/^HKCU\\/i.test(key)) throw new Error('only HKCU can be read');
        const r = await run('reg.exe', ['query', key, '/v', name], { timeout: 5000 });
        const m = r.stdout.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_\\w+\\s+(.*)$`, 'm'));
        return m ? m[1].trim() : '';
      },
    };
  }
  return sandbox;
}

async function executeGeneratedCode(code, ctx) {
  if (!code || code.trim() === 'UNSAFE') return 'This action cannot be performed safely.';
  if (code.startsWith('```')) code = code.split('\n').slice(1, -1).join('\n').trim();
  // A second line of defence behind the prompt's rules.
  if (/\b(require|import|process|child_process|eval|Function|unlink|rmSync|rmdir|globalThis|constructor)\b/.test(code)) {
    return 'This action cannot be performed safely.';
  }

  const output = [];
  const context = vm.createContext(buildSandbox(output, ctx), { codeGeneration: { strings: false, wasm: false } });
  try {
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'jarvis_desktop.js' });
    const promise = script.runInContext(context, { timeout: 5000 });
    await Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 60 s')), 60_000)),
    ]);
    return output.length ? output.join('\n') : 'Done.';
  } catch (e) {
    console.warn(`[Desktop] Exec error: ${e.message}\nCode:\n${code.slice(0, 300)}`);
    return `Execution error: ${e.message || e}`;
  }
}

async function askGeminiForDesktopAction(task, ctx) {
  const desktop = getDesktop(ctx);
  const osSpecific = IS_WIN
    ? '- registry.query(key, valueName) (await it; HKCU only, READ only)'
    : '- no process or shell access; use input or fs only';

  const prompt = `You are a desktop automation assistant.
Current OS: ${OS_LABEL}
Desktop path: ${desktop}   (also available as the DESKTOP constant; HOME is the home folder)

Generate safe JavaScript (the body of an async function) to accomplish the task below.
Available globals ONLY:
- input.hotkey(...keys), input.press(key, times), input.write(text), input.click(x, y, button, clicks),
  input.moveTo(x, y), input.scroll(notches), input.size()   (all async — await them)
- fs.exists(p), fs.isFile(p), fs.isDir(p), fs.list(p), fs.stat(p), fs.readText(p)   (inspection only)
- shutil.copy2(src, dst), shutil.copytree(src, dst), await shutil.disk_usage(p)   (NO move, NO delete)
- path.join / basename / dirname / extname / resolve
- await sleep(seconds)
- print(...values)   — everything printed is returned to the user
${osSpecific}

Hard rules:
- NO file deletion, NO moving files
- NO process, child_process, require, import, eval or Function
- NO file write operations except explicitly requested copies
- If the task cannot be done safely with these tools, output exactly: UNSAFE

Output ONLY the JavaScript code. No explanation, no markdown, no backticks.

Task: ${task}`;

  try {
    if (!ctx?.gemini) return 'ERROR: Gemini is not available';
    const response = await ctx.gemini.call(prompt, { tier: ctx.gemini.SMART, timeoutMs: 30_000 });
    if (!response) return 'ERROR: every Gemini model on the ladder failed';
    let code = String(response.text || '').trim();
    if (code.startsWith('```')) code = code.split('\n').slice(1, -1).join('\n').trim();
    return code;
  } catch (e) {
    return `ERROR: ${e.message || e}`;
  }
}

async function runTask(task, ctx) {
  console.log(`[Desktop] Asking Gemini: ${task}`);
  ctx?.ui?.log?.('[Desktop] Generating action...');
  const code = await askGeminiForDesktopAction(task, ctx);
  if (code.startsWith('ERROR:')) return code;
  return executeGeneratedCode(code, ctx);
}

async function desktopControl(parameters, ctx) {
  const params = parameters || {};
  const action = String(params.action || '').toLowerCase().trim();
  const task = String(params.task || '').trim();

  ctx?.ui?.log?.(`[desktop] ${action || task.slice(0, 40)}`);

  try {
    if (action === 'wallpaper') {
      const p = params.path || '';
      return p ? await setWallpaper(p, ctx) : 'No image path provided.';
    }
    if (action === 'wallpaper_url') {
      const url = params.url || '';
      return url ? await setWallpaperFromUrl(url, ctx) : 'No URL provided.';
    }
    if (action === 'current_wallpaper') return await getCurrentWallpaper();
    if (action === 'organize') return organizeDesktop(params.mode || 'by_type', ctx);
    if (action === 'clean') return cleanDesktop(ctx);
    if (action === 'list') return listDesktop(ctx);
    if (action === 'stats') return getDesktopStats(ctx);
    if (action === 'task' || task) {
      const actual = task || String(params.description || '');
      if (!actual) return 'Please describe what you want to do on the desktop.';
      return await runTask(actual, ctx);
    }
    if (action) return await runTask(action, ctx);
    return 'No action or task specified.';
  } catch (e) {
    console.warn(`[Desktop] Error: ${e.message || e}`);
    return `Desktop control error: ${e.message || e}`;
  }
}

module.exports = {
  TOOL: {
    name: 'desktop_control',
    description: 'Controls the desktop: wallpaper, organize, clean, list, stats.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'wallpaper | wallpaper_url | organize | clean | list | stats | task' },
        path: { type: 'STRING', description: 'Image path for wallpaper' },
        url: { type: 'STRING', description: 'Image URL for wallpaper_url' },
        mode: { type: 'STRING', description: 'by_type or by_date for organize' },
        task: { type: 'STRING', description: 'Natural language desktop task' },
      },
      required: ['action'],
    },
  },
  run: desktopControl,
  organizeDesktop,
  cleanDesktop,
  listDesktop,
  getDesktopStats,
  executeGeneratedCode,
};
