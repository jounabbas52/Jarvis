// file_processor — the Node port of Mark LIV's actions/file_processor.py.
//
// Works on the file the user dropped on the HUD (index.js fills in
// args.file_path from ctx.currentFile) or any path given. Document reading is
// done locally (pdf-parse, mammoth, xlsx, jszip); the thinking goes to Gemini
// on the SMART tier with Mark's 90 s deadline, because the input can be a
// whole file. Image work uses Electron's nativeImage in place of Pillow, and
// audio/video work uses ffmpeg/ffprobe from PATH, as Mark does.
//
// Heavy packages are required lazily so one missing package costs one format.

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const GEMINI_TIMEOUT_MS = 90_000;

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Mark's _gemini_client(): SMART tier, 90 s, and an error if nothing answered. */
async function generate(ctx, contents) {
  const g = ctx.gemini;
  const text = await g.text(contents, { tier: g.SMART, timeoutMs: GEMINI_TIMEOUT_MS });
  if (!text) throw new Error('every Gemini model on the ladder failed');
  return text.trim();
}

function detectType(p) {
  const ext = path.extname(p).toLowerCase().replace(/^\./, '');
  const image = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'ico'];
  const video = ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm', 'm4v', '3gp'];
  const audio = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma', 'opus'];
  const code = ['py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'rb', 'php',
    'swift', 'kt', 'sh', 'bash', 'ps1', 'lua', 'r', 'm', 'sql', 'yaml', 'toml'];
  const archive = ['zip', 'rar', 'tar', 'gz', '7z', 'bz2', 'xz'];
  if (image.includes(ext)) return 'image';
  if (video.includes(ext)) return 'video';
  if (audio.includes(ext)) return 'audio';
  if (code.includes(ext)) return 'code';
  if (archive.includes(ext)) return 'archive';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (['txt', 'md', 'rst', 'log'].includes(ext)) return 'text';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (['xlsx', 'xls', 'ods'].includes(ext)) return 'excel';
  if (ext === 'json') return 'json';
  if (ext === 'xml') return 'xml';
  if (ext === 'pptx' || ext === 'ppt') return 'pptx';
  return 'unknown';
}

function fileSizeStr(p) {
  const size = fs.statSync(p).size;
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

/** <stem>_<suffix><ext> next to the source. */
function outputPath(src, suffix, newExt) {
  const ext = newExt || path.extname(src);
  const stem = path.basename(src, path.extname(src));
  return path.join(path.dirname(src), `${stem}_${suffix}${ext}`);
}

const writeText = (p, text) => fs.writeFileSync(p, text, 'utf-8');
const saveWanted = (params) => params.save !== false && String(params.save).toLowerCase() !== 'false';
const errMsg = (e) => e?.message || String(e);

/** Mark saves long answers next to the file and returns the head of them. */
function maybeSave(src, name, result, params, limit, head, label = 'Full result saved') {
  if (result.length > limit && saveWanted(params)) {
    const out = outputPath(src, name, '.txt');
    writeText(out, result);
    return `${result.slice(0, head)}...\n\n${label}: ${path.basename(out)}`;
  }
  return result;
}

function toolPath(name) {
  // Windows ships bsdtar in System32; Git's GNU tar on PATH misreads "C:\".
  if (name === 'tar' && IS_WIN) {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return name;
}

async function exec(file, args, timeout) {
  const { run } = require('../util/ps');
  return run(toolPath(file), args, { timeout });
}

/**
 * subprocess.run(capture_output=True, timeout=...): argument array, no shell,
 * and it says whether the program was missing or ran out of time.
 */
function runCapture(file, args, timeout, cwd) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          missing: Boolean(err && err.code === 'ENOENT'),
          timedOut: Boolean(err && err.killed),
        });
      },
    );
  });
}

async function ffmpegAvailable() {
  const r = await exec('ffmpeg', ['-version'], 5_000);
  return r.ok;
}

/** "90", "1:30", "00:01:30" → seconds. */
function toSeconds(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s.includes(':')) return s.split(':').reduce((acc, part) => acc * 60 + (parseFloat(part) || 0), 0);
  return parseFloat(s) || 0;
}

// ── Images ───────────────────────────────────────────────────────────────────
const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', tiff: 'image/tiff', svg: 'image/svg+xml', ico: 'image/x-icon',
};
const GEMINI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function nativeImageOf(p) {
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(p);
    return img && !img.isEmpty() ? img : null;
  } catch {
    return null;
  }
}

/** Image bytes Gemini accepts. PIL re-encoded anything it opened; do the same for formats Gemini refuses. */
function imagePart(p) {
  const ext = path.extname(p).toLowerCase().slice(1);
  let mimeType = IMAGE_MIME[ext] || 'image/png';
  let data = fs.readFileSync(p);
  if (!GEMINI_IMAGE_TYPES.has(mimeType)) {
    const img = nativeImageOf(p);
    if (img) {
      data = img.toPNG();
      mimeType = 'image/png';
    }
  }
  return { inlineData: { mimeType, data: data.toString('base64') } };
}

/** Format, size and colour mode from the file header (what PIL's Image.open reports). */
function imageHeader(p) {
  const b = fs.readFileSync(p);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    const modes = { 0: 'L', 2: 'RGB', 3: 'P', 4: 'LA', 6: 'RGBA' };
    return { format: 'PNG', w: b.readUInt32BE(16), h: b.readUInt32BE(20), mode: modes[b[25]] || '?' };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const comps = b[i + 9];
        return { format: 'JPEG', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), mode: { 1: 'L', 3: 'RGB', 4: 'CMYK' }[comps] || '?' };
      }
      i += 2 + len;
    }
  }
  if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') {
    return { format: 'GIF', w: b.readUInt16LE(6), h: b.readUInt16LE(8), mode: 'P' };
  }
  if (b.length > 26 && b.toString('ascii', 0, 2) === 'BM') {
    const bpp = b.readUInt16LE(28);
    return { format: 'BMP', w: b.readInt32LE(18), h: Math.abs(b.readInt32LE(22)), mode: bpp === 32 ? 'RGBA' : bpp <= 8 ? 'P' : 'RGB' };
  }
  const img = nativeImageOf(p);
  if (img) {
    const { width, height } = img.getSize();
    return { format: path.extname(p).slice(1).toUpperCase(), w: width, h: height, mode: 'RGBA' };
  }
  return null;
}

