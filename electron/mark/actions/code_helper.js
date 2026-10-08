// code_helper — the Node port of Mark LIV's actions/code_helper.py.
//
// Writes, edits, explains, optimizes, runs and builds single code files, and
// reads an error off the screen. Writing and fixing code is the SMART tier with
// Mark's 60 s deadline, because a whole file can come back.
//
// Running code keeps Mark's rules: only a fixed table of interpreters, an
// argument array and never a shell string, the file's own folder as the
// working directory, and a hard timeout.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const MAX_BUILD_ATTEMPTS = 3;
const GEMINI_TIMEOUT_MS = 60_000;
const UNDO_CONTENT_LIMIT = 1_000_000;

// ── Gemini ───────────────────────────────────────────────────────────────────
async function generate(ctx, contents) {
  const g = ctx.gemini;
  const text = await g.text(contents, { tier: g.SMART, timeoutMs: GEMINI_TIMEOUT_MS });
  if (!text) throw new Error('every Gemini model on the ladder failed');
  return text;
}

function cleanCode(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-zA-Z]*\n?/, '');
  t = t.replace(/\n?```$/, '');
  return t.trim();
}

// ── Files ────────────────────────────────────────────────────────────────────
const EXT_MAP = {
  python: '.py', py: '.py', javascript: '.js', js: '.js', typescript: '.ts', ts: '.ts', html: '.html', css: '.css',
  java: '.java', cpp: '.cpp', c: '.c', bash: '.sh', shell: '.sh', powershell: '.ps1', sql: '.sql', json: '.json',
  rust: '.rs', go: '.go',
};

function desktop(ctx) {
  return ctx?.paths?.desktop || path.join(require('os').homedir(), 'Desktop');
}

function resolveSavePath(outputPath, language, ctx) {
  if (outputPath) return path.isAbsolute(outputPath) ? outputPath : path.join(desktop(ctx), outputPath);
  const ext = EXT_MAP[String(language || 'python').toLowerCase()] || '.py';
  return path.join(desktop(ctx), `jarvis_code${ext}`);
}

/** [content, error] — strict UTF-8 like Path.read_text. */
function readFile(filePath) {
  if (!filePath) return ['', 'No file path provided.'];
  if (!fs.existsSync(filePath)) return ['', `File not found: ${filePath}`];
  try {
    return [new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filePath)).replace(/^﻿/, ''), ''];
  } catch (e) {
    return ['', `Could not read file: ${e.message || e}`];
  }
}

/**
 * Save, and — beyond Mark — make an overwrite of an existing file undoable,
 * since edit/optimize/screen_debug replace the user's own source file.
 */
function saveFile(p, content, ctx) {
  try {
    let previous = null;
    let existed = false;
    try {
      const st = fs.statSync(p);
      existed = st.isFile();
      if (existed && st.size <= UNDO_CONTENT_LIMIT) previous = fs.readFileSync(p, 'utf-8');
    } catch {
      /* new file */
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
    if (ctx?.undo?.push && (!existed || previous != null)) {
      ctx.undo.push(`wrote code to ${path.basename(p)}`, () => {
        if (previous == null) {
          if (!fs.existsSync(p)) return `'${path.basename(p)}' is already gone.`;
          fs.unlinkSync(p);
          return `Removed '${path.basename(p)}' — it did not exist before.`;
        }
        fs.writeFileSync(p, previous, 'utf-8');
        return `Restored the previous contents of '${path.basename(p)}'.`;
      });
    }
    return `Saved to: ${p}`;
  } catch (e) {
    return `Could not save: ${e.message || e}`;
  }
}

function preview(code, lines = 10) {
  const all = code.split(/\r?\n/);
  const head = all.slice(0, lines).join('\n');
  return all.length > lines ? `${head}\n... (${all.length - lines} more lines)` : head;
}

function hasError(output) {
  const signals = ['error', 'exception', 'traceback', 'syntaxerror', 'nameerror', 'typeerror', 'stderr', 'failed', 'crash'];
  const low = output.toLowerCase();
  return signals.some((s) => low.includes(s));
}

// ── Processes ────────────────────────────────────────────────────────────────
/** subprocess.run(capture_output=True, timeout=...) with an argument array. */
function runCapture(file, args, { timeout, cwd, verbatim = false } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout,
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      },
      (err, stdout, stderr) =>
        resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          missing: Boolean(err && (err.code === 'ENOENT' || err.code === 'EINVAL')),
          timedOut: Boolean(err && err.killed),
        }),
    );
  });
}

/**
 * Windows npm-style tools are .cmd shims, which Node refuses to start without
 * a shell. Go through cmd.exe only when no argument could be read by cmd as a
 * second command.
 */
const CMD_META = /[&|<>^%!"\r\n()]/;
function cmdShim(file, args) {
  if (!IS_WIN) return null;
  if ([file, ...args].some((a) => CMD_META.test(String(a)))) return null;
  const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
  return ['cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map((a) => q(String(a))).join(' ')}"`]];
}

