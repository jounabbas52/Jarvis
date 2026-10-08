// file_controller — the Node port of Mark LIV's actions/file_controller.py.
//
// Every change it makes to the disk is registered with the shared undo stack,
// and everything is fenced to the user's home directory (_SAFE_ROOTS in Mark).
// Deletion never unlinks: it goes to the Recycle Bin / Trash like send2trash,
// so the person can always find the file again themselves.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// Undo keeps a file's previous contents in memory so `write` can be reversed.
// Above this size it does not — a 200 MB log would sit in RAM for the rest of
// the session to protect an edit nobody is going to take back.
const UNDO_CONTENT_LIMIT = 1_000_000;

let electron = null;
function el() {
  // Lazy: this file is also loaded by tests outside Electron.
  if (electron === null) {
    try {
      electron = require('electron');
      if (typeof electron !== 'object') electron = {}; // plain Node gets a path string
    } catch {
      electron = {};
    }
  }
  return electron;
}

function appPath(name, fallback) {
  try {
    const p = el().app?.getPath(name);
    if (p) return p;
  } catch {
    /* not in Electron, or not ready */
  }
  return fallback;
}

// ── Paths ────────────────────────────────────────────────────────────────────
// Electron's getPath already honours XDG dirs on Linux and folder redirection
// (OneDrive) on Windows, which is what Mark's _get_* helpers approximated.
function dirs(ctx) {
  const home = ctx?.paths?.home || os.homedir();
  return {
    desktop: ctx?.paths?.desktop || appPath('desktop', path.join(home, 'Desktop')),
    downloads: ctx?.paths?.downloads || appPath('downloads', path.join(home, 'Downloads')),
    documents: ctx?.paths?.documents || appPath('documents', path.join(home, 'Documents')),
    pictures: appPath('pictures', path.join(home, 'Pictures')),
    music: appPath('music', path.join(home, 'Music')),
    videos: appPath('videos', path.join(home, 'Videos')),
    home,
  };
}

function resolvePath(raw, ctx) {
  const shortcuts = dirs(ctx);
  raw = String(raw ?? '').trim().replace(/^["']+|["']+$/g, '');
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(shortcuts, lower)) return shortcuts[lower];

  // "desktop/notes/a.md" and "desktop\notes\a.md" — a shortcut followed by a
  // sub-path. Without this the whole string resolves against the process CWD
  // instead of the real Desktop.
  const norm = raw.replace(/\\/g, '/');
  const slash = norm.indexOf('/');
  if (slash > 0) {
    const head = norm.slice(0, slash).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(shortcuts, head)) {
      const rest = norm.slice(slash + 1).replace(/^\/+|\/+$/g, '');
      return rest ? path.join(shortcuts[head], rest) : shortcuts[head];
    }
  }
  if (raw === '~') return shortcuts.home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(shortcuts.home, raw.slice(2));
  return path.resolve(raw);
}

/** Path.resolve(): follow symlinks for the part of the path that exists. */
function realResolve(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const norm = (p) => (IS_WIN ? p.toLowerCase() : p);

function samePath(a, b) {
  return norm(realResolve(a)) === norm(realResolve(b));
}

/** Is the path inside the user's home directory (Mark's _SAFE_ROOTS)? */
function isSafePath(target, ctx) {
  try {
    const resolved = norm(realResolve(target));
    const roots = [ctx?.paths?.home || os.homedir()];
    return roots.some((r) => {
      const root = norm(realResolve(r));
      if (resolved === root) return true;
      const rel = path.relative(root, resolved);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  } catch {
    return false;
  }
}

const join = (base, name) => (name ? path.join(base, name) : base);
const exists = (p) => fs.existsSync(p);
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const baseName = (p) => path.basename(p) || p;
const parentName = (p) => path.basename(path.dirname(p));
const isPermErr = (e) => e && (e.code === 'EACCES' || e.code === 'EPERM');

function formatSize(b) {
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (b < 1024) return `${b.toFixed(1)} ${unit}`;
    b /= 1024;
  }
  return `${b.toFixed(1)} TB`;
}

/** shutil.move: rename, or copy + remove across volumes. */
function moveSync(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** Async walk (rglob) that does not block the main process on a big tree. */
async function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const d = ent.isDirectory();
      if (d) stack.push(full);
      yield { full, name: ent.name, isDir: d, isFile: ent.isFile() };
    }
  }
}