/** Encode a nativeImage for the given extension; null when it cannot be written. */
function encodeImage(img, ext, quality = 90) {
  ext = ext.toLowerCase().replace(/^\./, '');
  if (ext === 'png') return img.toPNG();
  if (ext === 'jpg' || ext === 'jpeg') return img.toJPEG(quality);
  if (ext === 'bmp' && typeof img.toBitmap === 'function') return null; // raw pixels, not a BMP file
  return null;
}

async function processImage(p, action, params, ctx) {
  action = action || 'describe';

  if (['describe', 'ocr', 'analyze', 'read', 'extract_text'].includes(action)) {
    try {
      let prompt =
        {
          describe: 'Describe this image in detail.',
          ocr: 'Extract all text visible in this image. Return only the text, formatted clearly.',
          analyze: 'Analyze this image thoroughly: objects, colors, composition, any text, context.',
          read: 'Read all text in this image, preserving structure and formatting.',
          extract_text: 'Extract all text from this image.',
        }[action] || 'Describe this image.';
      if (params.instruction) prompt = params.instruction;
      const result = await generate(ctx, [{ text: prompt }, imagePart(p)]);
      if (result.length > 500 && saveWanted(params)) {
        const out = outputPath(p, 'result', '.txt');
        writeText(out, result);
        return `${result.slice(0, 300)}...\n\nFull result saved to: ${out}`;
      }
      return result;
    } catch (e) {
      return `AI image analysis failed: ${errMsg(e)}`;
    }
  }

  if (action === 'resize') {
    const width = parseInt(params.width, 10) || 0;
    const height = parseInt(params.height, 10) || 0;
    const scale = parseFloat(params.scale) || 0;
    try {
      const img = nativeImageOf(p);
      if (!img) return 'Resize failed: this image format cannot be opened here (PNG and JPEG work).';
      const { width: w, height: h } = img.getSize();
      let size;
      if (scale) size = [Math.trunc(w * scale), Math.trunc(h * scale)];
      else if (width && height) size = [width, height];
      else if (width) size = [width, Math.trunc((h * width) / w)];
      else if (height) size = [Math.trunc((w * height) / h), height];
      else return 'Please specify width, height, or scale.';
      const resized = img.resize({ width: size[0], height: size[1], quality: 'best' });
      let ext = path.extname(p);
      let data = encodeImage(resized, ext);
      if (!data) {
        ext = '.png';
        data = resized.toPNG();
      }
      const out = outputPath(p, `resized_${size[0]}x${size[1]}`, ext);
      fs.writeFileSync(out, data);
      return `Resized from ${w}x${h} to ${size[0]}x${size[1]}. Saved: ${path.basename(out)}`;
    } catch (e) {
      return `Resize failed: ${errMsg(e)}`;
    }
  }

  if (action === 'convert') {
    const fmt = String(params.format || 'png').toLowerCase().replace(/^\.+/, '');
    try {
      const img = nativeImageOf(p);
      if (!img) return 'Convert failed: this image format cannot be opened here (PNG and JPEG work).';
      const data = encodeImage(img, fmt, 95);
      if (!data) return `Convert failed: writing ${fmt.toUpperCase()} is not supported here — PNG and JPG are.`;
      const out = outputPath(p, 'converted', `.${fmt}`);
      fs.writeFileSync(out, data);
      return `Converted to ${fmt.toUpperCase()}. Saved: ${path.basename(out)}`;
    } catch (e) {
      return `Convert failed: ${errMsg(e)}`;
    }
  }

  if (action === 'compress') {
    const quality = parseInt(params.quality, 10) || 70;
    try {
      const img = nativeImageOf(p);
      if (!img) return 'Compress failed: this image format cannot be opened here (PNG and JPEG work).';
      const out = outputPath(p, `compressed_q${quality}`, '.jpg');
      fs.writeFileSync(out, img.toJPEG(Math.max(1, Math.min(100, quality))));
      return `Compressed: ${fileSizeStr(p)} → ${fileSizeStr(out)}. Saved: ${path.basename(out)}`;
    } catch (e) {
      return `Compress failed: ${errMsg(e)}`;
    }
  }

  if (action === 'info') {
    try {
      const h = imageHeader(p);
      if (!h) throw new Error('cannot identify image file');
      return `Image info: ${h.format}, ${h.w}x${h.h}px, mode: ${h.mode}, size: ${fileSizeStr(p)}`;
    } catch (e) {
      return `Info failed: ${errMsg(e)}`;
    }
  }

  return processImage(p, 'describe', { instruction: `${action}: ${JSON.stringify(params)}` }, ctx);
}