function pythonCommand() {
  return IS_WIN ? ['py', ['-3']] : ['python3', []];
}

/** shlex-ish split for args passed as one string (the declared parameter type). */
function splitArgs(args) {
  if (Array.isArray(args)) return args.map(String);
  const s = String(args || '').trim();
  if (!s) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

async function runFile(p, args, timeout) {
  const [py, pyPre] = pythonCommand();
  const interpreters = {
    '.py': [py, ...pyPre],
    '.js': ['node'],
    '.ts': ['ts-node'],
    '.sh': ['bash'],
    '.ps1': ['powershell', '-File'],
    '.rb': ['ruby'],
    '.php': ['php'],
  };
  const interp = interpreters[path.extname(p).toLowerCase()];
  if (!interp) return `No interpreter for ${path.extname(p)}.`;

  const argv = [...interp.slice(1), p, ...splitArgs(args)];
  const opts = { timeout: timeout * 1000, cwd: path.dirname(p) };
  let r = await runCapture(interp[0], argv, opts);
  // `py` missing → fall back to plain `python`, as Mark's sys.executable would be.
  if (r.missing && interp[0] === 'py') r = await runCapture('python', argv.slice(1), opts);
  if (r.missing && interp[0] === 'python3') r = await runCapture('python', argv, opts);
  if (r.missing && IS_WIN) {
    const shim = cmdShim(interp[0], argv);
    if (shim) r = await runCapture(shim[0], shim[1], { ...opts, verbatim: true });
    if (shim && r.code !== 0 && /is not recognized/i.test(r.stderr)) r.missing = true;
  }
  if (r.timedOut) return `Timed out after ${timeout}s.`;
  if (r.missing) return `Interpreter not found: ${interp[0]}.`;

  const output = r.stdout.trim();
  const error = r.stderr.trim();
  const parts = [];
  if (output) parts.push(`Output:\n${output}`);
  if (error) parts.push(`Stderr:\n${error}`);
  return parts.length ? parts.join('\n\n') : 'Executed with no output.';
}

// ── Intent ───────────────────────────────────────────────────────────────────
const VALID_INTENTS = new Set(['write', 'edit', 'explain', 'run', 'build', 'screen_debug', 'optimize']);

/**
 * Language-independent intent detection — no fixed keyword list. Gemini
 * classifies the request; if it is unreachable, structural hints decide.
 */
async function detectIntent(description, filePath, code, ctx) {
  const desc = String(description || '').trim();
  const fileExists = Boolean(filePath) && fs.existsSync(filePath);

  if (desc) {
    try {
      const c = [];
      if (filePath) c.push(`a file path is provided (exists on disk: ${fileExists ? 'True' : 'False'})`);
      if (code) c.push('an inline code snippet is provided');
      const prompt =
        'Classify a coding assistant request into exactly ONE intent word.\n' +
        'The request may be written in ANY language.\n\n' +
        `Request: ${desc}\n` +
        (c.length ? `Context: ${c.join('; ')}\n` : '') +
        '\nIntents:\n' +
        '  write        = create new code from scratch\n' +
        '  edit         = modify an existing file\n' +
        '  explain      = describe what given code/file does\n' +
        '  run          = execute an existing file\n' +
        '  build        = write code, run it, and iterate until it works\n' +
        "  screen_debug = analyze an error currently visible on the user's screen\n" +
        '  optimize     = refactor / clean up / speed up existing code\n\n' +
        'Reply with ONLY the intent word, nothing else.';
      const ans = (await generate(ctx, prompt))
        .trim()
        .toLowerCase()
        .replace(/^[`'". \n]+|[`'". \n]+$/g, '');
      if (VALID_INTENTS.has(ans)) return ans;
    } catch (e) {
      console.warn(`[Code] Intent classification failed (${e.message || e}) — structural fallback`);
    }
  }
  if (fileExists) return desc ? 'edit' : 'explain';
  if (code) return 'explain';
  return 'write';
}

// ── Actions ──────────────────────────────────────────────────────────────────
async function write(description, language, outputPath, ctx) {
  const lang = language || 'python';
  const prompt = `You are an expert ${lang} developer.
Write clean, working, well-commented ${lang} code for the description below.

Rules:
- Output ONLY the code. No explanation, no markdown, no backticks.
- Add helpful inline comments.
- Handle errors and edge cases properly.
- Use modern best practices.

Description: ${description}

Code:`;
  const code = cleanCode(await generate(ctx, prompt));
  const p = resolveSavePath(outputPath, lang, ctx);
  saveFile(p, code, ctx);
  return [code, p];
}

async function fixCode(code, errorOutput, description, ctx) {
  const prompt = `You are an expert debugger.
The code below failed with the following error. Fix it.
Return ONLY the corrected code — no explanation, no markdown, no backticks.

Original goal: ${description}

Error:
${errorOutput.slice(0, 2000)}

Broken code:
${code}

Fixed code:`;
  return cleanCode(await generate(ctx, prompt));
}

async function build(description, language, outputPath, args, timeout, ctx) {
  if (!description) return 'Please describe what you want me to build, sir.';
  ctx.ui.log('[Code] Build started...');
  const lang = language || 'python';

  let code;
  let p;
  try {
    [code, p] = await write(description, lang, outputPath, ctx);
    console.log(`[Code] Written: ${p}`);
  } catch (e) {
    const msg = `Could not write initial code: ${e.message || e}`;
    ctx.speak(msg);
    return msg;
  }

  let lastOutput = '';
  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
    console.log(`[Code] Attempt ${attempt}/${MAX_BUILD_ATTEMPTS}`);
    ctx.ui.log(`[Code] Attempt ${attempt}...`);
    lastOutput = await runFile(p, args, timeout);

    if (!hasError(lastOutput)) {
      const msg =
        'Build complete, sir. ' +
        `The code is working after ${attempt} attempt${attempt > 1 ? 's' : ''}. ` +
        `Saved to ${p}.`;
      ctx.speak(msg);
      return `${msg}\n\nOutput:\n${lastOutput}`;
    }

    ctx.ui.log(`[Code] Fixing (attempt ${attempt})...`);
    try {
      code = await fixCode(code, lastOutput, description, ctx);
      saveFile(p, code, ctx);
    } catch (e) {
      const msg = `Could not fix code on attempt ${attempt}: ${e.message || e}`;
      ctx.speak(msg);
      return msg;
    }
  }

  const msg =
    `I was unable to build a working version after ${MAX_BUILD_ATTEMPTS} attempts, sir. ` +
    `The last error was: ${lastOutput.slice(0, 200)}`;
  ctx.speak(msg);
  return `${msg}\n\nLast code saved to: ${p}`;
}

async function writeAction(description, language, outputPath, ctx) {
  if (!description) return 'Please describe what you want me to write, sir.';
  ctx.ui.log('[Code] Writing code...');
  try {
    const [code, p] = await write(description, language, outputPath, ctx);
    return `Code written. Saved to: ${p}\n\nPreview:\n${preview(code)}`;
  } catch (e) {
    return `Could not generate code: ${e.message || e}`;
  }
}

async function editAction(filePath, instruction, ctx) {
  if (!filePath) return 'Please provide a file path to edit, sir.';
  if (!instruction) return 'Please describe what change to make, sir.';
  const [content, err] = readFile(filePath);
  if (err) return err;
  ctx.ui.log('[Code] Editing file...');

  const prompt = `You are an expert code editor.
Apply the following change to the code below.
Return ONLY the complete updated code — no explanation, no markdown, no backticks.

Change: ${instruction}

Original code:
${content}

Updated code:`;
  let edited;
  try {
    edited = cleanCode(await generate(ctx, prompt));
  } catch (e) {
    return `Could not edit code: ${e.message || e}`;
  }
  const status = saveFile(filePath, edited, ctx);
  return `File edited. ${status}\n\nPreview:\n${preview(edited)}`;
}

async function explainAction(filePath, code, ctx) {
  if (filePath && !code) {
    const [c, err] = readFile(filePath);
    if (err) return err;
    code = c;
  }
  if (!code) return 'Please provide code or a file path to explain, sir.';
  ctx.ui.log('[Code] Analyzing code...');
  const prompt = `Explain what this code does in simple, clear language.
Focus on: what it does, how it works, and any important details.
Be concise — 3 to 6 sentences maximum.

Code:
${code.slice(0, 4000)}

Explanation:`;
  try {
    return (await generate(ctx, prompt)).trim();
  } catch (e) {
    return `Could not explain code: ${e.message || e}`;
  }
}

async function runAction(filePath, args, timeout, ctx) {
  if (!filePath) return 'Please provide a file path to run, sir.';
  if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;
  ctx.ui.log(`[Code] Running ${path.basename(filePath)}...`);
  return runFile(path.resolve(filePath), args, timeout);
}

async function optimizeAction(filePath, code, language, outputPath, ctx) {
  if (filePath && !code) {
    const [c, err] = readFile(filePath);
    if (err) return err;
    code = c;
  }
  if (!code) return 'Please provide code or a file path to optimize, sir.';
  ctx.ui.log('[Code] Optimizing code...');
  const lang = language || 'python';
  const prompt = `You are an expert ${lang} developer and code reviewer.
Optimize the following code for:
1. Performance — eliminate unnecessary operations, use efficient data structures
2. Readability — clear variable names, proper formatting, logical structure
3. Best practices — modern ${lang} patterns, error handling, type hints if applicable
4. Remove dead code, redundant comments, and unnecessary complexity

Return ONLY the optimized code — no explanation, no markdown, no backticks.

Original code:
${code.slice(0, 6000)}

Optimized code:`;
  let optimized;
  try {
    optimized = cleanCode(await generate(ctx, prompt));
  } catch (e) {
    return `Could not optimize code: ${e.message || e}`;
  }
  const savePath = filePath || resolveSavePath(outputPath, lang, ctx);
  const status = saveFile(savePath, optimized, ctx);

  const before = code.split(/\r?\n/).length;
  const after = optimized.split(/\r?\n/).length;
  const diff = before - after;
  return (
    `Code optimized. ${status}\n` +
    `Lines: ${before} → ${after} (${diff > 0 ? '−' : '+'}${Math.abs(diff)} lines)\n\n` +
    `Preview:\n${preview(optimized)}`
  );
}

async function screenDebugAction(description, filePath, ctx) {
  ctx.ui.log('[Code] Taking screenshot for analysis...');
  let shot;
  try {
    // Lazy: index.js loads this file while it is itself still loading.
    shot = await require('../index').captureScreen();
  } catch (e) {
    console.warn(`[Code] Screenshot failed: ${e.message || e}`);
    return 'Could not take screenshot, sir.';
  }

  let fileContent = '';
  if (filePath) {
    const [c, err] = readFile(filePath);
    if (err) console.warn(`[Code] Could not read file: ${err}`);
    fileContent = c;
  }

  try {
    const question = description || 'What error or problem do you see on the screen? How can it be fixed?';
    const context = fileContent
      ? `\n\nAdditionally, here is the related file content:\n\`\`\`\n${fileContent.slice(0, 4000)}\n\`\`\``
      : '';
    const prompt = `You are an expert programmer and debugger analyzing a screenshot.

User's question: ${question}${context}

Please:
1. Identify any errors, exceptions, or problems visible on the screen
2. Explain what is causing the problem in simple terms
3. Provide a concrete fix or solution
4. If there's code visible, show the corrected version

Be specific and actionable. If you see an error message, quote it exactly.`;
    const g = ctx.gemini;
    const r = await g.call([{ inlineData: { mimeType: shot.mimeType, data: shot.data } }, { text: prompt }], {
      tier: g.SMART,
      timeoutMs: 45_000,
    });
    if (!r) return "Sir, I couldn't reach Gemini to analyse that screenshot.";
    let analysis = String(r.text || '').trim();

    if (filePath && fileContent) {
      const m = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(analysis);
      if (m) {
        saveFile(filePath, m[1].trim(), ctx);
        analysis += `\n\nFixed code has been saved to: ${filePath}`;
      }
    }
    return analysis;
  } catch (e) {
    return `Screen analysis failed: ${e.message || e}`;
  }
}

async function run(parameters, ctx) {
  const p = parameters || {};
  let action = String(p.action || 'auto').toLowerCase().trim() || 'auto';
  const description = String(p.description || '').trim();
  const language = String(p.language ?? 'python').trim();
  const outputPath = String(p.output_path || '').trim();
  const filePath = String(p.file_path || '').trim();
  const code = String(p.code || '').trim();
  const args = p.args || [];
  const timeout = parseInt(p.timeout, 10) || 30;

  if (action === 'auto') {
    action = await detectIntent(description, filePath, code, ctx);
    console.log(`[Code] Auto-detected: ${action}`);
  }

  switch (action) {
    case 'write':
      return writeAction(description, language, outputPath, ctx);
    case 'edit':
      return editAction(filePath, description || p.instruction || '', ctx);
    case 'explain':
      return explainAction(filePath, code, ctx);
    case 'run':
      return runAction(filePath, args, timeout, ctx);
    case 'build':
      return build(description, language, outputPath, args, timeout, ctx);
    case 'optimize':
      return optimizeAction(filePath, code, language, outputPath, ctx);
    case 'screen_debug':
      return screenDebugAction(description, filePath, ctx);
    default:
      return `Unknown action: '${action}'. Use write, edit, explain, run, build, optimize, or screen_debug.`;
  }
}

module.exports = {
  TOOL: {
    name: 'code_helper',
    description: 'Writes, edits, explains, runs, or builds code files.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'write | edit | explain | run | build | auto (default: auto)' },
        description: { type: 'STRING', description: 'What the code should do or what change to make' },
        language: { type: 'STRING', description: 'Programming language (default: python)' },
        output_path: { type: 'STRING', description: 'Where to save the file' },
        file_path: { type: 'STRING', description: 'Path to existing file for edit/explain/run/build' },
        code: { type: 'STRING', description: 'Raw code string for explain' },
        args: { type: 'STRING', description: 'CLI arguments for run/build' },
        timeout: { type: 'INTEGER', description: 'Execution timeout in seconds (default: 30)' },
      },
      required: ['action'],
    },
  },
  run,
  // Exposed for tests.
  runFile,
  hasError,
  cleanCode,
  splitArgs,
};
