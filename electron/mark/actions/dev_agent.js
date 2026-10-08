// dev_agent — the Node port of Mark LIV's actions/dev_agent.py.
//
// Builds a complete multi-file project: plan it, write every file in
// dependency order, install its dependencies, open VS Code, then run it and
// fix what breaks, up to MAX_FIX_ATTEMPTS times. Planning and writing are the
// SMART tier with Mark's 60 s deadline.
//
// What it executes keeps Mark's rules — the project's own run command split
// into an argument array (never a shell string), inside the project folder,
// under a timeout — and adds a few fences Mark relied on the model for: file
// paths from the plan cannot leave the project folder, the run command must
// start with a known language tool, and nothing that looks like a pip option
// is passed to pip as a package name.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const MAX_FIX_ATTEMPTS = 5;
const GEMINI_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RateLimitError extends Error {}
class PlanError extends Error {}

function isRateLimit(e) {
  const msg = String(e?.message || e).toLowerCase();
  return msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted');
}

async function generate(ctx, prompt) {
  const g = ctx.gemini;
  const text = await g.text(prompt, { tier: g.SMART, timeoutMs: GEMINI_TIMEOUT_MS });
  if (!text) throw new Error('every Gemini model on the ladder failed');
  return text;
}

function stripFences(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-zA-Z]*\r?\n?/, '');
  t = t.replace(/\r?\n?```\s*$/, '');
  return t.trim();
}

// ── Error reading ────────────────────────────────────────────────────────────
function parseTraceback(output, projectFiles) {
  const re = /File ["']([^"']+\.py)["'],\s+line\s+(\d+)/gi;
  const matches = [...output.matchAll(re)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const rawPath = matches[i][1];
    const rawName = rawPath.split(/[\\/]/).pop();
    for (const pf of projectFiles) {
      if (path.basename(pf) === rawName || pf === rawPath || rawPath.endsWith(pf)) return [pf, parseInt(matches[i][2], 10)];
    }
  }
  return [null, null];
}

function classifyError(output) {
  const low = output.toLowerCase();
  if (['no module named', 'modulenotfounderror', 'importerror'].some((x) => low.includes(x))) return 'dependency_error';
  if (low.includes('syntaxerror') || low.includes('invalid syntax')) return 'syntax_error';
  if (low.includes('cannot import') || low.includes('importerror')) return 'import_error';
  if (
    ['traceback', 'exception', 'error:', 'nameerror', 'typeerror', 'attributeerror', 'valueerror', 'keyerror',
      'indexerror', 'zerodivisionerror', 'filenotfounderror', 'permissionerror'].some((x) => low.includes(x))
  ) {
    return 'runtime_error';
  }
  return 'none';
}

function hasError(output) {
  const low = output.toLowerCase();
  if (low.includes('timed out')) return false;
  if (!output.trim()) return false;
  return classifyError(output) !== 'none';
}

// ── Processes ────────────────────────────────────────────────────────────────
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
          error: err ? err.message : '',
        }),
    );
  });
}

// npm, npx, yarn… are .cmd shims on Windows, which Node will not start without
// cmd.exe. Only go through it when no argument could be read as a second command.
const CMD_META = /[&|<>^%!"\r\n()]/;
async function runProgram(file, args, opts) {
  let r = await runCapture(file, args, opts);
  if (r.missing && IS_WIN && ![file, ...args].some((a) => CMD_META.test(String(a)))) {
    const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
    const line = [file, ...args].map((a) => q(String(a))).join(' ');
    const shim = await runCapture('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, verbatim: true });
    if (!/is not recognized as an internal or external command/i.test(shim.stderr)) r = shim;
  }
  return r;
}

let pythonCache = null;
/** Mark's sys.executable: the Python that is actually installed. */
async function python() {
  if (pythonCache) return pythonCache;
  const candidates = IS_WIN ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [exe, pre] of candidates) {
    const r = await runCapture(exe, [...pre, '--version'], { timeout: 10_000 });
    if (!r.missing && r.code === 0) {
      pythonCache = [exe, pre];
      return pythonCache;
    }
  }
  pythonCache = [candidates[0][0], candidates[0][1]];
  return pythonCache;
}

// A requirement spec, never an option such as --index-url.
const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?\s*([<>=!~]=?\s*[A-Za-z0-9.*+!_-]+\s*,?\s*)*$/;

// ── Planning and writing ─────────────────────────────────────────────────────
async function planProject(description, language, ctx) {
  const prompt = `You are a senior software architect. Create a minimal, complete file plan for this project.

Language: ${language}
Description: ${description}

Return ONLY valid JSON — no markdown, no explanation:
{
  "project_name": "snake_case_name",
  "entry_point": "main.py",
  "files": [
    {
      "path": "main.py",
      "description": "Entry point — what it does and which modules it imports",
      "imports": ["utils.helpers", "core.engine"]
    },
    {
      "path": "utils/helpers.py",
      "description": "Helper utilities — what functions it exposes",
      "imports": []
    }
  ],
  "run_command": "python main.py",
  "dependencies": ["requests"]
}

Critical rules:
1. List files in DEPENDENCY ORDER — files with no imports come first, entry point comes last.
2. The "imports" field must list every other project module this file imports (dot-notation, e.g. "utils.helpers").
3. Keep it minimal — only files truly needed.
4. Entry point must be in the files list.
5. Use relative paths only (e.g. "utils/helpers.py", not absolute paths).
6. Standard library modules (os, sys, json, etc.) do NOT go in "dependencies".

JSON:`;
  let raw = '';
  try {
    raw = await generate(ctx, prompt);
  } catch (e) {
    if (isRateLimit(e)) throw new RateLimitError(String(e.message || e));
    throw new PlanError(String(e.message || e));
  }
  try {
    return JSON.parse(stripFences(raw));
  } catch (e) {
    throw new PlanError(`Planner returned invalid JSON: ${e.message}\nRaw: ${raw.slice(0, 300)}`);
  }
}

/** A plan path, kept inside the project folder. null if it tries to leave. */
function projectFile(projectDir, rel) {
  const full = path.resolve(projectDir, String(rel));
  const r = path.relative(projectDir, full);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return full;
}

async function writeFile({ fileInfo, projectDescription, allFiles, language, projectDir, alreadyWritten, ctx }) {
  const filePath = fileInfo.path;
  const fileDesc = fileInfo.description || '';
  const fileImports = Array.isArray(fileInfo.imports) ? fileInfo.imports : [];

  const fileList = allFiles.map((f, i) => `  [${i + 1}] ${f.path}: ${f.description || ''}`).join('\n');

  let dependencyContext = '';
  for (const dep of fileImports) {
    const depPath = `${String(dep).replace(/\./g, '/')}.py`;
    if (alreadyWritten[depPath] != null) {
      dependencyContext += `\n\n--- ${depPath} (you must import from this) ---\n${alreadyWritten[depPath].slice(0, 2000)}`;
    }
  }

  let langRules = '';
  const lang = language.toLowerCase();
  if (lang === 'python') {
    langRules = `
Python-specific rules:
- Use type hints for all function signatures.
- Add docstrings for all public functions and classes.
- Use if __name__ == "__main__": guard in the entry point.
- For relative imports within the project, use: from utils.helpers import foo  (match the project structure exactly).
- Do NOT use implicit relative imports (from . import ...) unless it's a proper package with __init__.py.
- If this is a package subdirectory, create __init__.py files where needed.`;
  } else if (['javascript', 'typescript', 'js', 'ts'].includes(lang)) {
    langRules = `
JS/TS-specific rules:
- Use ES modules (import/export), not CommonJS (require).
- Add JSDoc comments for all exported functions.
- Handle promise rejections with try/catch in async functions.`;
  }

  const prompt = `You are a senior ${language} developer writing production-quality code for a real project.

Project goal: ${projectDescription}

Complete project file structure (in dependency order):
${fileList}

${dependencyContext ? `Dependencies this file must import from other project files:${dependencyContext}` : ''}

Your task: Write the complete, working code for: ${filePath}
Purpose of this file: ${fileDesc}
${fileImports.length ? `This file imports from: ${fileImports.join(', ')}` : 'This file has no project-internal imports.'}

${langRules}

General rules:
- Output ONLY raw code. Absolutely no explanation, no markdown, no triple backticks.
- Write COMPLETE, RUNNABLE code — no placeholders, no "# TODO", no "pass" stubs.
- Every import must either be from the standard library, listed dependencies, or the project files shown above.
- Match import paths EXACTLY to the file paths in the project structure (e.g. if file is "utils/helpers.py", import as "from utils.helpers import ...").
- Use proper error handling (try/except) where I/O or network calls are made.
- The code must work correctly when the project entry point is run from the project root directory.

Code for ${filePath}:`;

  const full = projectFile(projectDir, filePath);
  if (!full) throw new Error(`'${filePath}' is outside the project folder — refusing to write it`);
  let code;
  try {
    code = stripFences(await generate(ctx, prompt));
  } catch (e) {
    if (isRateLimit(e)) throw new RateLimitError(String(e.message || e));
    throw e;
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, code, 'utf-8');
  console.log(`[DevAgent] Written: ${filePath} (${code.length} chars)`);
  return code;
}

async function installDependencies(dependencies, projectDir, language) {
  if (!dependencies.length) return 'No external dependencies.';
  // Mark pip-installs whatever the plan lists; for a Node or Go project those
  // are not PyPI names, so only Python projects go through pip.
  if (String(language).toLowerCase() !== 'python') {
    return `Dependencies for ${language} are not installed automatically: ${dependencies.join(', ')}`;
  }
  const [py, pre] = await python();
  const safe = dependencies.map((d) => String(d).trim()).filter((d) => PKG_RE.test(d));
  const rejected = dependencies.filter((d) => !safe.includes(String(d).trim()));
  if (rejected.length) console.warn(`[DevAgent] Not installing unsafe package specs: ${rejected.join(', ')}`);
  if (!safe.length) return `Skipped dependencies that are not plain package names: ${rejected.join(', ')}`;

  const toInstall = [];
  for (const dep of safe) {
    const pkg = dep.split(/[>=<!~[]/)[0].trim();
    const r = await runCapture(py, [...pre, '-m', 'pip', 'show', pkg], { timeout: 30_000 });
    if (r.code !== 0) toInstall.push(dep);
    else console.log(`[DevAgent] Already installed: ${pkg}`);
  }
  if (!toInstall.length) return `All dependencies already installed: ${dependencies.join(', ')}`;

  console.log(`[DevAgent] Installing: ${toInstall.join(', ')}`);
  const r = await runCapture(py, [...pre, '-m', 'pip', 'install', ...toInstall], { timeout: 120_000, cwd: projectDir });
  if (r.timedOut) return 'Dependency install timed out (non-fatal).';
  if (r.missing) return `Install error (non-fatal): ${r.error}`;
  if (r.code === 0) return `Installed: ${toInstall.join(', ')}`;
  return `Install warning (non-fatal): ${r.stderr.slice(0, 200)}`;
}

async function openVscode(projectDir) {
  const { launchDetached } = require('../util/ps');
  const candidates = [];
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '/usr/local/bin/code');
  }
  for (const exe of candidates) {
    if (fs.existsSync(exe) && launchDetached(exe, [projectDir])) {
      await sleep(1500);
      console.log(`[DevAgent] VSCode opened: ${projectDir}`);
      return true;
    }
  }
  if (!IS_WIN && launchDetached('code', [projectDir])) {
    await sleep(1500);
    return true;
  }
  // The code.cmd on PATH, through the vscode:// handler rather than a shell.
  try {
    const { shell } = require('electron');
    if (shell?.openExternal) {
      await shell.openExternal(`vscode://file/${projectDir.replace(/\\/g, '/')}`);
      return true;
    }
  } catch {
    /* not in Electron */
  }
  return false;
}

