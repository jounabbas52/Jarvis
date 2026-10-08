// Small process helpers shared by the Mark LIV actions.
//
// Every call uses execFile/spawn with an argument array and never a shell
// string, the same rule the rest of jarvis-lite follows: user text cannot
// inject a second command.

const { execFile, spawn } = require('child_process');

/**
 * Run a PowerShell script (Windows). The script is passed on stdin-free
 * `-Command`, encoded, so quotes and newlines in it need no escaping.
 * Resolves to { ok, stdout, stderr, code }. Never rejects.
 */
function runPS(script, { timeout = 20_000 } = {}) {
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue';\n${script}`, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    timeout,
  });
}

/** Run a program with arguments. Resolves to { ok, stdout, stderr, code }. Never rejects. */
function run(file, args = [], { timeout = 20_000, cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout, cwd, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && err.message) || ''),
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        });
      },
    );
    if (input != null) {
      child.stdin.end(input);
    }
  });
}

/** Start a program and let it run on its own (apps, URLs). */
function launchDetached(file, args = [], opts = {}) {
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Quote a string for inclusion inside a single-quoted PowerShell literal. */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

module.exports = { runPS, run, launchDetached, psQuote };