// ── Undo builders ────────────────────────────────────────────────────────────
/** Reverse of a move: put it back where it came from. */
function undoMove(src, dst) {
  return () => {
    if (!exists(dst)) return `'${baseName(dst)}' is no longer there — nothing moved back.`;
    fs.mkdirSync(path.dirname(src), { recursive: true });
    moveSync(dst, src);
    return `'${baseName(src)}' is back in ${parentName(src)}/.`;
  };
}

/**
 * Reverse of a create: remove what we made — and only if we still made it.
 * Deliberately refuses to touch a directory that has since been filled: the
 * undo for 'create a folder' is not 'delete whatever ended up in it'.
 */
function undoCreate(target) {
  return () => {
    if (!exists(target)) return `'${baseName(target)}' is already gone.`;
    if (isDir(target)) {
      if (fs.readdirSync(target).length) {
        return `'${baseName(target)}' is not empty any more — leaving it alone rather than deleting your files.`;
      }
      fs.rmdirSync(target);
    } else {
      fs.unlinkSync(target);
    }
    return `Removed '${baseName(target)}'.`;
  };
}

/**
 * Reverse of a write: restore the old contents, or remove a file that did not
 * exist before the write created it.
 */
function undoWrite(target, previous) {
  return () => {
    if (previous == null) {
      if (exists(target)) {
        fs.unlinkSync(target);
        return `Removed '${baseName(target)}' — it did not exist before.`;
      }
      return `'${baseName(target)}' is already gone.`;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, previous, 'utf-8');
    return `Restored the previous contents of '${baseName(target)}'.`;
  };
}

/**
 * Best-effort undelete. The file is in the Recycle Bin either way; getting it
 * back out is shell work and only reliable on Windows. Everywhere else this
 * says where the file is instead of pretending it failed.
 */
async function restoreFromTrash(original) {
  const name = baseName(original);
  if (IS_WIN) {
    try {
      const { runPS, psQuote } = require('../util/ps');
      // Shell.Application's Recycle Bin (ssfBITBUCKET = 10), matched on the
      // original folder (details column 1) and name, as Mark does. UNDELETE is
      // a localised verb name, so if it does nothing the file is moved back
      // from the bin by hand.
      const script = `
$want = ${psQuote(original)}
$dir = Split-Path -Parent $want
$leaf = Split-Path -Leaf $want
$sh = New-Object -ComObject Shell.Application
$bin = $sh.NameSpace(10)
foreach ($it in @($bin.Items())) {
  $n = ([string]$it.Name).Trim().ToLower()
  # Explorer drops the extension from Name when extensions are hidden; the
  # bin's own $R file keeps it.
  $sameName = ($n -eq $leaf.ToLower()) -or ($n -eq [IO.Path]::GetFileNameWithoutExtension($leaf).ToLower() -and [IO.Path]::GetExtension([string]$it.Path).ToLower() -eq [IO.Path]::GetExtension($leaf).ToLower())
  if (([string]$bin.GetDetailsOf($it, 1)).Trim().ToLower() -eq $dir.Trim().ToLower() -and $sameName) {
    $binPath = $it.Path
    try { $it.InvokeVerb('undelete') } catch {}
    Start-Sleep -Milliseconds 400
    if (-not (Test-Path -LiteralPath $want) -and (Test-Path -LiteralPath $binPath)) {
      Move-Item -LiteralPath $binPath -Destination $want -Force
    }
    if (Test-Path -LiteralPath $want) { 'RESTORED' } else { 'FAILED' }
    break
  }
}`;
      const r = await runPS(script, { timeout: 30_000 });
      if (r.stdout.includes('RESTORED')) return `'${name}' restored from the Recycle Bin.`;
      if (!r.ok) console.warn(`[file] Recycle Bin restore failed: ${r.stderr.slice(0, 200)}`);
    } catch (e) {
      console.warn(`[file] Recycle Bin restore failed: ${e?.message || e}`);
    }
  }
  return `'${name}' is in the Recycle Bin — I could not pull it back automatically, but it is there and can be restored by hand.`;
}

