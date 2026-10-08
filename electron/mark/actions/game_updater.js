// game_updater — the Node port of Mark LIV's actions/game_updater.py.
//
// Steam: the install path comes from the registry (or the usual folders), the
// libraries from steamapps/libraryfolders.vdf, and each game from its
// appmanifest_*.acf (StateFlags 4 = up to date, 1026 = downloading/updating,
// 6/516 = update pending). Updates and installs are steam://update|install/<id>
// URLs. Epic: games are the launcher's *.item manifests; updates go through
// com.epicgames.launcher:// URLs.
//
// Mark drove Steam's windows with pyautogui + numpy (profile picker) and
// pywinauto (install dialog). Here the same steps are a small C# pixel scan
// and Windows UI Automation, both run through the shared _native helper.
//
// Scheduling mirrors Mark, which pointed the OS scheduler at this very file
// with `--scheduled`: the job runs this module with the app's own executable
// in Node mode (ELECTRON_RUN_AS_NODE=1), so the scheduled run uses exactly
// the logic below. Nothing here requires electron, which keeps that working.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, launchDetached, psQuote } = require('../util/ps');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = !IS_WIN && !IS_MAC;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');
const exists = (p) => {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};

// Lazy so the scheduled Node-mode run (no window automation) never loads it.
const native = () => require('./_native');

const KNOWN_APPIDS = {
  pubg: ['578080', 'PUBG: Battlegrounds'],
  'pubg battlegrounds': ['578080', 'PUBG: Battlegrounds'],
  'pubg: battlegrounds': ['578080', 'PUBG: Battlegrounds'],
  battlegrounds: ['578080', 'PUBG: Battlegrounds'],
  gta5: ['271590', 'Grand Theft Auto V'],
  'gta v': ['271590', 'Grand Theft Auto V'],
  'grand theft auto v': ['271590', 'Grand Theft Auto V'],
  cs2: ['730', 'Counter-Strike 2'],
  csgo: ['730', 'Counter-Strike 2'],
  'counter-strike 2': ['730', 'Counter-Strike 2'],
  'counter strike 2': ['730', 'Counter-Strike 2'],
  dota2: ['570', 'Dota 2'],
  'dota 2': ['570', 'Dota 2'],
  rust: ['252490', 'Rust'],
  valheim: ['892970', 'Valheim'],
  cyberpunk: ['1091500', 'Cyberpunk 2077'],
  'cyberpunk 2077': ['1091500', 'Cyberpunk 2077'],
  'elden ring': ['1245620', 'ELDEN RING'],
  minecraft: ['1672970', 'Minecraft Launcher'],
  'apex legends': ['1172470', 'Apex Legends'],
  apex: ['1172470', 'Apex Legends'],
  fortnite: ['1517990', 'Fortnite'],
  'goose goose duck': ['1568590', 'Goose Goose Duck'],
  'among us': ['945360', 'Among Us'],
  'fall guys': ['1097150', 'Fall Guys'],
  'rocket league': ['252950', 'Rocket League'],
  warframe: ['230410', 'Warframe'],
  'destiny 2': ['1085660', 'Destiny 2'],
  'team fortress 2': ['440', 'Team Fortress 2'],
  tf2: ['440', 'Team Fortress 2'],
  'left 4 dead 2': ['550', 'Left 4 Dead 2'],
  l4d2: ['550', 'Left 4 Dead 2'],
  paladins: ['444090', 'Paladins'],
  smite: ['386360', 'SMITE'],
  'war thunder': ['236390', 'War Thunder'],
  'world of warships': ['552990', 'World of Warships'],
  'path of exile': ['238960', 'Path of Exile'],
  poe: ['238960', 'Path of Exile'],
  'lost ark': ['1599340', 'Lost Ark'],
  'new world': ['1063730', 'New World: Aeternum'],
};

/** winreg QueryValueEx: the string value of `name` under `key`, or ''. */
async function regValue(key, name) {
  const r = await run('reg.exe', ['query', key, '/v', name], { timeout: 5000 });
  if (!r.ok) return '';
  const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi').exec(r.stdout);
  return m ? m[1].trim() : '';
}

// ── Steam discovery ──────────────────────────────────────────────────────────

async function findSteamPath() {
  if (IS_WIN) return findSteamWindows();
  if (IS_MAC) return findSteamMac();
  return findSteamLinux();
}

async function findSteamWindows() {
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'HKLM\\SOFTWARE\\Valve\\Steam', 'HKCU\\SOFTWARE\\Valve\\Steam']) {
    const val = await regValue(key, 'InstallPath');
    if (val && exists(path.join(val, 'steam.exe'))) return val;
  }
  for (const p of [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Steam'),
    path.join(process.env.ProgramFiles || '', 'Steam'),
    'C:/Steam', 'D:/Steam', 'E:/Steam', 'F:/Steam',
  ]) {
    if (exists(path.join(p, 'steam.exe'))) return path.normalize(p);
  }
  return null;
}

function findSteamMac() {
  for (const p of [path.join(os.homedir(), 'Library', 'Application Support', 'Steam'), '/Applications/Steam.app/Contents/MacOS']) {
    if (exists(p)) return p;
  }
  return null;
}

function findSteamLinux() {
  for (const p of [
    path.join(os.homedir(), '.steam', 'steam'),
    path.join(os.homedir(), '.steam', 'root'),
    path.join(os.homedir(), '.local', 'share', 'Steam'),
    '/usr/share/steam',
    '/opt/steam',
  ]) {
    if (exists(p)) return p;
  }
  return null;
}

