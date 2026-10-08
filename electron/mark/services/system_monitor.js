// System monitor — the Node port of Mark LIV's actions/system_monitor.py plus
// the metric sampler behind the HUD's bars (ui.py `_SysMetrics`).
//
//   getSystemStatus()  → the system_status tool's answer (string).
//   new SystemMonitor().check() → a `[SYSTEM_ALERT] ...` sentence or null,
//     with Mark's thresholds, CPU streak and 5-minute per-metric cooldown.
//   metrics()          → { cpu, ram, gpu, temp } for the HUD (0 if unknown).
//
// Mark reads GPU load from NVML and CPU temperature from psutil/WMI. Here:
// CPU/RAM from `systeminformation`; GPU from nvidia-smi, falling back to the
// Windows "GPU Engine" performance counters (what Task Manager shows, so AMD
// and Intel GPUs report too); temperature from systeminformation, then the
// ACPI thermal zone, then the thermal-zone performance counter (readable
// without admin rights). GPU and temperature are the slow probes, so — as in
// Mark's HUD — they are refreshed at most every ~6 s and cached between.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { run, runPS } = require('../util/ps');

const IS_WIN = process.platform === 'win32';

const DEFAULT_THRESHOLDS = { cpu: 90.0, ram: 90.0, temp: 85.0, gpu: 95.0 };
const COOLDOWN_MS = 300_000;
const CPU_STREAK = 3;
const SLOW_PROBE_MS = 6_000;

let si = null;
function sysinfo() {
  if (si === null) {
    try {
      si = require('systeminformation');
    } catch {
      si = false;
    }
  }
  return si || null;
}

// ── CPU / RAM ────────────────────────────────────────────────────────────────
// psutil.cpu_percent(interval=None) = usage since the previous call. Node's
// os.cpus() counters give exactly that without spawning anything.
let lastCpu = null;
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function cpuPercentSinceLast() {
  const now = cpuTimes();
  const prev = lastCpu;
  lastCpu = now;
  if (!prev) return null;
  const dt = now.total - prev.total;
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, (100 * (dt - (now.idle - prev.idle))) / dt));
}

/** psutil.cpu_percent(interval=seconds) */
async function cpuPercent(intervalMs = 0) {
  if (intervalMs > 0 || !lastCpu) {
    cpuPercentSinceLast();
    await new Promise((r) => setTimeout(r, intervalMs || 200));
  }
  return cpuPercentSinceLast() ?? 0;
}

// os.freemem() is the OS's *available* figure (MemAvailable / ullAvailPhys),
// which is what psutil's percent is built on — and it costs no subprocess,
// unlike systeminformation's mem() on Windows.
async function memory() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return { percent: (100 * used) / total, used, total };
}

// ── GPU ──────────────────────────────────────────────────────────────────────
let nvidiaSmi; // undefined = not looked for yet; '' = absent
function findNvidiaSmi() {
  if (nvidiaSmi !== undefined) return nvidiaSmi;
  const candidates = IS_WIN
    ? [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
      ]
    : ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi'];
  nvidiaSmi = candidates.find((p) => fs.existsSync(p)) || '';
  if (!nvidiaSmi) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, IS_WIN ? 'nvidia-smi.exe' : 'nvidia-smi');
      if (dir && fs.existsSync(p)) {
        nvidiaSmi = p;
        break;
      }
    }
  }
  return nvidiaSmi;
}

let perfGpuOk = null; // null = untested, false = unavailable here

async function gpuUsage() {
  const smi = findNvidiaSmi();
  if (smi) {
    const r = await run(smi, ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 5000 });
    const n = parseFloat(r.stdout.split(/\r?\n/)[0]);
    if (r.ok && Number.isFinite(n)) return n;
  }
  if (IS_WIN && perfGpuOk !== false) {
    // Busiest physical adapter's 3D engine, the number Task Manager shows.
    const r = await runPS(
      "$e = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop | Where-Object { $_.Name -like '*engtype_3D*' };" +
        "$by = @{}; foreach ($x in $e) { $k = ($x.Name -replace '^pid_\\d+_','' -replace '_eng_.*$',''); $by[$k] = [double]$by[$k] + [double]$x.UtilizationPercentage };" +
        "if ($by.Count) { [math]::Min(100, ($by.Values | Measure-Object -Maximum).Maximum) } else { 0 }",
      { timeout: 10_000 },
    );
    const n = parseFloat(r.stdout.trim());
    if (r.ok && Number.isFinite(n)) {
      perfGpuOk = true;
      return n;
    }
    perfGpuOk = false;
  }
  return -1;
}

// ── Temperature ──────────────────────────────────────────────────────────────
let siTempOk = null;
let acpiOk = null;
let zoneOk = null;

