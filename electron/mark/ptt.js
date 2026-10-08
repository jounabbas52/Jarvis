// Push-to-talk — hold Ctrl+Space, speak, release. Port of core/hotkey.py.
//
// Windows: GetAsyncKeyState polled 30 times a second by one long-lived
// PowerShell process, so the chord works while any other app has focus. It is
// deliberately not a registered global shortcut: those report a press, and
// push-to-talk needs the release too.
//
// macOS / Linux: there is no dependency-free way to read global key state, so
// the renderer binds the chord inside the window instead, and `mark:ptt-start`
// says so by returning 'window'.

const { spawn } = require('child_process');

const LABEL = 'Ctrl+Space';
const POLL_SCRIPT = `
Add-Type -Namespace MarkPtt -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v);'
$held = $false; $since = $null
while ($true) {
  $down = (([MarkPtt.K]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0) -and (([MarkPtt.K]::GetAsyncKeyState(0x20) -band 0x8000) -ne 0)
  $now = [DateTime]::UtcNow
  if ($down -ne $held) {
    # 60 ms debounce, as in hotkey.py, so a key bounce is not two presses.
    if ($since -eq $null) { $since = $now }
    elseif (($now - $since).TotalMilliseconds -ge 60) {
      $held = $down; $since = $null
      if ($held) { [Console]::Out.WriteLine('1') } else { [Console]::Out.WriteLine('0') }
      [Console]::Out.Flush()
    }
  } else { $since = $null }
  Start-Sleep -Milliseconds 33
}
`;

let child = null;
let bus = null;
let held = false;

function setHeld(h) {
  if (h === held) return;
  held = h;
  bus?.emit('ptt', { held });
}

function start() {
  stop();
  if (process.platform !== 'win32') return 'window';
  try {
    const encoded = Buffer.from(POLL_SCRIPT, 'utf16le').toString('base64');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line === '1') setHeld(true);
        else if (line === '0') setHeld(false);
      }
    });
    child.on('exit', () => {
      child = null;
      setHeld(false);
    });
    child.on('error', () => {
      child = null;
    });
    return 'global';
  } catch {
    child = null;
    return 'window';
  }
}

function stop() {
  if (child) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    child = null;
  }
  setHeld(false);
}

function register({ handle, bus: b }) {
  bus = b;
  handle('mark:ptt-start', () => start());
  handle('mark:ptt-stop', () => stop());
}

module.exports = { LABEL, register, start, stop };