/** send2trash. Electron's shell.trashItem first; PowerShell's VisualBasic FileIO as the fallback on Windows. */
async function safeTrash(target) {
  const shell = el().shell;
  if (shell && typeof shell.trashItem === 'function') {
    await shell.trashItem(target);
    return `Moved to Trash: ${baseName(target)}`;
  }
  if (IS_WIN) {
    const { runPS, psQuote } = require('../util/ps');
    const fn = isDir(target) ? 'DeleteDirectory' : 'DeleteFile';
    const r = await runPS(
      `Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::${fn}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
      { timeout: 60_000 },
    );
    if (r.ok && !exists(target)) return `Moved to Trash: ${baseName(target)}`;
    throw new Error(r.stderr.trim() || 'the Recycle Bin refused it');
  }
  return 'The system Trash is not reachable from here. Permanent deletion is disabled for safety.';
}

// ── Actions ──────────────────────────────────────────────────────────────────
function listFiles(p, ctx, showHidden = false) {
  try {
    const target = resolvePath(p, ctx);
    if (!isSafePath(target, ctx)) return `Access denied: ${target}`;
    if (!exists(target)) return `Path not found: ${target}`;
    if (!isDir(target)) return `Not a directory: ${target}`;

    const items = [];
    for (const n of fs.readdirSync(target).sort()) {
      if (!showHidden && n.startsWith('.')) continue;
      const full = path.join(target, n);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) items.push(`📁 ${n}/`);
      else items.push(`📄 ${n} (${formatSize(st.size)})`);
    }
    if (!items.length) return `Directory is empty: ${baseName(target)}/`;
    return `Contents of ${baseName(target)}/ (${items.length} items):\n${items.join('\n')}`;
  } catch (e) {
    if (isPermErr(e)) return `Permission denied: ${p}`;
    return `Error listing files: ${e.message || e}`;
  }
}

function createFile(p, name, content, ctx) {
  try {
    const target = join(resolvePath(p, ctx), name);
    if (!isSafePath(target, ctx)) return `Access denied: ${target}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existed = exists(target);
    let previous = null;
    if (existed) {
      try {
        previous = fs.readFileSync(target, 'utf-8');
      } catch {
        previous = null;
      }
    }
    fs.writeFileSync(target, content || '', 'utf-8');
    ctx.undo.push(`created ${baseName(target)}`, existed ? undoWrite(target, previous) : undoCreate(target));
    return `File created: ${baseName(target)}`;
  } catch (e) {
    return `Could not create file: ${e.message || e}`;
  }
}

function createFolder(p, name, ctx) {
  try {
    const target = join(resolvePath(p, ctx), name);
    if (!isSafePath(target, ctx)) return `Access denied: ${target}`;
    const already = exists(target);
    fs.mkdirSync(target, { recursive: true });
    // Only offer to undo a folder we actually made. "mkdir -p" on something
    // that was already there is not a change, and undoing it would delete a
    // directory the user has had for years.
    if (!already) ctx.undo.push(`created folder ${baseName(target)}`, undoCreate(target));
    return `Folder created: ${baseName(target)}`;
  } catch (e) {
    return `Could not create folder: ${e.message || e}`;
  }
}

async function deleteFile(p, name, ctx) {
  try {
    const target = join(resolvePath(p, ctx), name);
    if (!isSafePath(target, ctx)) return `Access denied: ${target}`;
    if (!exists(target)) return `Not found: ${baseName(target)}`;

    // Protect the critical user folders themselves.
    const protectedDirs = Object.values(dirs(ctx));
    if (protectedDirs.some((d) => samePath(target, d))) return `Protected directory, cannot delete: ${baseName(target)}`;

    const original = realResolve(target);
    const result = await safeTrash(target);
    if (result.startsWith('Moved to Trash')) {
      ctx.undo.push(`deleted ${baseName(original)}`, () => restoreFromTrash(original));
    }
    return result;
  } catch (e) {
    if (isPermErr(e)) return `Permission denied: ${p}`;
    return `Could not delete: ${e.message || e}`;
  }
}

function moveFile(p, name, destination, ctx) {
  try {
    const src = join(resolvePath(p, ctx), name);
    let dst = destination ? resolvePath(destination, ctx) : null;

    if (!exists(src)) return `Source not found: ${baseName(src)}`;
    if (dst == null) return 'No destination specified.';
    if (!isSafePath(src, ctx)) return `Access denied (source): ${src}`;
    if (!isSafePath(dst, ctx)) return `Access denied (destination): ${dst}`;

    if (isDir(dst)) dst = path.join(dst, baseName(src));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const origin = realResolve(src);
    moveSync(src, dst);
    ctx.undo.push(`moved ${baseName(origin)} to ${parentName(dst)}/`, undoMove(origin, realResolve(dst)));
    return `Moved: ${baseName(src)} → ${parentName(dst)}/`;
  } catch (e) {
    return `Could not move: ${e.message || e}`;
  }
}

function copyFile(p, name, destination, ctx) {
  try {
    const src = join(resolvePath(p, ctx), name);
    let dst = destination ? resolvePath(destination, ctx) : null;

    if (!exists(src)) return `Source not found: ${baseName(src)}`;
    if (dst == null) return 'No destination specified.';
    if (!isSafePath(src, ctx)) return `Access denied (source): ${src}`;
    if (!isSafePath(dst, ctx)) return `Access denied (destination): ${dst}`;

    if (isDir(dst)) dst = path.join(dst, baseName(src));
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    if (isDir(src)) {
      // copytree refuses an existing destination.
      if (exists(dst)) throw new Error(`[Errno 17] File exists: '${dst}'`);
      fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    } else {
      fs.cpSync(src, dst, { preserveTimestamps: true });
    }

    // The undo for a copy is deleting the copy — never the original.
    const copy = realResolve(dst);
    ctx.undo.push(`copied ${baseName(src)} to ${parentName(dst)}/`, () => {
      if (!exists(copy)) return `The copy '${baseName(copy)}' is already gone.`;
      if (isDir(copy)) fs.rmSync(copy, { recursive: true, force: true });
      else fs.unlinkSync(copy);
      return `Removed the copy in ${parentName(copy)}/.`;
    });
    return `Copied: ${baseName(src)} → ${parentName(dst)}/`;
  } catch (e) {
    return `Could not copy: ${e.message || e}`;
  }
}

function renameFile(p, name, newName, ctx) {
  try {
    const target = join(resolvePath(p, ctx), name);
    if (!isSafePath(target, ctx)) return `Access denied: ${target}`;
    if (!exists(target)) return `Not found: ${baseName(target)}`;
    if (!newName) return 'No new name provided.';

    const newPath = path.join(path.dirname(target), newName);
    if (exists(newPath)) return `A file named '${newName}' already exists here.`;

    const oldPath = realResolve(target);
    fs.renameSync(target, newPath);
    ctx.undo.push(`renamed ${baseName(oldPath)} to ${newName}`, undoMove(oldPath, realResolve(newPath)));
    return `Renamed: ${baseName(target)} → ${newName}`;
  } catch (e) {
    return `Could not rename: ${e.message || e}`;
  }
}

function readFile(p, name, ctx, maxChars = 4000) {
  try {
    const target = join(resolvePath(p, ctx), name);
    if (!isSafePath(target, ctx)) return `Access denied: ${target}`;
    if (!exists(target)) return `File not found: ${baseName(target)}`;
    if (!isFile(target)) return `Not a file: ${baseName(target)}`;
    let content = fs.readFileSync(target, 'utf-8');
    if (content.length > maxChars) content = `${content.slice(0, maxChars)}\n\n[Truncated — ${content.length} total chars]`;
    return content;
  } catch (e) {
    return `Could not read file: ${e.message || e}`;
  }
}

function writeFile(p, name, content, append, ctx) {
  try {
    const target = join(resolvePath(p, ctx), name);
    if (!isSafePath(target, ctx)) return `Access denied: ${target}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });

    // Snapshot before writing. null means "did not exist", which is a
    // different undo (delete it) from "existed and had this in it".
    let previous = null;
    let undoable = true;
    if (exists(target)) {
      try {
        if (fs.statSync(target).size > UNDO_CONTENT_LIMIT) undoable = false; // too large to hold in memory
        else previous = fs.readFileSync(target, 'utf-8');
      } catch {
        undoable = false; // locked, unreadable
      }
    }

    if (append) fs.appendFileSync(target, content || '', 'utf-8');
    else fs.writeFileSync(target, content || '', 'utf-8');

    const action = append ? 'Appended to' : 'Written to';
    if (undoable) {
      ctx.undo.push(`wrote to ${baseName(target)}`, undoWrite(target, previous));
      return `${action}: ${baseName(target)}`;
    }
    return (
      `${action}: ${baseName(target)}. ` +
      '(Too large to keep a copy of the old contents, so this one cannot be undone.)'
    );
  } catch (e) {
    return `Could not write file: ${e.message || e}`;
  }
}

async function findFiles({ name = '', extension = '', p = 'home', maxResults = 20 }, ctx) {
  try {
    const searchPath = resolvePath(p, ctx);
    if (!isSafePath(searchPath, ctx)) return `Access denied: ${searchPath}`;
    if (!exists(searchPath)) return `Search path not found: ${p}`;

    // Mark compares against the suffix including the dot; accept "pdf" too.
    let ext = String(extension || '').toLowerCase();
    if (ext && !ext.startsWith('.')) ext = `.${ext}`;
    const needle = String(name || '').toLowerCase();

    const results = [];
    let dirCount = 0;
    const maxDirs = 500; // performance + safety limit
    for await (const item of walk(searchPath)) {
      if (item.isDir) {
        dirCount += 1;
        if (dirCount > maxDirs) break;
        continue;
      }
      if (!item.isFile) continue;
      if (ext && path.extname(item.name).toLowerCase() !== ext) continue;
      if (needle && !item.name.toLowerCase().includes(needle)) continue;
      let size = 0;
      try {
        size = (await fsp.stat(item.full)).size;
      } catch {
        continue;
      }
      results.push(`📄 ${item.name} (${formatSize(size)}) — ${path.dirname(item.full)}`);
      if (results.length >= maxResults) break;
    }
    if (!results.length) return `No ${name || extension || 'files'} found in ${baseName(searchPath)}/`;
    return `Found ${results.length} file(s):\n${results.join('\n')}`;
  } catch (e) {
    return `Search error: ${e.message || e}`;
  }
}

async function getLargestFiles(p = 'downloads', count = 10, ctx) {
  count = Math.min(count, 50);
  try {
    const searchPath = resolvePath(p, ctx);
    if (!isSafePath(searchPath, ctx)) return `Access denied: ${searchPath}`;
    if (!exists(searchPath)) return `Path not found: ${p}`;

    const files = [];
    for await (const item of walk(searchPath)) {
      if (!item.isFile) continue;
      try {
        files.push([(await fsp.stat(item.full)).size, item.full]);
      } catch {
        /* vanished or locked */
      }
    }
    files.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : -1));
    const top = files.slice(0, count);
    if (!top.length) return 'No files found.';
    const lines = [`Top ${top.length} largest files in ${baseName(searchPath)}/:`];
    for (const [size, f] of top) lines.push(`  ${formatSize(size).padStart(10)}  ${baseName(f)}  (${path.dirname(f)})`);
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e.message || e}`;
  }
}

function getDiskUsage(p = 'home', ctx) {
  try {
    const target = resolvePath(p, ctx);
    const s = fs.statfsSync(target);
    const total = s.blocks * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    const free = s.bavail * s.bsize;
    const pct = (used / total) * 100;
    return (
      `Disk usage (${target}):\n` +
      `  Total : ${formatSize(total)}\n` +
      `  Used  : ${formatSize(used)} (${pct.toFixed(1)}%)\n` +
      `  Free  : ${formatSize(free)}`
    );
  } catch (e) {
    return `Could not get disk usage: ${e.message || e}`;
  }
}

const TYPE_MAP = {
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.heic'],
  Documents: ['.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.odt', '.ods', '.odp'],
  Videos: ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v'],
  Music: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'],
  Code: ['.py', '.js', '.ts', '.html', '.css', '.json', '.xml', '.cpp', '.java', '.cs', '.go', '.rs', '.sh'],
};

function organizeDesktop(ctx) {
  const desktop = dirs(ctx).desktop;
  const moved = [];
  const skipped = [];
  const journal = []; // [where it was, where it went]
  try {
    for (const n of fs.readdirSync(desktop)) {
      const item = path.join(desktop, n);
      // Leave folders, hidden files and organize-folders untouched.
      if (isDir(item) || n.startsWith('.')) continue;
      if (Object.prototype.hasOwnProperty.call(TYPE_MAP, n)) continue;

      const ext = path.extname(n).toLowerCase();
      let targetDir = path.join(desktop, 'Others');
      for (const [folder, exts] of Object.entries(TYPE_MAP)) {
        if (exts.includes(ext)) {
          targetDir = path.join(desktop, folder);
          break;
        }
      }
      if (!exists(targetDir)) fs.mkdirSync(targetDir);
      const newPath = path.join(targetDir, n);
      if (exists(newPath)) {
        skipped.push(n);
        continue;
      }
      const origin = realResolve(item);
      moveSync(item, newPath);
      journal.push([origin, realResolve(newPath)]);
      moved.push(`${n} → ${baseName(targetDir)}/`);
    }

    // One command, dozens of moves — so one undo that reverses all of them.
    if (journal.length) {
      const entries = journal.slice();
      ctx.undo.push(`organized the desktop (${entries.length} files)`, () => {
        let restored = 0;
        for (const [origin, movedTo] of entries) {
          try {
            if (exists(movedTo)) {
              fs.mkdirSync(path.dirname(origin), { recursive: true });
              moveSync(movedTo, origin);
              restored += 1;
            }
          } catch (e) {
            console.warn(`[file] undo organize: ${baseName(movedTo)}: ${e.message || e}`);
          }
        }
        // Clear away the folders we used, but only while they are empty —
        // anything the user put in since stays.
        for (const folder of new Set(entries.map(([, m]) => path.dirname(m)))) {
          try {
            if (isDir(folder) && !fs.readdirSync(folder).length) fs.rmdirSync(folder);
          } catch {
            /* leave it */
          }
        }
        return `${restored} file(s) put back on the desktop.`;
      });
    }

    let result = `Desktop organized: ${moved.length} files moved.`;
    if (moved.length) {
      result += `\n${moved.slice(0, 8).join('\n')}`;
      if (moved.length > 8) result += `\n... and ${moved.length - 8} more.`;
    }
    if (skipped.length) result += `\n${skipped.length} file(s) skipped (name conflict).`;
    return result;
  } catch (e) {
    return `Could not organize desktop: ${e.message || e}`;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function getFileInfo(p, name, ctx) {
  try {
    const target = join(resolvePath(p, ctx), name);
    if (!isSafePath(target, ctx)) return `Access denied: ${target}`;
    if (!exists(target)) return `Not found: ${baseName(target)}`;
    const st = fs.statSync(target);
    const info = {
      Name: baseName(target),
      Type: st.isDirectory() ? 'Folder' : 'File',
      Size: formatSize(st.size),
      Location: path.dirname(target),
      // st_ctime is the creation time on Windows, which is what Mark shows.
      Created: fmtDate(IS_WIN ? st.birthtime : st.ctime),
      Modified: fmtDate(st.mtime),
      Extension: path.extname(target) || '—',
    };
    return Object.entries(info)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');
  } catch (e) {
    return `Could not get file info: ${e.message || e}`;
  }
}

const truthy = (v) => v === true || (typeof v === 'string' && ['true', '1', 'yes'].includes(v.toLowerCase().trim()));
const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

async function run(parameters, ctx) {
  const params = parameters || {};
  const action = String(params.action || '').toLowerCase().trim();
  const p = params.path || 'desktop';
  const name = params.name || '';

  ctx?.ui?.log(`[file] ${action} ${name || p}`);

  try {
    switch (action) {
      case 'list':
        return listFiles(p, ctx);
      case 'create_file':
        return createFile(p, name, params.content || '', ctx);
      case 'create_folder':
        return createFolder(p, name, ctx);
      case 'delete':
        return await deleteFile(p, name, ctx);
      case 'move':
        return moveFile(p, name, params.destination || '', ctx);
      case 'copy':
        return copyFile(p, name, params.destination || '', ctx);
      case 'rename':
        return renameFile(p, name, params.new_name || '', ctx);
      case 'read':
        return readFile(p, name, ctx);
      case 'write':
        return writeFile(p, name, params.content || '', truthy(params.append), ctx);
      case 'find':
        return await findFiles(
          { name, extension: params.extension || '', p, maxResults: Math.min(toInt(params.max_results, 20), 50) },
          ctx,
        );
      case 'largest':
        return await getLargestFiles(p, toInt(params.count, 10), ctx);
      case 'disk_usage':
        return getDiskUsage(p, ctx);
      case 'organize_desktop':
        return organizeDesktop(ctx);
      case 'info':
        return getFileInfo(p, name, ctx);
      default:
        return `Unknown action: '${action}'`;
    }
  } catch (e) {
    return `File controller error (${action}): ${e?.message || e}`;
  }
}

module.exports = {
  TOOL: {
    name: 'file_controller',
    description: 'Manages files and folders: list, create, delete, move, copy, rename, read, write, find, disk usage.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: {
          type: 'STRING',
          description:
            'list | create_file | create_folder | delete | move | copy | rename | read | write | find | largest | disk_usage | organize_desktop | info',
        },
        path: { type: 'STRING', description: 'File/folder path or shortcut: desktop, downloads, documents, home' },
        destination: { type: 'STRING', description: 'Destination path for move/copy' },
        new_name: { type: 'STRING', description: 'New name for rename' },
        content: { type: 'STRING', description: 'Content for create_file/write' },
        name: { type: 'STRING', description: 'File name to search for' },
        extension: { type: 'STRING', description: 'File extension to search (e.g. .pdf)' },
        count: { type: 'INTEGER', description: 'Number of results for largest' },
      },
      required: ['action'],
    },
  },
  run,
  // Shared with other actions that need Mark's path shortcuts and home fence.
  resolvePath,
  isSafePath,
  formatSize,
};