// ── Word output (PDF → Word) ─────────────────────────────────────────────────
const xmlEsc = (s) =>
  String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** A minimal .docx: a title and one paragraph per block (python-docx's add_heading/add_paragraph). */
async function writeDocx(out, title, paragraphs) {
  const JSZip = require('jszip');
  const para = (text, heading) => {
    const runs = String(text)
      .split('\n')
      .map((line, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEsc(line)}</w:t>`)
      .join('');
    const rpr = heading ? '<w:rPr><w:b/><w:sz w:val="52"/></w:rPr>' : '';
    const ppr = heading ? '<w:pPr><w:pStyle w:val="Title"/></w:pPr>' : '';
    return `<w:p>${ppr}<w:r>${rpr}${runs}</w:r></w:p>`;
  };
  const body = [para(title, true), ...paragraphs.map((t) => para(t, false))].join('');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ── PDF ──────────────────────────────────────────────────────────────────────
async function readPdf(p) {
  // The inner module: the package's index.js tries to read a test PDF when it
  // thinks it is being run directly.
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  return pdfParse(fs.readFileSync(p));
}

async function processPdf(p, action, params, ctx) {
  action = action || 'summarize';

  const extractText = async (maxChars = 50_000) => {
    try {
      const data = await readPdf(p);
      return String(data.text || '').slice(0, maxChars);
    } catch (e) {
      console.warn(`[FileProcessor] PDF read failed: ${errMsg(e)}`);
      return '';
    }
  };

  if (['summarize', 'extract_text', 'translate_hint', 'analyze', 'reformat'].includes(action)) {
    const text = await extractText();
    if (!text.trim()) return 'Could not extract text from PDF (may be scanned/image-based).';

    if (action === 'extract_text') {
      const out = outputPath(p, 'text', '.txt');
      writeText(out, text);
      return `Text extracted (${text.length} chars). Saved: ${path.basename(out)}`;
    }
    const prompt = {
      summarize: `Summarize this PDF document concisely:\n\n${text}`,
      analyze: `Analyze this document thoroughly:\n\n${text}`,
      translate_hint: `What language is this document in and what does it say? Summarize:\n\n${text}`,
      reformat: `Reformat this text cleanly with proper structure:\n\n${text}`,
    }[action] || `Analyze:\n\n${text}`;
    try {
      const result = await generate(ctx, prompt);
      return maybeSave(p, action, result, params, 600, 400);
    } catch (e) {
      return `AI analysis failed: ${errMsg(e)}`;
    }
  }

  if (action === 'info') {
    try {
      const data = await readPdf(p);
      return `PDF: ${data.numpages} pages, size: ${fileSizeStr(p)}`;
    } catch {
      return `PDF size: ${fileSizeStr(p)}`;
    }
  }

  if (action === 'to_word') {
    const text = await extractText();
    if (!text) return 'Could not extract text to convert.';
    try {
      const paras = text
        .split('\n\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const out = outputPath(p, 'converted', '.docx');
      await writeDocx(out, path.basename(p, path.extname(p)), paras);
      return `Converted to Word document. Saved: ${path.basename(out)}`;
    } catch (e) {
      return `Convert failed: ${errMsg(e)}`;
    }
  }

  return `Unknown PDF action: '${action}'. Try: summarize, extract_text, info, to_word`;
}

// ── Word documents and plain text ────────────────────────────────────────────
// Paragraph ends, kept apart from line breaks inside a paragraph.
const PARA_END = ' ';

/**
 * mammoth's own raw-text walk drops line breaks (<w:br/>), gluing "one\ntwo"
 * into "onetwo". python-docx keeps them as "\n", so walk the same document
 * tree mammoth builds, with breaks. Falls back to extractRawText if mammoth's
 * internals ever move.
 */
async function docxRawText(p) {
  try {
    const unzip = require('mammoth/lib/unzip');
    const docxReader = require('mammoth/lib/docx/docx-reader');
    const walk = (el) => {
      if (el.type === 'text') return el.value;
      if (el.type === 'tab') return '\t';
      if (el.type === 'break') return '\n';
      if (el.type === 'paragraph') return (el.children || []).map(walk).join('') + PARA_END;
      return (el.children || []).map(walk).join('');
    };
    const result = await unzip.openZip({ path: p }).then(docxReader.read);
    return result.map(walk).value;
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    // Public API: paragraphs end in a blank line, and line breaks are lost.
    const { value } = await require('mammoth').extractRawText({ path: p });
    return String(value || '').split('\n\n').join(PARA_END);
  }
}

async function readDocx(p) {
  const value = String((await docxRawText(p)) || '');
  // python-docx joins paragraphs with one newline.
  const paras = value.split(PARA_END);
  if (paras.length && paras[paras.length - 1] === '') paras.pop();
  return paras.join('\n');
}

async function processTextDoc(p, fileType, action, params, ctx) {
  const requested = action;
  action = action || 'summarize';

  let content;
  if (fileType === 'docx') {
    try {
      content = await readDocx(p);
    } catch (e) {
      return `Read failed: ${errMsg(e)}`;
    }
  } else {
    content = fs.readFileSync(p, 'utf-8');
  }
  if (!content.trim()) return 'File appears to be empty.';

  if (action === 'word_count') {
    const words = content.split(/\s+/).filter(Boolean).length;
    const lines = (content.match(/\n/g) || []).length;
    return `Word count: ${words} words, ${content.length} characters, ${lines} lines.`;
  }

  if (action === 'extract_text') {
    // Mark compares against "txt", which a file type never is, so it always saves.
    const out = outputPath(p, 'extracted', '.txt');
    writeText(out, content);
    return `Text extracted. Saved: ${path.basename(out)}`;
  }

  let instruction = params.instruction || '';
  const c40 = content.slice(0, 40_000);
  const promptMap = {
    summarize: `Summarize this document concisely:\n\n${c40}`,
    analyze: `Analyze this document:\n\n${c40}`,
    reformat: `Reformat this text with clean structure, proper headings and paragraphs:\n\n${c40}`,
    fix: `Fix grammar, spelling and style issues in this text:\n\n${c40}`,
    translate_hint: `What language is this and what does it say? Summarize:\n\n${content.slice(0, 10_000)}`,
    to_bullet: `Convert this text into a clear bullet-point summary:\n\n${c40}`,
  };
  let prompt = promptMap[action];
  if (!prompt) {
    // An action with no prompt of its own is the instruction itself.
    if (!instruction) instruction = requested;
    action = 'custom';
    prompt = `${instruction}\n\n${c40}`;
  }
  try {
    const result = await generate(ctx, prompt);
    return maybeSave(p, action, result, params, 600, 400);
  } catch (e) {
    return `AI processing failed: ${errMsg(e)}`;
  }
}

// ── CSV / Excel ──────────────────────────────────────────────────────────────
function readTable(p) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(p, { cellDates: true, raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { columns: [], rows: [] };
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
  const header = (matrix[0] || []).map((h, i) => (h == null || h === '' ? `Unnamed: ${i}` : String(h)));
  const rows = matrix.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => {
      const v = r[i];
      o[h] = v === undefined || v === '' ? null : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19) : v;
    });
    return o;
  });
  return { columns: header, rows };
}

const pyList = (cols) => `[${cols.map((c) => `'${String(c).replace(/'/g, "\\'")}'`).join(', ')}]`;

function fmtCell(v) {
  if (v == null || (typeof v === 'number' && Number.isNaN(v))) return 'NaN';
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1e6) / 1e6);
  return String(v);
}

/** DataFrame.to_string(): right-aligned columns under a row index. */
function tableString(columns, rows, index = null) {
  const idx = index || rows.map((_, i) => String(i));
  const cells = rows.map((r) => columns.map((c) => fmtCell(r[c])));
  const idxW = Math.max(0, ...idx.map((s) => s.length));
  const widths = columns.map((c, j) => Math.max(String(c).length, ...cells.map((r) => r[j].length)));
  const lines = [[''.padEnd(idxW), ...columns.map((c, j) => String(c).padStart(widths[j]))].join('  ')];
  cells.forEach((r, i) => lines.push([idx[i].padEnd(idxW), ...r.map((v, j) => v.padStart(widths[j]))].join('  ')));
  return lines.join('\n');
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** DataFrame.describe(include="all"). */
function describe(columns, rows) {
  const stats = ['count', 'unique', 'top', 'freq', 'mean', 'std', 'min', '25%', '50%', '75%', 'max'];
  const out = stats.map(() => ({}));
  let anyNumeric = false;
  let anyObject = false;
  for (const c of columns) {
    const vals = rows.map((r) => r[c]).filter((v) => v != null);
    const numeric = vals.length > 0 && vals.every((v) => typeof v === 'number');
    const set = (name, v) => {
      out[stats.indexOf(name)][c] = v;
    };
    set('count', vals.length);
    if (numeric) {
      anyNumeric = true;
      const s = [...vals].sort((a, b) => a - b);
      const mean = s.reduce((a, b) => a + b, 0) / s.length;
      const std = s.length > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length - 1)) : NaN;
      set('mean', mean);
      set('std', std);
      set('min', s[0]);
      set('25%', quantile(s, 0.25));
      set('50%', quantile(s, 0.5));
      set('75%', quantile(s, 0.75));
      set('max', s[s.length - 1]);
    } else {
      anyObject = true;
      const counts = new Map();
      for (const v of vals) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
      let top = null;
      let freq = 0;
      for (const [k, n] of counts) if (n > freq) [top, freq] = [k, n];
      set('unique', counts.size);
      set('top', top);
      set('freq', vals.length ? freq : null);
    }
  }
  // pandas drops the stat rows no column has.
  const keep = stats.filter((s) => {
    if (['unique', 'top', 'freq'].includes(s)) return anyObject;
    if (s === 'count') return true;
    return anyNumeric;
  });
  return tableString(
    columns,
    keep.map((s) => out[stats.indexOf(s)]),
    keep,
  );
}

function writeTable(out, columns, rows, fmt) {
  const XLSX = require('xlsx');
  if (fmt === 'json') {
    writeText(out, JSON.stringify(rows, null, 2));
    return;
  }
  const ws = XLSX.utils.json_to_sheet(rows, { header: columns });
  if (fmt === 'csv') {
    writeText(out, XLSX.utils.sheet_to_csv(ws));
    return;
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, out);
}

async function processData(p, fileType, action, params, ctx) {
  action = action || 'analyze';
  let columns;
  let rows;
  try {
    ({ columns, rows } = readTable(p));
  } catch (e) {
    return `Could not read file: ${errMsg(e)}`;
  }

  if (action === 'info') {
    return `Rows: ${rows.length}, Columns: ${columns.length}\nColumns: ${columns.join(', ')}\nSize: ${fileSizeStr(p)}`;
  }

  if (action === 'stats') {
    try {
      return `Statistics:\n${describe(columns, rows).slice(0, 2000)}`;
    } catch (e) {
      return `Stats failed: ${errMsg(e)}`;
    }
  }

  if (action === 'analyze') {
    const prompt =
      `Analyze this dataset. Columns: ${pyList(columns)}\n` +
      `Rows: ${rows.length}\nPreview:\n${tableString(columns, rows.slice(0, 50))}\n\n` +
      'Give insights, patterns, and notable findings.';
    try {
      return await generate(ctx, prompt);
    } catch (e) {
      return `AI analysis failed: ${errMsg(e)}`;
    }
  }

  if (['convert', 'to_csv', 'to_excel', 'to_json'].includes(action)) {
    const fmt =
      { to_csv: 'csv', to_excel: 'xlsx', to_json: 'json', convert: String(params.format || 'csv').toLowerCase().replace(/^\./, '') }[action] ||
      'csv';
    try {
      const ext = { csv: '.csv', xlsx: '.xlsx', excel: '.xlsx', json: '.json' }[fmt];
      if (!ext) return `Convert failed: unsupported format '${fmt}' (csv, xlsx or json).`;
      const out = outputPath(p, 'converted', ext);
      writeTable(out, columns, rows, ext.slice(1));
      return `Converted to ${fmt.toUpperCase()}. Saved: ${path.basename(out)}`;
    } catch (e) {
      return `Convert failed: ${errMsg(e)}`;
    }
  }

  if (action === 'filter') {
    const col = params.column || '';
    const value = params.value ?? '';
    const condition = params.condition || 'equals';
    if (!col || !columns.includes(col)) return `Column '${col}' not found. Available: ${columns.join(', ')}`;
    try {
      let test;
      if (condition === 'contains') {
        const needle = String(value).toLowerCase();
        test = (v) => v != null && String(v).toLowerCase().includes(needle);
      } else if (condition === 'gt' || condition === 'lt') {
        const n = parseFloat(value);
        if (Number.isNaN(n)) throw new Error(`could not convert string to float: '${value}'`);
        test = (v) => v != null && v !== '' && !Number.isNaN(Number(v)) && (condition === 'gt' ? Number(v) > n : Number(v) < n);
      } else {
        test = (v) => v != null && String(v) === String(value);
      }
      const filtered = rows.filter((r) => test(r[col]));
      const out = outputPath(p, 'filtered', '.csv');
      writeTable(out, columns, filtered, 'csv');
      return `Filtered: ${filtered.length} rows match. Saved: ${path.basename(out)}`;
    } catch (e) {
      return `Filter failed: ${errMsg(e)}`;
    }
  }

  if (action === 'sort') {
    const col = params.column || columns[0];
    const asc = !(params.ascending === false || String(params.ascending).toLowerCase() === 'false');
    try {
      if (!columns.includes(col)) throw new Error(`'${col}'`);
      const cmp = (a, b) => {
        // pandas puts missing values last either way.
        if (a == null) return b == null ? 0 : 1;
        if (b == null) return -1;
        const r = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
        return asc ? r : -r;
      };
      const sorted = [...rows].sort((x, y) => cmp(x[col], y[col]));
      const ext = path.extname(p).toLowerCase();
      const out = outputPath(p, 'sorted', ext);
      writeTable(out, columns, sorted, ext === '.csv' || ext === '.tsv' ? 'csv' : 'xlsx');
      return `Sorted by '${col}'. Saved: ${path.basename(out)}`;
    } catch (e) {
      return `Sort failed: ${errMsg(e)}`;
    }
  }

  try {
    return await generate(
      ctx,
      `Task: ${action}\nDataset (${rows.length} rows, cols: ${pyList(columns)}):\n${tableString(columns, rows.slice(0, 30))}`,
    );
  } catch (e) {
    return `Processing failed: ${errMsg(e)}`;
  }
}

// ── JSON / XML ───────────────────────────────────────────────────────────────
const pyType = (d) =>
  d === null ? 'NoneType' : Array.isArray(d) ? 'list' : typeof d === 'object' ? 'dict' : typeof d === 'string' ? 'str'
    : typeof d === 'boolean' ? 'bool' : Number.isInteger(d) ? 'int' : 'float';

async function processJson(p, action, params, ctx) {
  action = action || 'analyze';
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return `Invalid JSON: ${errMsg(e)}`;
  }

  if (action === 'validate') return `Valid JSON. Type: ${pyType(data)}, size: ${fileSizeStr(p)}`;

  if (action === 'format') {
    const out = outputPath(p, 'formatted', '.json');
    writeText(out, JSON.stringify(data, null, 2));
    return `Formatted JSON saved: ${path.basename(out)}`;
  }

  if (['analyze', 'summarize', 'extract'].includes(action)) {
    const preview = JSON.stringify(data, null, 2).slice(0, 8000);
    let prompt = `Task: ${action} this JSON data:\n${preview}`;
    if (params.instruction) prompt = `${params.instruction}\n\nJSON data:\n${preview}`;
    try {
      return await generate(ctx, prompt);
    } catch (e) {
      return `AI processing failed: ${errMsg(e)}`;
    }
  }

  if (action === 'to_csv') {
    if (!Array.isArray(data)) return 'JSON must be an array of objects to convert to CSV.';
    try {
      const cols = [];
      for (const r of data) if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
      const rows = data.map((r) => (r && typeof r === 'object' ? r : { 0: r }));
      const out = outputPath(p, 'converted', '.csv');
      writeTable(out, cols.length ? cols : ['0'], rows, 'csv');
      return `Converted to CSV. Saved: ${path.basename(out)}`;
    } catch (e) {
      return `Convert failed: ${errMsg(e)}`;
    }
  }

  return processJson(p, 'analyze', { instruction: action }, ctx);
}

/**
 * Mark hands XML to the JSON reader, which can only ever answer "Invalid
 * JSON". Here it gets the same actions over its text instead.
 */
async function processXml(p, action, params, ctx) {
  action = action || 'analyze';
  const content = fs.readFileSync(p, 'utf-8');
  if (action === 'validate') {
    const ok = /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<([A-Za-z_][\w:.-]*)[\s\S]*<\/\3>\s*$/.test(content) ||
      /^\s*(<\?xml[^>]*\?>\s*)?<[A-Za-z_][\w:.-]*[^>]*\/>\s*$/.test(content);
    return ok ? `Looks like well-formed XML. Size: ${fileSizeStr(p)}` : 'This does not look like well-formed XML.';
  }
  const preview = content.slice(0, 8000);
  let prompt = `Task: ${action} this XML data:\n${preview}`;
  if (params.instruction) prompt = `${params.instruction}\n\nXML data:\n${preview}`;
  try {
    return await generate(ctx, prompt);
  } catch (e) {
    return `AI processing failed: ${errMsg(e)}`;
  }
}

// ── Code ─────────────────────────────────────────────────────────────────────
function pythonCandidates() {
  return IS_WIN ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
}

async function processCode(p, action, params, ctx) {
  action = action || 'explain';
  const content = fs.readFileSync(p, 'utf-8');
  const ext = path.extname(p).replace(/^\./, '');

  if (action === 'run') {
    if (ext === 'py') {
      try {
        for (const [exe, pre] of pythonCandidates()) {
          const r = await runCapture(exe, [...pre, p], 30_000, path.dirname(p));
          if (r.missing) continue;
          if (r.timedOut) return 'Execution timed out (30s).';
          const out = r.stdout || r.stderr;
          return out ? `Output:\n${out.slice(0, 2000)}` : 'No output.';
        }
        return 'Run failed: no Python interpreter was found.';
      } catch (e) {
        return `Run failed: ${errMsg(e)}`;
      }
    }
    return `Direct execution not supported for .${ext} files.`;
  }

  if (action === 'info') {
    const lines = (content.match(/\n/g) || []).length;
    const words = content.split(/\s+/).filter(Boolean).length;
    return `Code file: ${lines} lines, ${words} words, ${fileSizeStr(p)}`;
  }

  const body = `\`\`\`${ext}\n${content.slice(0, 30_000)}\n\`\`\``;
  const promptMap = {
    explain: `Explain this ${ext} code clearly:\n\n${body}`,
    review: `Review this ${ext} code for bugs, issues, and improvements:\n\n${body}`,
    fix: `Fix any bugs in this ${ext} code and return the corrected version:\n\n${body}`,
    optimize: `Optimize this ${ext} code for performance and readability:\n\n${body}`,
    document: `Add proper documentation/comments to this ${ext} code:\n\n${body}`,
    summarize: `Summarize what this ${ext} code does:\n\n${body}`,
    test: `Write unit tests for this ${ext} code:\n\n${body}`,
  };
  const instruction = params.instruction || '';
  let prompt = promptMap[action];
  if (!prompt) prompt = instruction ? `${instruction}\n\n${body}` : `${action}\n\n${body}`;

  try {
    const result = await generate(ctx, prompt);
    if (['fix', 'optimize', 'document'].includes(action) && saveWanted(params)) {
      const out = outputPath(p, action);
      const m = /```(?:\w+)?\n([\s\S]*?)```/.exec(result);
      writeText(out, m ? m[1] : result);
      return `${result.slice(0, 400)}...\n\nSaved: ${path.basename(out)}`;
    }
    return result;
  } catch (e) {
    return `AI processing failed: ${errMsg(e)}`;
  }
}

// ── Audio ────────────────────────────────────────────────────────────────────
async function ffprobe(p) {
  const r = await exec('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', p], 10_000);
  if (!r.ok && !r.stdout) return null;
  return JSON.parse(r.stdout);
}

async function transcribeAudio(p, params, ctx, saveBase = p) {
  try {
    const mime =
      { mp3: 'audio/mp3', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' }[
        path.extname(p).slice(1).toLowerCase()
      ] || 'audio/mpeg';
    const data = fs.readFileSync(p).toString('base64');
    const result = await generate(ctx, [
      { text: 'Transcribe all speech in this audio file accurately.' },
      { inlineData: { mimeType: mime, data } },
    ]);
    if (saveWanted(params)) {
      const out = outputPath(saveBase, 'transcript', '.txt');
      writeText(out, result);
      return `Transcription saved: ${path.basename(out)}\n\nPreview: ${result.slice(0, 300)}`;
    }
    return result;
  } catch (e) {
    return `Transcription failed: ${errMsg(e)}`;
  }
}

async function processAudio(p, action, params, ctx) {
  action = action || 'transcribe';

  if (action === 'info') {
    try {
      const data = await ffprobe(p);
      if (!data) return `Audio file: ${fileSizeStr(p)} (install ffmpeg for more info)`;
      const s = (data.streams || []).find((x) => x.codec_type === 'audio') || {};
      const duration = Math.trunc(parseFloat(data.format?.duration || '0'));
      return `Audio: ${Math.floor(duration / 60)}m ${duration % 60}s, ${s.channels ?? '?'} ch, ${s.sample_rate ?? '?'}Hz, ${fileSizeStr(p)}`;
    } catch (e) {
      return `Info failed: ${errMsg(e)}`;
    }
  }

  if (action === 'transcribe') return transcribeAudio(p, params, ctx);

  if (action === 'convert') {
    const fmt = String(params.format || 'mp3').replace(/^\./, '');
    if (!(await ffmpegAvailable())) return 'ffmpeg not found. Install ffmpeg to convert audio.';
    const out = outputPath(p, 'converted', `.${fmt}`);
    const r = await exec('ffmpeg', ['-i', p, out, '-y'], 600_000);
    if (!r.ok || !fs.existsSync(out)) return `Convert failed: ${r.stderr.trim().split('\n').pop() || 'ffmpeg failed'}`;
    return `Converted to ${fmt.toUpperCase()}. Saved: ${path.basename(out)}`;
  }

  if (action === 'trim') {
    const start = toSeconds(params.start);
    const end = toSeconds(params.end);
    if (!(await ffmpegAvailable())) return 'ffmpeg not found. Install ffmpeg to trim audio.';
    const out = outputPath(p, `trim_${Math.trunc(start)}s_${Math.trunc(end)}s`);
    const args = ['-i', p, '-ss', String(start)];
    if (end) args.push('-to', String(end));
    args.push(out, '-y');
    const r = await exec('ffmpeg', args, 600_000);
    if (!r.ok || !fs.existsSync(out)) return `Trim failed: ${r.stderr.trim().split('\n').pop() || 'ffmpeg failed'}`;
    return `Trimmed audio (${Math.trunc(start)}s–${Math.trunc(end)}s). Saved: ${path.basename(out)}`;
  }

  return `Unknown audio action: '${action}'. Try: transcribe, info, convert, trim`;
}

// ── Video ────────────────────────────────────────────────────────────────────
async function processVideo(p, action, params, ctx) {
  action = action || 'info';
  const fail = (r) => r.stderr.trim().split('\n').pop() || 'ffmpeg failed';

  if (action === 'info') {
    try {
      const data = await ffprobe(p);
      if (!data) throw new Error('no ffprobe');
      const duration = Math.trunc(parseFloat(data.format?.duration || '0'));
      const v = (data.streams || []).find((s) => s.codec_type === 'video') || {};
      return `Video: ${Math.floor(duration / 60)}m ${duration % 60}s, ${v.width ?? '?'}x${v.height ?? '?'}, ${v.r_frame_rate ?? '?'} fps, ${fileSizeStr(p)}`;
    } catch {
      return `Video file: ${fileSizeStr(p)}`;
    }
  }

  if (action === 'extract_audio') {
    if (!(await ffmpegAvailable())) return 'ffmpeg not found. Install ffmpeg to extract audio.';
    const out = outputPath(p, 'audio', '.mp3');
    const r = await exec('ffmpeg', ['-i', p, '-q:a', '0', '-map', 'a', out, '-y'], 300_000);
    if (!r.ok || !fs.existsSync(out)) return `Extract audio failed: ${fail(r)}`;
    return `Audio extracted. Saved: ${path.basename(out)}`;
  }

  if (action === 'trim') {
    const start = params.start || '00:00:00';
    const end = params.end || '';
    if (!(await ffmpegAvailable())) return 'ffmpeg not found.';
    const out = outputPath(p, 'trim', path.extname(p));
    const args = ['-i', p, '-ss', String(start)];
    if (end) args.push('-to', String(end));
    args.push('-c', 'copy', out, '-y');
    const r = await exec('ffmpeg', args, 600_000);
    if (!r.ok || !fs.existsSync(out)) return `Trim failed: ${fail(r)}`;
    return `Trimmed video saved: ${path.basename(out)}`;
  }

  if (action === 'extract_frame') {
    const timestamp = String(params.timestamp || '00:00:01');
    if (!(await ffmpegAvailable())) return 'ffmpeg not found.';
    const out = outputPath(p, `frame_${timestamp.replace(/:/g, '')}`, '.jpg');
    const r = await exec('ffmpeg', ['-i', p, '-ss', timestamp, '-vframes', '1', out, '-y'], 30_000);
    if (!r.ok || !fs.existsSync(out)) return `Extract frame failed: ${fail(r)}`;
    return `Frame extracted at ${timestamp}. Saved: ${path.basename(out)}`;
  }

  if (action === 'compress') {
    const crf = parseInt(params.quality, 10) || 28;
    if (!(await ffmpegAvailable())) return 'ffmpeg not found.';
    const out = outputPath(p, `compressed_crf${crf}`, '.mp4');
    const r = await exec(
      'ffmpeg',
      ['-i', p, '-c:v', 'libx264', '-crf', String(crf), '-preset', 'medium', '-c:a', 'copy', out, '-y'],
      1_800_000,
    );
    if (!r.ok || !fs.existsSync(out)) return `Compress failed: ${fail(r)}`;
    return `Compressed: ${fileSizeStr(p)} → ${fileSizeStr(out)}. Saved: ${path.basename(out)}`;
  }

  if (action === 'transcribe') {
    if (!(await ffmpegAvailable())) return 'ffmpeg not found. Needed for video transcription.';
    const tmp = path.join(os.tmpdir(), `mark_${process.pid}_${Date.now()}.mp3`);
    try {
      const r = await exec('ffmpeg', ['-i', p, '-q:a', '0', '-map', 'a', tmp, '-y'], 300_000);
      if (!fs.existsSync(tmp)) return `Video transcription failed: ${fail(r)}`;
      // The transcript is named after the video, not the temporary audio.
      return await transcribeAudio(tmp, params, ctx, p);
    } catch (e) {
      return `Video transcription failed: ${errMsg(e)}`;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* never made */
      }
    }
  }

  if (action === 'convert') {
    const fmt = String(params.format || 'mp4').replace(/^\./, '');
    if (!(await ffmpegAvailable())) return 'ffmpeg not found.';
    const out = outputPath(p, 'converted', `.${fmt}`);
    const r = await exec('ffmpeg', ['-i', p, out, '-y'], 1_800_000);
    if (!r.ok || !fs.existsSync(out)) return `Convert failed: ${fail(r)}`;
    return `Converted to ${fmt.toUpperCase()}. Saved: ${path.basename(out)}`;
  }

  return `Unknown video action: '${action}'. Try: info, trim, extract_audio, extract_frame, compress, transcribe, convert`;
}

// ── Archives ─────────────────────────────────────────────────────────────────
const TAR_EXTS = ['.tar', '.gz', '.bz2', '.xz'];

async function processArchive(p, action, params) {
  action = action || 'list';
  const ext = path.extname(p).toLowerCase();

  if (action === 'list') {
    try {
      let names;
      if (ext === '.zip') {
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(fs.readFileSync(p));
        names = Object.keys(zip.files);
      } else if (TAR_EXTS.includes(ext)) {
        const r = await exec('tar', ['-tf', p], 60_000);
        if (!r.ok) throw new Error(r.stderr.trim() || 'tar could not read it');
        names = r.stdout.split(/\r?\n/).filter(Boolean);
      } else {
        return `Unsupported archive format: ${ext}`;
      }
      const preview = names.slice(0, 30).join('\n');
      const more = names.length > 30 ? `\n... and ${names.length - 30} more` : '';
      return `Archive contains ${names.length} files:\n${preview}${more}`;
    } catch (e) {
      return `List failed: ${errMsg(e)}`;
    }
  }

  if (action === 'extract') {
    const dest = path.resolve(params.destination || path.join(path.dirname(p), path.basename(p, path.extname(p))));
    fs.mkdirSync(dest, { recursive: true });
    try {
      const lower = p.toLowerCase();
      if (ext === '.zip') {
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(fs.readFileSync(p));
        for (const entry of Object.values(zip.files)) {
          const target = path.resolve(dest, entry.name);
          // Never let an entry climb out of the destination ("zip slip").
          const rel = path.relative(dest, target);
          if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
          if (entry.dir) fs.mkdirSync(target, { recursive: true });
          else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, await entry.async('nodebuffer'));
          }
        }
      } else if (/\.(tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/.test(lower)) {
        const r = await exec('tar', ['-xf', p, '-C', dest], 600_000);
        if (!r.ok) throw new Error(r.stderr.trim() || 'tar failed');
      } else {
        throw new Error(`Unknown archive format '${p}'`);
      }
      return `Extracted to: ${dest}`;
    } catch (e) {
      return `Extract failed: ${errMsg(e)}`;
    }
  }

  return `Unknown archive action: '${action}'. Try: list, extract`;
}