// Tools a generated project can reasonably be started with.
const RUNNERS = new Set([
  'python', 'python3', 'py', 'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno', 'ts-node', 'tsx', 'go', 'cargo',
  'java', 'javac', 'dotnet', 'ruby', 'php', 'bash', 'sh', 'powershell', 'pwsh', 'rustc', 'gcc', 'g++', 'make',
]);

async function runProject(runCommand, projectDir, timeout = 30) {
  console.log(`[DevAgent] Running: ${runCommand}`);
  let parts = String(runCommand || '').split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Run error: empty run command';

  const head = parts[0].toLowerCase().replace(/\.(exe|cmd)$/, '');
  const inProject = projectFile(projectDir, parts[0]);
  if (!RUNNERS.has(head) && !(inProject && fs.existsSync(inProject))) {
    return `Run error: '${parts[0]}' is not a program I will run for a generated project.`;
  }
  if (head === 'python') {
    const [py, pre] = await python();
    parts = [py, ...pre, ...parts.slice(1)];
  } else if (inProject && fs.existsSync(inProject) && !RUNNERS.has(head)) {
    parts[0] = inProject;
  }

  const r = await runProgram(parts[0], parts.slice(1), { timeout: timeout * 1000, cwd: projectDir });
  if (r.timedOut) return `Timed out after ${timeout}s — long-running app (server/GUI) is likely working.`;
  if (r.missing) return `Command not found: ${r.error}`;

  const out = [];
  if (r.stdout.trim()) out.push(`STDOUT:\n${r.stdout.trim()}`);
  if (r.stderr.trim()) out.push(`STDERR:\n${r.stderr.trim()}`);
  return out.length ? out.join('\n\n') : 'Ran with no output.';
}