function steamExe(steamPath) {
  if (IS_WIN) return path.join(steamPath, 'steam.exe');
  if (IS_MAC) return '/Applications/Steam.app/Contents/MacOS/steam_osx';
  return path.join(steamPath, 'steam.sh');
}

function launchSteamUrl(exe, url) {
  const ok = IS_MAC ? launchDetached('open', [url]) : IS_LINUX ? launchDetached('xdg-open', [url]) : launchDetached(exe, [url]);
  if (!ok) throw new Error(`could not launch ${IS_WIN ? exe : 'the URL handler'}`);
}

function getSteamLibraries(steamPath) {
  const main = path.join(steamPath, 'steamapps');
  const libraries = [main];
  const vdf = path.join(main, 'libraryfolders.vdf');
  if (!exists(vdf)) return libraries;
  try {
    const content = fs.readFileSync(vdf, 'utf8');
    for (const m of content.matchAll(/"path"\s+"([^"]+)"/g)) {
      // The VDF escapes backslashes ("D:\\SteamLibrary").
      const lib = path.join(m[1].replace(/\\\\/g, '/'), 'steamapps');
      const known = libraries.some((l) => path.resolve(l).toLowerCase() === path.resolve(lib).toLowerCase());
      if (exists(lib) && !known) libraries.push(lib);
    }
  } catch {
    /* keep what we have */
  }
  return libraries;
}

function getSteamGames(steamPath) {
  const games = [];
  for (const lib of getSteamLibraries(steamPath)) {
    let files = [];
    try {
      files = fs.readdirSync(lib).filter((f) => /^appmanifest_.*\.acf$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const acf = path.join(lib, f);
      try {
        const content = fs.readFileSync(acf, 'utf8');
        const appId = /"appid"\s+"(\d+)"/.exec(content);
        const name = /"name"\s+"([^"]+)"/.exec(content);
        const state = /"StateFlags"\s+"(\d+)"/.exec(content);
        const size = /"SizeOnDisk"\s+"(\d+)"/.exec(content);
        if (appId && name) {
          games.push({
            id: appId[1],
            name: name[1],
            state: state ? Number(state[1]) : 0,
            size: size ? Number(size[1]) : 0,
            lib,
            acf,
          });
        }
      } catch {
        /* next */
      }
    }
  }
  return games;
}

async function isProcRunning(winImage, unixName) {
  try {
    if (IS_WIN) {
      const r = await run('tasklist.exe', ['/FI', `IMAGENAME eq ${winImage}`], { timeout: 10_000 });
      return r.stdout.toLowerCase().includes(winImage.toLowerCase());
    }
    const r = await run('pgrep', ['-x', unixName], { timeout: 10_000 });
    return !!r.stdout.trim();
  } catch {
    return false;
  }
}

const isSteamRunning = () => isProcRunning('steam.exe', IS_MAC ? 'steam_osx' : 'steam');

// ── Steam window automation (Windows) ────────────────────────────────────────
//
// numpy's pixel work from Mark, in C#: find the first visible window whose
// title mentions Steam (pygetwindow's rule), decide whether it is the
// profile picker, and locate the first colourful avatar block.

const VISION_CS = String.raw`
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class MarkSteamVision {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

  public static int[] FindSteam() {
    int[] found = null;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity);
      if (!IsWindowVisible(h) || sb.ToString().ToLower().IndexOf("steam") < 0) return true;
      RECT r; GetWindowRect(h, out r);
      if (r.R - r.L <= 200) return true;
      found = new int[] { r.L, r.T, r.R - r.L, r.B - r.T };
      return false;
    }, IntPtr.Zero);
    return found;
  }

  static byte[] Grab(int[] w, out int stride) {
    using (var bmp = new Bitmap(w[2], w[3], PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(w[0], w[1], 0, 0, bmp.Size);
      var data = bmp.LockBits(new Rectangle(0, 0, w[2], w[3]), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      stride = data.Stride;
      var buf = new byte[stride * w[3]];
      Marshal.Copy(data.Scan0, buf, 0, buf.Length);
      bmp.UnlockBits(data);
      return buf;
    }
  }

  // Small window, or a bright (white) top third: the "who's playing?" picker.
  public static bool ProfileDialogLikely(int[] w) {
    bool isSmall = w[2] < 900 && w[3] < 700;
    int stride; byte[] px = Grab(w, out stride);
    int white = 0;
    for (int y = 0; y < w[3] / 3; y++)
      for (int x = 0; x < w[2]; x++) {
        int i = y * stride + x * 4;
        if (px[i + 2] > 200 && px[i + 1] > 200 && px[i] > 200) white++;
      }
    return isSmall || white > 100;
  }

  // {x, y, found}: centre of the first colourful block in the middle area.
  public static int[] AvatarPoint(int[] w) {
    int stride; byte[] px = Grab(w, out stride);
    int h = w[3], ww = w[2];
    int y1 = h / 3, y2 = h * 3 / 4, x1 = ww / 5, x2 = ww * 4 / 5;
    int rw = x2 - x1;
    bool[] colAny = new bool[rw];
    long rowSum = 0; int rowCount = 0;
    for (int y = y1; y < y2; y++) {
      bool rowAny = false;
      for (int x = x1; x < x2; x++) {
        int i = y * stride + x * 4;
        int b = px[i], g = px[i + 1], r = px[i + 2];
        int mx = Math.Max(r, Math.Max(g, b)), mn = Math.Min(r, Math.Min(g, b));
        if (mx > 60 && mx - mn > 40) { colAny[x - x1] = true; rowAny = true; }
      }
      if (rowAny) { rowSum += y - y1; rowCount++; }
    }
    int first = -1;
    for (int c = 0; c < rw; c++) if (colAny[c]) { first = c; break; }
    if (first < 0 || rowCount == 0) return new int[] { 0, 0, 0 };
    int avatarW = Math.Min(90, rw / 4);
    long colSum = 0; int colCount = 0;
    for (int c = first; c < rw && c < first + avatarW; c++) if (colAny[c]) { colSum += c; colCount++; }
    return new int[] { w[0] + x1 + (int)(colSum / colCount), w[1] + y1 + (int)(rowSum / rowCount), 1 };
  }
}
`;