// ── Presentations ────────────────────────────────────────────────────────────
const decodeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Text of every shape on every slide, in presentation order (python-pptx's shape.text). */
async function readPptxText(p) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(p));

  let slides = [];
  try {
    const pres = await zip.file('ppt/presentation.xml').async('string');
    const rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
    const targets = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
      if (id && target) targets[id] = target.replace(/^\/?ppt\//, '').replace(/^\//, '');
    }
    for (const m of pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
      if (targets[m[1]]) slides.push(`ppt/${targets[m[1]]}`);
    }
  } catch {
    slides = [];
  }
  if (!slides.length) {
    slides = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  }

  const out = [];
  for (let i = 0; i < slides.length; i++) {
    const f = zip.file(slides[i]);
    if (!f) continue;
    const xml = await f.async('string');
    let slideText = `\n--- Slide ${i + 1} ---\n`;
    for (const body of xml.matchAll(/<(p|a):txBody>([\s\S]*?)<\/\1:txBody>/g)) {
      const paras = [...body[2].matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\/>/g)].map((pm) =>
        [...(pm[1] || '').matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:t\/>|<a:br\/>/g)]
          .map((t) => (t[0] === '<a:br/>' ? '\v' : decodeXml(t[1] || '')))
          .join(''),
      );
      const text = paras.join('\n').trim();
      if (text) slideText += `${text}\n`;
    }
    out.push(slideText);
  }
  return out.join('\n');
}

