// One long-lived sensor process for the Windows HUD gauges.
//
// Every figure here (network throughput, process count, GPU load, CPU
// temperature) is only reachable on Windows through WMI or a performance
// counter, which from Node means PowerShell. Starting PowerShell costs a few
// hundred milliseconds of CPU before it does anything, and the gauges refresh
// every second, so spawning it per sample was most of the app's idle load on a
// modest machine. Instead one PowerShell stays warm and prints a JSON line
// every few seconds; readers get the latest values from memory.
//
// NVIDIA cards are read through `nvidia-smi -l`, its own built-in loop, for
// the same reason.

const { spawn } = require('child_process');

const PERIOD_S = 3;

const state = { net: 0, procs: 0, gpu: -1, temp: -1, at: 0 };
let ps = null;
let smi = null;
let started = false;

function script(psGpu) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$i = 0; $acpi = $true; $zone = $true
while ($true) {
  $o = [ordered]@{}
  $n = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface
  $o.net = [double](($n | Measure-Object -Property BytesTotalPersec -Sum).Sum)
  $o.procs = (Get-Process).Count
  # GPU and temperature change slowly and cost more: every other pass (~6 s),
  # the cadence Mark's HUD cached them at.
  if ($i % 2 -eq 0) {
    ${psGpu ? `$e = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.Name -like '*engtype_3D*' }
    $by = @{}; foreach ($x in $e) { $k = ($x.Name -replace '^pid_\\d+_','' -replace '_eng_.*$',''); $by[$k] = [double]$by[$k] + [double]$x.UtilizationPercentage }
    if ($by.Count) { $o.gpu = [math]::Min(100, ($by.Values | Measure-Object -Maximum).Maximum) } else { $o.gpu = 0 }` : ''}
    $t = $null
    if ($acpi) {
      $a = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1
      if ($a) { $t = ($a.CurrentTemperature / 10.0) - 273.15 } else { $acpi = $false }
      if ($t -le 0 -or $t -ge 150) { $t = $null; $acpi = $false }
    }
    if (-not $t -and $zone) {
      # Prefer the CPU's own zone. Others are not CPU temperature, and some
      # firmware parks a placeholder in them (a chipset zone stuck at 400 K
      # read as 127 C), so only plausible readings count.
      $z = Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | ForEach-Object {
        $c = $(if ($_.HighPrecisionTemperature) { $_.HighPrecisionTemperature / 10.0 } else { $_.Temperature }) - 273.15
        if ($c -gt 0 -and $c -lt 105) { [pscustomobject]@{ Name = $_.Name; C = $c } }
      }
      $cpu = $z | Where-Object { $_.Name -match 'CPU' } | Select-Object -First 1
      if ($cpu) { $t = $cpu.C } elseif ($z) { $t = ($z | Measure-Object -Property C -Maximum).Maximum } else { $zone = $false }
    }
    if ($t) { $o.temp = [math]::Round($t, 1) }
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  $i++
  Start-Sleep -Seconds ${PERIOD_S}
}
`;
}

function lines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
}

/** Start the sensor (idempotent). `nvidiaSmi` is the nvidia-smi path, or ''. */
function start(nvidiaSmi) {
  if (started || process.platform !== 'win32') return;
  started = true;

  if (nvidiaSmi) {
    try {
      smi = spawn(nvidiaSmi, ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits', `-l`, String(PERIOD_S * 2)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      lines(smi.stdout, (l) => {
        const v = parseFloat(l);
        if (Number.isFinite(v)) state.gpu = v;
      });
      smi.on('error', () => (smi = null));
      smi.on('exit', () => (smi = null));
    } catch {
      smi = null;
    }
  }

  try {
    const encoded = Buffer.from(script(!smi), 'utf16le').toString('base64');
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    lines(ps.stdout, (l) => {
      try {
        const o = JSON.parse(l);
        if (Number.isFinite(o.net)) state.net = o.net;
        if (Number.isFinite(o.procs)) state.procs = o.procs;
        if (Number.isFinite(o.gpu)) state.gpu = o.gpu;
        if (Number.isFinite(o.temp)) state.temp = o.temp;
        state.at = Date.now();
      } catch {
        /* partial line */
      }
    });
    ps.on('error', () => (ps = null));
    ps.on('exit', () => {
      ps = null;
      started = false; // allow a restart on the next read
    });
  } catch {
    ps = null;
    started = false;
  }
}

/** Resolves once the first sample has arrived (or after `timeoutMs`). */
async function ready(timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (!state.at && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return state;
}

function stop() {
  for (const p of [ps, smi]) {
    try {
      p?.kill();
    } catch {
      /* gone */
    }
  }
  ps = null;
  smi = null;
  started = false;
}

module.exports = { state, start, ready, stop };