const VISION_LOAD = `Add-Type -TypeDefinition ${psQuote(VISION_CS)} -ReferencedAssemblies System.Drawing`;

async function clickFirstProfileByScreenshot() {
  try {
    await sleep(1500);
    const out = await native().native(
      `${VISION_LOAD}\n$w = [MarkSteamVision]::FindSteam()\nif ($w -eq $null) { 'nowin' } else { ($w -join ',') + '|' + ([MarkSteamVision]::AvatarPoint($w) -join ',') }`,
      { timeout: 60_000 },
    );
    if (out === 'nowin') {
      console.log('[GameUpdater] ⚠️ Steam window not found');
      return false;
    }
    const [[wx, wy, ww, wh], [ax, ay, found]] = out.split('|').map((s) => s.split(',').map(Number));
    if (!found) {
      console.log('[GameUpdater] ⚠️ Avatar colour not found — clicking by guess');
      await native().click({ x: wx + Math.floor(ww / 2) - Math.floor(ww / 6), y: wy + Math.floor(wh / 2) });
      return true;
    }
    console.log(`[GameUpdater] 🎯 Profile avatar (${ax}, ${ay}) — clicking`);
    await native().click({ x: ax, y: ay });
    return true;
  } catch (e) {
    console.log(`[GameUpdater] ⚠️ Profile detection failed: ${e.message || e}`);
    return false;
  }
}

async function handleSteamProfileSelection() {
  console.log('[GameUpdater] 🔍 Checking profile-selection dialog...');
  let likely = true;
  try {
    const out = await native().native(
      `${VISION_LOAD}\n$w = [MarkSteamVision]::FindSteam()\nif ($w -eq $null) { 'nowin' } else { [MarkSteamVision]::ProfileDialogLikely($w) }`,
      { timeout: 60_000 },
    );
    if (out === 'nowin') return false;
    likely = out.toLowerCase() === 'true';
  } catch {
    /* as Mark: when the check itself fails, assume the picker is showing */
  }
  if (!likely) {
    console.log('[GameUpdater] ℹ️ No profile dialog — Steam is already logged in');
    return false;
  }
  console.log('[GameUpdater] 👤 Profile selection detected — clicking the first profile');
  return clickFirstProfileByScreenshot();
}

// ── Steam install dialog (Windows) ───────────────────────────────────────────

function findBestDrive() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const drivePath = `${letter}:\\`;
    if (!exists(drivePath)) continue;
    try {
      const s = fs.statfsSync(drivePath);
      const freeGb = (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3;
      if (freeGb > 0) drives.push({ letter, path: drivePath, free_gb: freeGb });
    } catch {
      /* next */
    }
  }
  return drives.length ? drives.reduce((a, b) => (b.free_gb > a.free_gb ? b : a)) : null;
}

// pywinauto's steps in UI Automation. Titles are matched at the start (as
// pywinauto's title_re does). This drives Steam's native installer dialog by
// its on-screen text, which is localised: English and Turkish labels are
// matched (install/yükle, next/ileri, ok/tamam), as in Mark. Elsewhere the
// match simply fails and the result says so; a manual install still works.
function installDialogScript(driveLetter) {
  return `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$all = [System.Windows.Automation.Condition]::TrueCondition
$target = ${psQuote(driveLetter.toUpperCase())}

function Of-Type($root, $type) {
  $root.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)))
}
function Click-El($el) {
  try { $p = $el.GetClickablePoint(); [MarkNative.Input]::Click($true, [int]$p.X, [int]$p.Y, 'left', 1); return $true } catch { }
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 0) { [MarkNative.Input]::Click($true, [int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2), 'left', 1); return $true }
  } catch { }
  return $false
}

$dialog = $null
for ($i = 0; $i -lt 40 -and -not $dialog; $i++) {
  Start-Sleep -Milliseconds 500
  foreach ($w in $AE::RootElement.FindAll($TS::Children, $all)) {
    try {
      if ($w.Current.Name -notmatch '(?i)^(install|yükle|steam)') { continue }
      $r = $w.Current.BoundingRectangle
      if ($w.Current.IsOffscreen -or $r.Width -le 300 -or $r.Height -le 200) { continue }
      $text = (@($w.FindAll($TS::Descendants, $all) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join ' ').ToUpper()
      if ($text -match 'C:|D:|E:|F:|INSTALL|YÜKLE') { $dialog = $w; break }
    } catch { }
  }
}
if (-not $dialog) { 'nodialog'; return }

try { $dialog.SetFocus() } catch { }
Start-Sleep -Milliseconds 400

$selected = $false
foreach ($type in @($CT::ListItem, $CT::RadioButton)) {
  if ($selected) { break }
  try {
    foreach ($c in (Of-Type $dialog $type)) {
      if ($c.Current.Name.ToUpper().Contains($target)) { if (Click-El $c) { $selected = $true; break } }
    }
  } catch { }
}
if (-not $selected) {
  try {
    foreach ($combo in (Of-Type $dialog $CT::ComboBox)) {
      try {
        $ec = $combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $ec.Expand(); Start-Sleep -Milliseconds 150
        foreach ($item in (Of-Type $combo $CT::ListItem)) {
          if ($item.Current.Name.ToUpper().Contains($target)) {
            $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
            $selected = $true; break
          }
        }
        if ($selected) { break }
        $ec.Collapse()
      } catch { }
    }
  } catch { }
}
if (-not $selected) {
  try {
    foreach ($c in $dialog.FindAll($TS::Descendants, $all)) {
      $t = $c.Current.Name.ToUpper()
      if ($t.Contains($target + ':') -and $t.Length -lt 80) { if (Click-El $c) { $selected = $true; break } }
    }
  } catch { }
}

$clicked = $false
$keywords = @('install', 'yükle', 'next', 'ileri', 'ok', 'tamam')
try {
  foreach ($b in (Of-Type $dialog $CT::Button)) {
    try {
      $t = $b.Current.Name.ToLower().Trim()
      $hit = $false
      foreach ($k in $keywords) { if ($t -eq $k -or $t.Contains($k)) { $hit = $true } }
      if ($hit) {
        $done = $false
        try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $done = $true } catch { }
        if (-not $done) { $done = Click-El $b }
        if ($done) { $clicked = $true; break }
      }
    } catch { }
  }
} catch { }
"$selected|$clicked"
`;
}