async function processPptx(p, action, params, ctx) {
  action = action || 'summarize';
  if (['summarize', 'extract_text', 'analyze'].includes(action)) {
    let text;
    try {
      text = await readPptxText(p);
    } catch (e) {
      return `Could not read presentation: ${errMsg(e)}`;
    }
    if (action === 'extract_text') {
      const out = outputPath(p, 'text', '.txt');
      writeText(out, text);
      return `Text extracted. Saved: ${path.basename(out)}`;
    }
    try {
      return await generate(
        ctx,
        `${action === 'summarize' ? 'Summarize' : 'Analyze'} this presentation:\n${text.slice(0, 30_000)}`,
      );
    } catch (e) {
      return `AI processing failed: ${errMsg(e)}`;
    }
  }
  return `Unknown PPTX action: '${action}'. Try: summarize, extract_text, analyze`;
}

// ── Entry ────────────────────────────────────────────────────────────────────
async function run(parameters, ctx) {
  parameters = parameters || {};
  const filePathStr = String(parameters.file_path || '').trim();
  if (!filePathStr) return 'No file path provided.';

  const p = path.resolve(filePathStr);
  if (!fs.existsSync(p)) return `File not found: ${filePathStr}`;
  if (!fs.statSync(p).isFile()) return `Path is not a file: ${filePathStr}`;

  const fileType = detectType(p);
  const action = String(parameters.action || '').toLowerCase().trim();
  const instruction = parameters.instruction || '';
  const params = { ...parameters, instruction };

  const logMsg = `[FileProcessor] ${fileType.toUpperCase()} | ${path.basename(p)} | action=${action || 'auto'}`;
  console.log(logMsg);
  ctx?.ui?.log(logMsg);

  if (fileType === 'unknown') {
    try {
      const content = fs.readFileSync(p, 'utf-8').slice(0, 10_000);
      const prompt =
        `File: ${path.basename(p)}\nContent preview:\n${content}\n\n` +
        `Task: ${action || instruction || 'Describe what this file contains and what can be done with it.'}`;
      return await generate(ctx, prompt);
    } catch (e) {
      return `Unknown file type (${path.extname(p)}). Could not process: ${errMsg(e)}`;
    }
  }

  const dispatch = {
    image: () => processImage(p, action, params, ctx),
    pdf: () => processPdf(p, action, params, ctx),
    docx: () => processTextDoc(p, 'docx', action, params, ctx),
    text: () => processTextDoc(p, 'text', action, params, ctx),
    csv: () => processData(p, 'csv', action, params, ctx),
    excel: () => processData(p, 'excel', action, params, ctx),
    json: () => processJson(p, action, params, ctx),
    xml: () => processXml(p, action, params, ctx),
    code: () => processCode(p, action, params, ctx),
    audio: () => processAudio(p, action, params, ctx),
    video: () => processVideo(p, action, params, ctx),
    archive: () => processArchive(p, action, params, ctx),
    pptx: () => processPptx(p, action, params, ctx),
  };
  const handler = dispatch[fileType];
  if (!handler) return `Unsupported file type: ${fileType}`;
  try {
    return (await handler()) || 'Done.';
  } catch (e) {
    console.error(e);
    return `Processing failed: ${errMsg(e)}`;
  }
}