/** If there is a ModuleNotFoundError, try to install the missing package. */
async function tryAutoInstall(errorOutput, projectDir) {
  const m = /No module named ['"]([a-zA-Z0-9_\-.]+)['"]/i.exec(errorOutput);
  if (!m) return false;
  const pkg = m[1].replace(/_/g, '-').split('.')[0];
  if (!PKG_RE.test(pkg)) return false;
  console.log(`[DevAgent] Auto-installing missing package: ${pkg}`);
  const [py, pre] = await python();
  const r = await runCapture(py, [...pre, '-m', 'pip', 'install', pkg], { timeout: 60_000, cwd: projectDir });
  return r.code === 0;
}

async function fixFiles({ errorOutput, projectDescription, allFiles, fileCodes, language, projectDir, entryPoint, ctx }) {
  const [errorFile, errorLine] = parseTraceback(errorOutput, Object.keys(fileCodes));
  const errorType = classifyError(errorOutput);

  const toFix = [];
  if (errorFile) {
    toFix.push(errorFile);
    if (errorType === 'import_error') {
      const mod = errorFile.replace(/\//g, '.').replace('.py', '');
      for (const fi of allFiles) {
        if ((fi.imports || []).includes(mod) && !toFix.includes(fi.path)) toFix.push(fi.path);
      }
    }
  } else {
    toFix.push(entryPoint);
  }

  const updated = {};
  for (const fixPath of toFix) {
    const currentCode = fileCodes[fixPath] || '';
    let otherCtx = '';
    for (const [fp, code] of Object.entries(fileCodes)) {
      if (fp !== fixPath && code) otherCtx += `\n--- ${fp} ---\n${code.slice(0, 1500)}${code.length > 1500 ? '...' : ''}\n`;
    }
    const lineHint = errorLine && fixPath === errorFile ? `\nError appears to be near line ${errorLine} in this file.` : '';

    const prompt = `You are an expert ${language} debugger. Fix the broken file below.

Project goal: ${projectDescription}

All project files:
${allFiles.map((f) => `  - ${f.path}: ${f.description || ''}`).join('\n')}

Other files for context (read-only — fix only the target file):
${otherCtx.slice(0, 3500)}

File to fix: ${fixPath}${lineHint}
Error type: ${errorType}

Error output:
${errorOutput.slice(0, 2500)}

Current (broken) code:
${currentCode}

Rules:
- Output ONLY the complete fixed code. No explanation, no markdown, no backticks.
- Fix ALL errors visible in the error output.
- Keep all existing correct logic — do not remove working features.
- Ensure import paths match the actual project file structure exactly.
- Do NOT introduce new bugs or remove error handling.

Fixed code for ${fixPath}:`;

    try {
      const full = projectFile(projectDir, fixPath);
      if (!full) throw new Error(`'${fixPath}' is outside the project folder`);
      const fixed = stripFences(await generate(ctx, prompt));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, fixed, 'utf-8');
      updated[fixPath] = fixed;
      console.log(`[DevAgent] Fixed: ${fixPath}`);
    } catch (e) {
      if (isRateLimit(e)) throw new RateLimitError(String(e.message || e));
      console.warn(`[DevAgent] Could not fix ${fixPath}: ${e.message || e}`);
    }
  }
  return updated;
}

async function buildProject({ description, language, projectName, timeout, ctx }) {
  const log = (msg) => {
    console.log(`[DevAgent] ${msg}`);
    ctx.ui.log(`[DevAgent] ${msg}`);
  };

  log('Planning project structure...');
  let plan;
  try {
    plan = await planProject(description, language, ctx);
  } catch (e) {
    const msg = e instanceof RateLimitError ? 'Rate limit reached, sir. Please try again in a moment.' : `Planning failed: ${e.message || e}`;
    ctx.speak(msg);
    return msg;
  }
  if (!plan || typeof plan !== 'object') plan = {};

  let projName = projectName || plan.project_name || 'jarvis_project';
  projName = String(projName).replace(/[^\p{L}\p{N}_-]/gu, '_');
  const projectsDir = path.join(ctx?.paths?.desktop || path.join(os.homedir(), 'Desktop'), 'JarvisProjects');
  const projectDir = path.join(projectsDir, projName);
  fs.mkdirSync(projectDir, { recursive: true });

  const files = (Array.isArray(plan.files) ? plan.files : []).filter((f) => f && typeof f === 'object');
  const entryPoint = plan.entry_point || 'main.py';
  const runCommand = plan.run_command || `python ${entryPoint}`;
  const dependencies = Array.isArray(plan.dependencies) ? plan.dependencies : [];

  log(`Project: ${projName} | Files: ${files.length} | Entry: ${entryPoint}`);

  // Stable sort by number of imports, as Python's sorted() is.
  const sorted = files
    .map((f, i) => [f, i])
    .sort((a, b) => (a[0].imports || []).length - (b[0].imports || []).length || a[1] - b[1])
    .map(([f]) => f);

  const fileCodes = {};
  for (const fileInfo of sorted) {
    const filePath = fileInfo.path || '';
    if (!filePath) continue;
    log(`Writing ${filePath}...`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fileCodes[filePath] = await writeFile({
          fileInfo,
          projectDescription: description,
          allFiles: files,
          language,
          projectDir,
          alreadyWritten: fileCodes,
          ctx,
        });
        await sleep(400);
        break;
      } catch (e) {
        if (e instanceof RateLimitError) {
          if (attempt === 0) {
            log('Rate limit — waiting 20s...');
            await sleep(20_000);
          } else {
            log(`Rate limit retry failed for ${filePath}, skipping.`);
          }
        } else {
          log(`Failed to write ${filePath}: ${e.message || e}`);
          break;
        }
      }
    }
  }

  if (!Object.keys(fileCodes).length) {
    const msg = 'I could not write any project files, sir.';
    ctx.speak(msg);
    return msg;
  }

  if (dependencies.length) log(await installDependencies(dependencies, projectDir, language));

  await openVscode(projectDir);

  let lastOutput = '';
  let autoInstalls = 0;
  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    log(`Running project (attempt ${attempt}/${MAX_FIX_ATTEMPTS})...`);
    lastOutput = await runProject(runCommand, projectDir, timeout);
    log(`Output preview: ${lastOutput.slice(0, 150)}`);

    if (!hasError(lastOutput)) {
      const msg =
        `Project '${projName}' is working, sir. ` +
        `Built in ${attempt} attempt${attempt > 1 ? 's' : ''}. ` +
        `Saved to: ${projectDir}`;
      ctx.speak(msg);
      return `${msg}\n\nOutput:\n${lastOutput}`;
    }
    if (attempt === MAX_FIX_ATTEMPTS) break;

    const errorType = classifyError(lastOutput);
    if (errorType === 'dependency_error' && autoInstalls < 3 && String(language).toLowerCase() === 'python') {
      if (await tryAutoInstall(lastOutput, projectDir)) {
        autoInstalls += 1;
        log('Missing dependency installed, retrying...');
        await sleep(1000);
        continue;
      }
    }

    log(`Fixing errors (type: ${errorType})...`);
    try {
      Object.assign(
        fileCodes,
        await fixFiles({
          errorOutput: lastOutput,
          projectDescription: description,
          allFiles: files,
          fileCodes,
          language,
          projectDir,
          entryPoint,
          ctx,
        }),
      );
      await sleep(1000);
    } catch (e) {
      if (e instanceof RateLimitError) {
        const msg = 'Rate limit reached during fix. Project saved, check it manually in VSCode.';
        ctx.speak(msg);
        return msg;
      }
      log(`Fix step failed: ${e.message || e}`);
    }
  }

  const msg =
    `I couldn't fully fix '${projName}' after ${MAX_FIX_ATTEMPTS} attempts, sir. ` +
    `Project is saved at ${projectDir} — open it in VSCode and check manually.`;
  ctx.speak(msg);
  return `${msg}\n\nLast error:\n${lastOutput.slice(0, 600)}`;
}

async function run(parameters, ctx) {
  const p = parameters || {};
  const description = String(p.description || '').trim();
  const language = String(p.language || 'python').trim() || 'python';
  const projectName = String(p.project_name || '').trim();
  const timeout = parseInt(p.timeout, 10) || 30;
  if (!description) return 'Please describe the project you want me to build, sir.';
  return buildProject({ description, language, projectName, timeout, ctx });
}

module.exports = {
  TOOL: {
    name: 'dev_agent',
    description:
      'Builds complete multi-file projects from scratch: plans, writes files, installs deps, opens VSCode, runs and fixes errors.',
    parameters: {
      type: 'OBJECT',
      properties: {
        description: { type: 'STRING', description: 'What the project should do' },
        language: { type: 'STRING', description: 'Programming language (default: python)' },
        project_name: { type: 'STRING', description: 'Optional project folder name' },
        timeout: { type: 'INTEGER', description: 'Run timeout in seconds (default: 30)' },
      },
      required: ['description'],
    },
  },
  run,
  // Exposed for tests.
  parseTraceback,
  classifyError,
  hasError,
  runProject,
  projectFile,
};