// Mark's pyautogui fallback: click where the drive field and Install button
// usually sit in the dialog, typing the drive letter in between.
function installDialogFallbackScript(driveLetter) {
  return `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$win = $null
for ($i = 0; $i -lt 30 -and -not $win; $i++) {
  Start-Sleep -Milliseconds 500
  foreach ($w in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $n = $w.Current.Name.ToLower()
      if (($n.Contains('install') -or $n.Contains('steam')) -and $w.Current.BoundingRectangle.Width -gt 300 -and -not $w.Current.IsOffscreen) { $win = $w; break }
    } catch { }
  }
}
if (-not $win) { 'nowin'; return }
try { $win.SetFocus(); Start-Sleep -Milliseconds 400 } catch { }
$r = $win.Current.BoundingRectangle
[MarkNative.Input]::Click($true, [int]($r.X + $r.Width * 0.35), [int]($r.Y + $r.Height * 0.45), 'left', 1)
Start-Sleep -Milliseconds 200
[MarkNative.Input]::TypeText(${psQuote(driveLetter)}, 50)
Start-Sleep -Milliseconds 200
[MarkNative.Input]::Click($true, [int]($r.X + $r.Width * 0.72), [int]($r.Y + $r.Height * 0.88), 'left', 1)
'ok'
`;
}

async function handleInstallDialogFallback(gameName, bestDrive) {
  const driveLabel = `${bestDrive.letter}:`;
  try {
    const out = await native().native(installDialogFallbackScript(bestDrive.letter), { timeout: 60_000 });
    if (out.endsWith('nowin')) return `Please select '${driveLabel}' and click Install in Steam for '${gameName}'.`;
    return `Attempted drive ${driveLabel} selection and Install click for '${gameName}'.`;
  } catch {
    return `Install dialog opened for '${gameName}'. Please select '${driveLabel}' and click Install manually.`;
  }
}

async function handleInstallDialog(gameName) {
  const bestDrive = findBestDrive();
  if (!bestDrive) return `Install dialog opened for '${gameName}'. Could not detect drives.`;

  const driveLabel = `${bestDrive.letter}:`;
  console.log(`[GameUpdater] 🏆 Target drive: ${driveLabel} (${bestDrive.free_gb.toFixed(1)} GB free)`);

  try {
    const out = await native().native(installDialogScript(bestDrive.letter), { timeout: 120_000 });
    const last = out.split(/\r?\n/).pop();
    if (last === 'nodialog') throw new Error('Dialog not found');
    const [selected, clicked] = last.split('|').map((s) => s.toLowerCase() === 'true');
    if (clicked) {
      const suffix = selected ? `Selected ${driveLabel} and` : 'Default drive used, but';
      return `${suffix} clicked Install for '${gameName}'.`;
    }
    return `Please click Install manually in Steam for '${gameName}'.`;
  } catch (e) {
    console.log(`[GameUpdater] ⚠️ UI Automation failed: ${e.message || e}`);
    return handleInstallDialogFallback(gameName, bestDrive);
  }
}

// ── Steam actions ────────────────────────────────────────────────────────────

async function ensureSteamRunning(steamPath) {
  if (await isSteamRunning()) return true;

  const exe = steamExe(steamPath);
  if (!exists(exe)) {
    console.log(`[GameUpdater] ❌ Steam not found: ${exe}`);
    return false;
  }

  console.log('[GameUpdater] 🚀 Starting Steam...');
  if (IS_MAC) launchDetached('open', ['-a', 'Steam']);
  else launchDetached(exe, []);

  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await isSteamRunning()) {
      console.log('[GameUpdater] ✅ Steam is running');
      await sleep(4000);
      if (IS_WIN) {
        await handleSteamProfileSelection();
        await sleep(2000);
      }
      return true;
    }
  }
  console.log('[GameUpdater] ⚠️ Could not start Steam');
  return false;
}