module.exports = {
  TOOL: {
    name: 'file_processor',
    description:
      'Processes any file that the user has uploaded or dropped onto the interface. Use this when the user refers to an uploaded file and wants an action on it. Supports: images (describe/ocr/resize/compress/convert), PDFs (summarize/extract_text/to_word), Word docs & text files (summarize/fix/reformat/translate), CSV/Excel (analyze/stats/filter/sort/convert), JSON/XML (validate/format/analyze), code files (explain/review/fix/optimize/run/document/test), audio (transcribe/trim/convert/info), video (trim/extract_audio/extract_frame/compress/transcribe/info), archives (list/extract), presentations (summarize/extract_text). ALWAYS call this tool when a file has been uploaded and the user gives a command about it. If the user\'s command is ambiguous, pick the most logical action for that file type.',
    parameters: {
      type: 'OBJECT',
      properties: {
        file_path: {
          type: 'STRING',
          description: 'Full path to the uploaded file. Leave empty to use the currently uploaded file.',
        },
        action: {
          type: 'STRING',
          description:
            'What to do with the file. Examples by type:\nimage: describe | ocr | resize | compress | convert | info\npdf: summarize | extract_text | to_word | info\ndocx/txt: summarize | fix | reformat | translate_hint | word_count | to_bullet\ncsv/excel: analyze | stats | filter | sort | convert | info\njson: validate | format | analyze | to_csv\ncode: explain | review | fix | optimize | run | document | test\naudio: transcribe | trim | convert | info\nvideo: trim | extract_audio | extract_frame | compress | transcribe | info | convert\narchive: list | extract\npptx: summarize | extract_text | analyze',
        },
        instruction: {
          type: 'STRING',
          description:
            "Free-form instruction if action doesn't cover it. E.g. 'translate this to Turkish', 'find all email addresses'",
        },
        format: { type: 'STRING', description: "Target format for conversion. E.g. 'mp3', 'pdf', 'csv', 'png'" },
        width: { type: 'INTEGER', description: 'Target width for image resize' },
        height: { type: 'INTEGER', description: 'Target height for image resize' },
        scale: { type: 'NUMBER', description: 'Scale factor for image resize (e.g. 0.5)' },
        quality: { type: 'INTEGER', description: 'Quality 1-100 for image/video compress' },
        start: { type: 'STRING', description: 'Start time for trim: seconds or HH:MM:SS' },
        end: { type: 'STRING', description: 'End time for trim: seconds or HH:MM:SS' },
        timestamp: { type: 'STRING', description: 'Timestamp for video frame extraction HH:MM:SS' },
        column: { type: 'STRING', description: 'Column name for CSV filter/sort' },
        value: { type: 'STRING', description: 'Filter value for CSV filter' },
        condition: { type: 'STRING', description: 'Filter condition: equals|contains|gt|lt' },
        ascending: { type: 'BOOLEAN', description: 'Sort order for CSV sort (default: true)' },
        save: { type: 'BOOLEAN', description: 'Save result to file (default: true)' },
        destination: { type: 'STRING', description: 'Output folder for archive extract' },
      },
      required: [],
    },
  },
  run,
  // Exposed for other actions and tests.
  detectType,
  readPdf,
  readDocx,
  readTable,
  readPptxText,
  writeDocx,
};