async function cpuTemp() {
  const s = sysinfo();
  if (s && siTempOk !== false) {
    try {
      const t = await s.cpuTemperature();
      const v = Number(t.main) || Math.max(0, ...((t.cores || []).map(Number).filter(Number.isFinite)));
      if (v > 0) {
        siTempOk = true;
        return v;
      }
    } catch {
      /* next */
    }
    // On Windows systeminformation only tries the ACPI zone below; don't pay twice.
    if (IS_WIN) siTempOk = false;
  }
  if (!IS_WIN) return -1;

  if (acpiOk !== false) {
    const r = await runPS(
      '$t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 1; ($t.CurrentTemperature / 10.0) - 273.15',
      { timeout: 8000 },
    );
    const v = parseFloat(r.stdout.trim());
    if (r.ok && Number.isFinite(v) && v > 0 && v < 150) {
      acpiOk = true;
      return v;
    }
    acpiOk = false; // usually "access denied" without admin
  }
  if (zoneOk !== false) {
    const r = await runPS(
      // CPU zone first; other zones can hold firmware placeholders (see _sensor_win.js).
      '$z = Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop | ForEach-Object {' +
        ' $c = $(if ($_.HighPrecisionTemperature) { $_.HighPrecisionTemperature / 10.0 } else { $_.Temperature }) - 273.15;' +
        ' if ($c -gt 0 -and $c -lt 105) { [pscustomobject]@{ Name = $_.Name; C = $c } } };' +
        '$cpu = $z | Where-Object { $_.Name -match "CPU" } | Select-Object -First 1;' +
        'if ($cpu) { $cpu.C } elseif ($z) { ($z | Measure-Object -Property C -Maximum).Maximum }',
      { timeout: 8000 },
    );
    const v = parseFloat(r.stdout.trim());
    if (r.ok && Number.isFinite(v) && v > 0 && v < 150) {
      zoneOk = true;
      return v;
    }
    zoneOk = false;
  }
  return -1;
}

// Shared cache for the slow probes: the HUD polls every ~2 s and the alert
// loop polls too; neither should spawn PowerShell each time.
const slow = { gpu: -1, temp: -1, at: 0, pending: null };

// On Windows every slow figure comes from one warm sensor process instead of a
// PowerShell spawn per sample (see _sensor_win.js).
const sensor = IS_WIN ? require('./_sensor_win') : null;
function winSensor() {
  sensor.start(findNvidiaSmi());
  return sensor.state;
}

function refreshSlow(force = false) {
  if (sensor) {
    const st = winSensor();
    const out = () => ({ gpu: st.gpu, temp: st.temp, at: st.at, pending: null });
    return force && !st.at ? sensor.ready().then(out) : Promise.resolve(out());
  }
  if (!force && Date.now() - slow.at < SLOW_PROBE_MS) return slow.pending || Promise.resolve(slow);
  if (slow.pending) return slow.pending;
  slow.pending = (async () => {
    try {
      const [g, t] = await Promise.all([gpuUsage().catch(() => -1), cpuTemp().catch(() => -1)]);
      slow.gpu = g;
      slow.temp = t;
      slow.at = Date.now();
    } finally {
      slow.pending = null;
    }
    return slow;
  })();
  return slow.pending;
}