async function searchSteamAppid(gameName) {
  const nameLower = gameName.toLowerCase().trim();

  const steamPath = await findSteamPath();
  if (steamPath) {
    for (const g of getSteamGames(steamPath)) {
      if (g.name.toLowerCase().includes(nameLower)) return [g.id, g.name];
    }
  }

  if (KNOWN_APPIDS[nameLower]) {
    const [appId, canonical] = KNOWN_APPIDS[nameLower];
    console.log(`[GameUpdater] 📖 Known: ${canonical} (${appId})`);
    return [appId, canonical];
  }
  for (const [key, [appId, canonical]] of Object.entries(KNOWN_APPIDS)) {
    if (key.includes(nameLower) || nameLower.includes(key)) {
      console.log(`[GameUpdater] 📖 Partial match: ${canonical} (${appId})`);
      return [appId, canonical];
    }
  }

  try {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=english&cc=US`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    const items = (await r.json()).items || [];
    if (items.length) {
      const best = items[0];
      console.log(`[GameUpdater] 🌐 Store API: ${best.name} (${best.id})`);
      return [String(best.id), best.name];
    }
  } catch (e) {
    console.log(`[GameUpdater] ⚠️ AppID lookup failed: ${e.message || e}`);
  }
  return [null, null];
}

async function updateSteamGames(steamPath, gameName = null) {
  if (!(await ensureSteamRunning(steamPath))) return 'Could not start Steam.';

  const exe = steamExe(steamPath);
  const games = getSteamGames(steamPath);
  if (!games.length) return 'No Steam games found.';

  let targets = games;
  if (gameName) {
    const nameLower = gameName.toLowerCase();
    targets = games.filter((g) => g.name.toLowerCase().includes(nameLower));
    if (!targets.length) {
      const available = games.slice(0, 5).map((g) => g.name).join(', ');
      return `Game '${gameName}' not found. Installed: ${available}...`;
    }
  }

  const alreadyUpdated = [];
  const alreadyRunning = [];
  const updateStarted = [];
  const errors = [];

  for (const game of targets) {
    if (game.state === 4) alreadyUpdated.push(game.name);
    else if (game.state === 1026) alreadyRunning.push(game.name);
    else {
      try {
        launchSteamUrl(exe, `steam://update/${game.id}`);
        updateStarted.push(game.name);
        await sleep(300);
      } catch (e) {
        errors.push(`${game.name}: ${e.message || e}`);
      }
    }
  }

  const parts = [];
  if (updateStarted.length) {
    const names = updateStarted.slice(0, 3).join(', ');
    const suffix = updateStarted.length > 3 ? ` and ${updateStarted.length - 3} more` : '';
    parts.push(`Update started for: ${names}${suffix}.`);
  }
  if (alreadyRunning.length) parts.push(`Already updating: ${alreadyRunning.join(', ')}.`);
  if (alreadyUpdated.length) {
    parts.push(gameName ? `${alreadyUpdated[0]} is already up to date.` : `${alreadyUpdated.length} game(s) already up to date.`);
  }
  if (errors.length) parts.push(`Errors: ${errors.join('; ')}.`);
  return parts.length ? parts.join(' ') : 'No games to update.';
}

async function installSteamGame(steamPath, gameName = null, appId = null) {
  if (!(await ensureSteamRunning(steamPath))) return 'Could not start Steam.';

  const exe = steamExe(steamPath);
  const installed = getSteamGames(steamPath);

  let already = null;
  if (appId) already = installed.find((g) => g.id === String(appId)) || null;
  else if (gameName) {
    const nameLower = gameName.toLowerCase();
    already = installed.find((g) => g.name.toLowerCase().includes(nameLower)) || null;
  } else return 'Please specify a game name or AppID.';

  if (already) {
    const { state, name } = already;
    if (state === 4) return `'${name}' is already installed and up to date.`;
    if (state === 1026) return `'${name}' is currently downloading or updating.`;
    if (state === 6 || state === 516) {
      launchSteamUrl(exe, `steam://update/${already.id}`);
      return `'${name}' has a pending update. Update started.`;
    }
    return `'${name}' is already installed.`;
  }

  if (!appId && gameName) {
    const [foundId, foundName] = await searchSteamAppid(gameName);
    if (!foundId) return `Could not find '${gameName}' on Steam. Try providing the AppID directly.`;
    appId = foundId;
    gameName = foundName || gameName;
    console.log(`[GameUpdater] 🔍 Installing: ${gameName} (AppID: ${appId})`);
  }

  try {
    launchSteamUrl(exe, `steam://install/${appId}`);
    if (IS_WIN) {
      // Mark ran this on a daemon thread; the result is only logged.
      handleInstallDialog(gameName || String(appId))
        .then((m) => console.log(`[GameUpdater] ${m}`))
        .catch(() => {});
    }
    return `Install started for '${gameName}'. Steam will open the download dialog.`;
  } catch (e) {
    return `Install failed: ${e.message || e}`;
  }
}

function getDownloadStatus(steamPath) {
  const games = getSteamGames(steamPath);
  const active = games.filter((g) => g.state === 1026);
  const pending = games.filter((g) => g.state === 6 || g.state === 516);
  const lines = [];
  if (active.length) lines.push(`Downloading: ${active.map((g) => g.name).join(', ')}.`);
  if (pending.length) {
    const names = pending.slice(0, 5).map((g) => g.name).join(', ');
    const suffix = pending.length > 5 ? ` and ${pending.length - 5} more` : '';
    lines.push(`Pending updates: ${names}${suffix}.`);
  }
  return lines.length ? lines.join(' ') : 'No active downloads or pending updates.';
}

async function systemShutdown() {
  if (IS_WIN) await run('shutdown.exe', ['/s', '/t', '10']);
  else if (IS_MAC) await run('osascript', ['-e', 'tell app "System Events" to shut down']);
  else await run('systemctl', ['poweroff']);
}