async function processCount() {
  if (sensor) {
    winSensor();
    const st = await sensor.ready();
    if (st.procs) return st.procs;
  }
  if (IS_WIN) {
    const r = await runPS('(Get-Process).Count', { timeout: 8000 });
    const n = parseInt(r.stdout.trim(), 10);
    if (r.ok && Number.isFinite(n)) return n;
  }
  const s = sysinfo();
  if (s) {
    try {
      return (await s.processes()).all;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const r1 = (n) => Math.round(n * 10) / 10;

/** Snapshot for the system_status tool — Mark returned str(dict); this returns the same fields as JSON. */
async function getSystemStatus() {
  // CPU first: sampling it while the probes below spawn PowerShell would
  // mostly measure the probes.
  const cpu = await cpuPercent(200);
  const [ram, s, procs] = await Promise.all([memory(), refreshSlow(true), processCount()]);
  const up = os.uptime();
  const status = {
    cpu_percent: r1(cpu),
    ram_percent: r1(ram.percent),
    ram_used_gb: r1(ram.used / 1024 ** 3),
    ram_total_gb: r1(ram.total / 1024 ** 3),
    cpu_temp_c: s.temp > 0 ? r1(s.temp) : null,
    gpu_percent: s.gpu >= 0 ? r1(s.gpu) : null,
    uptime: `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`,
    process_count: procs,
  };
  return JSON.stringify(status);
}

/** Live values for the HUD bars. Percentages 0-100, temperature in °C, 0 = unknown. */
// The HUD's NET gauge and UP / PROC lines. Network throughput is sampled on
// every poll (systeminformation diffs it for us); the process count is slow to
// enumerate on Windows, so it is refreshed in the background every 15 s.
let procCount = 0;
let procAt = 0;
function refreshProcs() {
  if (sensor) {
    procCount = winSensor().procs || procCount;
    return;
  }
  if (Date.now() - procAt < 15_000) return;
  procAt = Date.now();
  try {
    require('systeminformation')
      .processes()
      .then((p) => {
        procCount = p.all || (p.list || []).length || procCount;
      })
      .catch(() => {});
  } catch {
    /* optional */
  }
}

async function netMBps() {
  if (sensor) return Math.round((winSensor().net / 1_048_576) * 100) / 100;
  try {
    const stats = await require('systeminformation').networkStats('*');
    const bytes = stats.reduce((n, s) => n + Math.max(0, s.rx_sec || 0) + Math.max(0, s.tx_sec || 0), 0);
    return Math.round((bytes / 1_048_576) * 100) / 100;
  } catch {
    return 0;
  }
}

async function metrics() {
  refreshProcs();
  const [cpu, ram, s, net] = await Promise.all([cpuPercent(0), memory(), refreshSlow(false), netMBps()]);
  const clampPct = (v) => (Number.isFinite(v) && v > 0 ? Math.min(100, Math.round(v * 10) / 10) : 0);
  // Until the sensor's first sample lands, the slow figures are left out so
  // the HUD shows "--" instead of a confident 0 °C.
  const warming = sensor ? !sensor.state.at : false;
  return {
    cpu: clampPct(cpu),
    ram: clampPct(ram.percent),
    gpu: warming ? undefined : clampPct(s.gpu),
    temp: warming ? undefined : s.temp > 0 ? Math.round(s.temp * 10) / 10 : 0,
    net: warming ? undefined : net,
    uptime: Math.round(require('os').uptime()),
    procs: warming ? undefined : procCount,
  };
}

/**
 * Stateful monitor — cooldown state persists across session reconnections.
 * Call check() periodically; resolves to a [SYSTEM_ALERT] string or null.
 */
class SystemMonitor {
  constructor(thresholds = null) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
    this._lastAlert = {};
    this._cpuStreak = 0;
  }

  _canAlert(key) {
    return Date.now() - (this._lastAlert[key] || 0) > COOLDOWN_MS;
  }

  _record(key) {
    this._lastAlert[key] = Date.now();
  }

  async check() {
    let cpu;
    let ram;
    let temp;
    let gpu;
    try {
      [cpu, ram] = await Promise.all([cpuPercent(0), memory().then((m) => m.percent)]);
      const s = await refreshSlow(false);
      temp = s.temp;
      gpu = s.gpu;
    } catch {
      return null;
    }

    const alerts = [];
    const f0 = (n) => Math.round(n).toString();

    if (cpu >= this.thresholds.cpu) {
      this._cpuStreak += 1;
      if (this._cpuStreak >= CPU_STREAK && this._canAlert('cpu')) {
        alerts.push(
          `[SYSTEM_ALERT] CPU usage has been critically high (${f0(cpu)}%) ` +
            'for several seconds. Warn the user in their language and suggest ' +
            'closing heavy applications.',
        );
        this._record('cpu');
        this._cpuStreak = 0;
      }
    } else {
      this._cpuStreak = 0;
    }

    if (ram >= this.thresholds.ram && this._canAlert('ram')) {
      alerts.push(
        `[SYSTEM_ALERT] RAM is at ${f0(ram)}% — nearly exhausted. ` +
          'Warn the user in their language and suggest freeing memory.',
      );
      this._record('ram');
    }

    if (temp > 0 && temp >= this.thresholds.temp && this._canAlert('temp')) {
      alerts.push(
        `[SYSTEM_ALERT] CPU temperature is ${f0(temp)}°C — above the safe limit. ` +
          'Warn the user in their language and advise reducing system load ' +
          'or checking cooling.',
      );
      this._record('temp');
    }

    if (gpu >= 0 && gpu >= this.thresholds.gpu && this._canAlert('gpu')) {
      alerts.push(`[SYSTEM_ALERT] GPU load is at ${f0(gpu)}%. Briefly inform the user in their language.`);
      this._record('gpu');
    }

    return alerts.length ? alerts.join(' ') : null;
  }
}

function stop() {
  sensor?.stop();
}

module.exports = { DEFAULT_THRESHOLDS, getSystemStatus, metrics, SystemMonitor, stop };