/** Mark's daemon thread: wait for a download to start, then shut down when it ends. */
async function watchAndShutdown(steamPath, speak, checkIntervalMs = 30_000, timeoutHours = 12) {
  console.log('[GameUpdater] Watching downloads for auto-shutdown...');
  const deadline = Date.now() + timeoutHours * 3600_000;

  let started = false;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const active = getSteamGames(steamPath).filter((g) => g.state === 1026);
    if (active.length) {
      speak?.(`Download started for ${active.map((g) => g.name).join(', ')}. I'll shut down when done.`);
      started = true;
      break;
    }
  }
  if (!started) return;

  while (Date.now() < deadline) {
    await sleep(checkIntervalMs);
    if (!getSteamGames(steamPath).some((g) => g.state === 1026)) {
      speak?.('Download complete. Shutting down now.');
      await sleep(5000);
      await systemShutdown();
      return;
    }
  }
  speak?.('Download taking too long. Cancelling auto-shutdown.');
}

// ── Epic ─────────────────────────────────────────────────────────────────────

async function findEpicExe() {
  if (IS_WIN) return findEpicExeWindows();
  if (IS_MAC) return exists('/Applications/Epic Games Launcher.app/Contents/MacOS/EpicGamesLauncher')
    ? '/Applications/Epic Games Launcher.app/Contents/MacOS/EpicGamesLauncher' : null;
  for (const c of [path.join(os.homedir(), '.local', 'bin', 'heroic'), '/usr/bin/heroic']) {
    if (exists(c)) return c;
  }
  return null;
}

async function findEpicExeWindows() {
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\EpicGames\\EpicGamesLauncher',
    'HKLM\\SOFTWARE\\EpicGames\\EpicGamesLauncher',
    'HKCU\\SOFTWARE\\EpicGames\\EpicGamesLauncher',
  ]) {
    const val = await regValue(key, 'AppDataPath');
    if (!val) continue;
    const exe = path.join(val, 'Binaries', 'Win64', 'EpicGamesLauncher.exe');
    if (exists(exe)) return exe;
  }
  const tail = ['Binaries', 'Win64', 'EpicGamesLauncher.exe'];
  for (const c of [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Epic Games', 'Launcher', 'Portal', ...tail),
    path.join(process.env.ProgramFiles || '', 'Epic Games', 'Launcher', 'Portal', ...tail),
    path.join(process.env.LOCALAPPDATA || '', 'EpicGamesLauncher', 'Portal', ...tail),
  ]) {
    if (exists(c)) return c;
  }
  return null;
}

function epicManifestsPath() {
  let p = null;
  if (IS_WIN) p = path.join(process.env.PROGRAMDATA || 'C:/ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  else if (IS_MAC) p = path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  return p && exists(p) ? p : null;
}

function getEpicGames() {
  const manifests = epicManifestsPath();
  if (!manifests) return [];
  const games = [];
  let files = [];
  try {
    files = fs.readdirSync(manifests).filter((f) => f.toLowerCase().endsWith('.item'));
  } catch {
    return [];
  }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(manifests, f), 'utf8').replace(/^\ufeff/, ''));
      const name = data.DisplayName || data.AppName || '';
      if (name) games.push({ id: data.AppName || '', name });
    } catch {
      /* next */
    }
  }
  return games;
}

const isEpicRunning = () => isProcRunning('EpicGamesLauncher.exe', IS_MAC ? 'EpicGamesLauncher' : 'heroic');

async function updateEpicGames(epicExe, gameName = null) {
  const games = getEpicGames();

  if (gameName) {
    const nameLower = gameName.toLowerCase();
    const matched = games.filter((g) => g.name.toLowerCase().includes(nameLower));
    if (!matched.length) return `'${gameName}' not found in Epic.`;
    const url = `com.epicgames.launcher://apps/${matched[0].id}?action=launch&silent=true`;
    let ok;
    if (IS_MAC) ok = launchDetached('open', [url]);
    else if (IS_LINUX) ok = epicExe ? launchDetached(epicExe, [url]) : launchDetached('xdg-open', [url]);
    else ok = launchDetached(epicExe, [url]);
    return ok ? `Opened Epic for '${matched[0].name}'.` : 'Epic update failed: could not launch the launcher.';
  }

  try {
    if (IS_MAC) launchDetached('open', ['-a', 'Epic Games Launcher']);
    else if (IS_LINUX) {
      if (epicExe) launchDetached(epicExe, []);
      else return 'Epic Games is not natively supported on Linux. Consider using Heroic Launcher.';
    } else if (await isEpicRunning()) {
      for (const g of games.slice(0, 10)) {
        launchDetached(epicExe, [`com.epicgames.launcher://apps/${g.id}?action=launch&silent=true`]);
        await sleep(500);
      }
      return `Triggered update check for ${games.length} Epic game(s).`;
    } else {
      launchDetached(epicExe, []);
    }
    const count = games.length;
    return count ? `Epic Games Launcher opened. ${count} game(s) will be checked.` : 'Epic Games Launcher opened.';
  } catch (e) {
    return `Epic launch failed: ${e.message || e}`;
  }
}

// ── Daily schedule ───────────────────────────────────────────────────────────

const TASK_NAME = 'JARVIS_GameUpdater';
const SELF = __filename;
const MAC_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.jarvis.gameupdater.plist');
const CRON_MARKER = '# JARVIS_GameUpdater';

async function scheduleDailyUpdate(hour = 3, minute = 0) {
  if (IS_WIN) return scheduleWindows(hour, minute);
  if (IS_MAC) return scheduleMac(hour, minute);
  return scheduleLinux(hour, minute);
}

async function scheduleWindows(hour, minute) {
  // schtasks cannot set environment variables and /TR is capped at 261
  // characters, so the task runs a tiny wrapper script that sets Node mode and
  // starts this file with the app's own executable.
  const dir = path.join(os.homedir(), '.jarvis');
  fs.mkdirSync(dir, { recursive: true });
  const wrapper = path.join(dir, 'game_updater_scheduled.ps1');
  fs.writeFileSync(
    wrapper,
    `\ufeff# Auto-generated by J.A.R.V.I.S game_updater — do not edit\n$env:ELECTRON_RUN_AS_NODE = '1'\n& ${psQuote(process.execPath)} ${psQuote(SELF)} --scheduled\n`,
    'utf8',
  );
  const tr = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${wrapper}"`;
  const hhmm = `${pad2(hour)}:${pad2(minute)}`;

  await run('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { timeout: 15_000 });
  let result = null;
  for (const extra of [['/RL', 'HIGHEST', '/RU', 'SYSTEM'], []]) {
    result = await run('schtasks.exe', ['/Create', '/TN', TASK_NAME, '/TR', tr, '/SC', 'DAILY', '/ST', hhmm, '/F', ...extra], { timeout: 15_000 });
    if (result.ok) return `Daily game update scheduled at ${hhmm}.`;
  }
  return `Scheduling failed: ${(result.stderr || result.stdout).trim()}`;
}

async function scheduleMac(hour, minute) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>com.jarvis.gameupdater</string>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(process.execPath)}</string>
        <string>${esc(SELF)}</string>
        <string>--scheduled</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>${hour}</integer>
        <key>Minute</key><integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key><false/>
</dict></plist>`;
  try {
    fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true });
    fs.writeFileSync(MAC_PLIST, plist, 'utf8');
    await run('launchctl', ['unload', MAC_PLIST]);
    const r = await run('launchctl', ['load', MAC_PLIST]);
    if (r.ok) return `Daily game update scheduled at ${pad2(hour)}:${pad2(minute)} via launchd.`;
    return `Scheduling failed: ${r.stderr.trim()}`;
  } catch (e) {
    return `Scheduling failed: ${e.message || e}`;
  }
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

async function scheduleLinux(hour, minute) {
  const cronEntry = `${minute} ${hour} * * * ELECTRON_RUN_AS_NODE=1 ${shq(process.execPath)} ${shq(SELF)} --scheduled  ${CRON_MARKER}`;
  try {
    const existing = await run('crontab', ['-l']);
    const lines = existing.stdout.split('\n').filter((l) => l && !l.includes(CRON_MARKER) && !l.includes(SELF));
    lines.push(cronEntry);
    const r = await run('crontab', ['-'], { input: `${lines.join('\n')}\n` });
    if (r.ok) return `Daily game update scheduled at ${pad2(hour)}:${pad2(minute)} via cron.`;
    return `Scheduling failed: ${r.stderr.trim()}`;
  } catch (e) {
    return `Scheduling failed: ${e.message || e}`;
  }
}

async function cancelScheduledUpdate() {
  if (IS_WIN) {
    const r = await run('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { timeout: 15_000 });
    if (r.ok) {
      try {
        fs.rmSync(path.join(os.homedir(), '.jarvis', 'game_updater_scheduled.ps1'), { force: true });
      } catch {
        /* ignore */
      }
    }
    return r.ok ? 'Scheduled update cancelled.' : 'No scheduled update found.';
  }
  if (IS_MAC) {
    if (exists(MAC_PLIST)) {
      await run('launchctl', ['unload', MAC_PLIST]);
      fs.rmSync(MAC_PLIST, { force: true });
      return 'Scheduled update cancelled.';
    }
    return 'No scheduled update found.';
  }
  try {
    const existing = await run('crontab', ['-l']);
    const lines = existing.stdout.split('\n').filter((l) => l && !l.includes('JARVIS_GameUpdater'));
    await run('crontab', ['-'], { input: `${lines.join('\n')}\n` });
    return 'Scheduled update cancelled.';
  } catch (e) {
    return `Cancel failed: ${e.message || e}`;
  }
}

async function getScheduleStatus() {
  if (IS_WIN) {
    const r = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { timeout: 15_000 });
    if (!r.ok) return 'No scheduled game update found.';
    for (const line of r.stdout.trim().split(/\r?\n/)) {
      if (['Next Run', 'Sonraki', 'Prochaine', 'Próxima', 'Nächste'].some((k) => line.includes(k))) {
        return `Game update scheduled. ${line.trim()}`;
      }
    }
    return 'Game update is scheduled.';
  }
  if (IS_MAC) return exists(MAC_PLIST) ? 'Game update is scheduled via launchd.' : 'No scheduled game update found.';
  try {
    const r = await run('crontab', ['-l']);
    for (const line of r.stdout.split('\n')) {
      if (line.includes('JARVIS_GameUpdater')) return `Game update is scheduled: ${line.split('#')[0].trim()}`;
    }
    return 'No scheduled game update found.';
  } catch {
    return 'No scheduled game update found.';
  }
}

// ── Tool ─────────────────────────────────────────────────────────────────────

async function gameUpdater(parameters, ctx) {
  const p = parameters || {};
  const action = String(p.action || 'update').toLowerCase().trim();
  const platform = String(p.platform || 'both').toLowerCase().trim();
  const gameName = String(p.game_name || '').trim() || null;
  const appId = String(p.app_id || '').trim() || null;
  const hour = parseInt(p.hour ?? 3, 10);
  const minute = parseInt(p.minute ?? 0, 10);
  const shutdown = String(p.shutdown_when_done ?? 'false').toLowerCase() === 'true';
  const speak = ctx?.speak;
  const log = (m) => ctx?.ui?.log?.(m);

  if (Number.isNaN(hour) || Number.isNaN(minute)) return 'Hour and minute must be numbers.';

  const results = [];

  if (action === 'schedule') return scheduleDailyUpdate(hour, minute);
  if (action === 'cancel_schedule') return cancelScheduledUpdate();
  if (action === 'schedule_status') return getScheduleStatus();

  if (action === 'list') {
    if (platform === 'steam' || platform === 'both') {
      const steamPath = await findSteamPath();
      if (steamPath) {
        const games = getSteamGames(steamPath);
        if (games.length) {
          const names = games.slice(0, 8).map((g) => g.name).join(', ');
          const suffix = games.length > 8 ? ` and ${games.length - 8} more` : '';
          results.push(`Steam (${games.length} games): ${names}${suffix}.`);
        } else results.push('Steam: No games found.');
      } else results.push('Steam: Not installed.');
    }
    if (platform === 'epic' || platform === 'both') {
      if (IS_LINUX) results.push('Epic: Not natively supported on Linux.');
      else {
        const games = getEpicGames();
        if (games.length) {
          const names = games.slice(0, 8).map((g) => g.name).join(', ');
          const suffix = games.length > 8 ? ` and ${games.length - 8} more` : '';
          results.push(`Epic (${games.length} games): ${names}${suffix}.`);
        } else results.push('Epic: No games found.');
      }
    }
    return results.join(' | ') || 'No platforms found.';
  }

  if (action === 'download_status') {
    if (platform === 'steam' || platform === 'both') {
      const steamPath = await findSteamPath();
      results.push(steamPath ? getDownloadStatus(steamPath) : 'Steam: Not installed.');
    }
    if (platform === 'epic' || platform === 'both') results.push('Epic download status not available directly.');
    return results.join(' ');
  }

  if (action === 'install' || action === 'update') {
    if (platform === 'steam' || platform === 'both') {
      const steamPath = await findSteamPath();
      if (!steamPath) results.push('Steam: Not installed.');
      else {
        if (gameName) {
          const nameLower = gameName.toLowerCase();
          const isInstalled = getSteamGames(steamPath).some((g) => g.name.toLowerCase().includes(nameLower));
          if (!isInstalled) {
            let msg = await installSteamGame(steamPath, gameName, appId);
            if (shutdown) {
              watchAndShutdown(steamPath, speak).catch(() => {});
              msg += ' Auto-shutdown enabled.';
            }
            log(`[GameUpdater] ${msg.slice(0, 100)}`);
            speak?.(msg);
            return msg;
          }
          results.push(`Steam: ${await updateSteamGames(steamPath, gameName)}`);
        } else if (action === 'install') {
          results.push('Steam: Please specify a game name to install.');
        } else {
          results.push(`Steam: ${await updateSteamGames(steamPath)}`);
        }

        if (shutdown) {
          watchAndShutdown(steamPath, speak).catch(() => {});
          results.push('Auto-shutdown enabled.');
        }
      }
    }

    if (platform === 'epic' || platform === 'both') {
      if (IS_LINUX) results.push('Epic: Not natively supported on Linux. Use Heroic Launcher.');
      else {
        const epicExe = await findEpicExe();
        results.push(epicExe ? `Epic: ${await updateEpicGames(epicExe, gameName)}` : 'Epic: Not installed.');
      }
    }

    const output = results.join(' | ') || 'Nothing to do.';
    log(`[GameUpdater] ${output.slice(0, 100)}`);
    speak?.(output);
    return output;
  }

  return `Unknown action: '${action}'.`;
}

// The scheduled run (see scheduleDailyUpdate): `<app exe> game_updater.js --scheduled`
// with ELECTRON_RUN_AS_NODE=1.
if (require.main === module && process.argv.includes('--scheduled')) {
  const now = new Date();
  console.log(`[GameUpdater] 🕐 Scheduled run at ${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
  gameUpdater({ action: 'update', platform: 'both' }, null).then((r) => {
    console.log(`[GameUpdater] ✅ ${r}`);
    // steam:// launches are detached; nothing left to wait for.
    setTimeout(() => process.exit(0), 2000);
  });
}

module.exports = {
  TOOL: {
    name: 'game_updater',
    description:
      'THE ONLY tool for ANY Steam or Epic Games request. Use for: installing, downloading, updating games, listing installed games, checking download status, scheduling updates. ALWAYS call directly for any Steam/Epic/game request. NEVER use browser_control or web_search for Steam/Epic.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: {
          type: 'STRING',
          description: 'update | install | list | download_status | schedule | cancel_schedule | schedule_status (default: update)',
        },
        platform: { type: 'STRING', description: 'steam | epic | both (default: both)' },
        game_name: { type: 'STRING', description: 'Game name (partial match supported)' },
        app_id: { type: 'STRING', description: 'Steam AppID for install (optional)' },
        hour: { type: 'INTEGER', description: 'Hour for scheduled update 0-23 (default: 3)' },
        minute: { type: 'INTEGER', description: 'Minute for scheduled update 0-59 (default: 0)' },
        shutdown_when_done: { type: 'BOOLEAN', description: 'Shut down PC when download finishes' },
      },
      required: [],
    },
  },
  run: gameUpdater,
  findSteamPath,
  getSteamGames,
  getEpicGames,
  searchSteamAppid,
};
