// Native Windows helpers shared by the Mark LIV computer actions.
//
// Mark leans on pyautogui, pycaw, pygetwindow and ctypes. Node has none of
// those, so this file compiles one small C# class (user32 input, window
// enumeration, Core Audio volume, wallpaper, monitor power) and calls it from
// PowerShell. Add-Type compiling the source on every call costs ~1 s, so the
// class is compiled ONCE into a DLL in the temp dir (named by a hash of the
// source, so an edited source recompiles) and every later call only loads it.
//
// This is a helper (leading underscore): the registry never loads it as a tool.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runPS, run, psQuote } = require('../util/ps');

const IS_WIN = process.platform === 'win32';

const CS_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace MarkNative {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int _RegisterControlChangeNotify(); int _UnregisterControlChangeNotify();
    int _GetChannelCount(); int _SetMasterVolumeLevel();
    int SetMasterVolumeLevelScalar(float fLevel, Guid ctx);
    int _GetMasterVolumeLevel();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int _SetChannelVolumeLevel(); int _SetChannelVolumeLevelScalar();
    int _GetChannelVolumeLevel(); int _GetChannelVolumeLevelScalar();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid ctx);
    int GetMute(out bool pbMute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr p, out IAudioEndpointVolume aev); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int _EnumAudioEndpoints(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

  public static class Audio {
    static IAudioEndpointVolume Endpoint() {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      IMMDevice dev;
      Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
      IAudioEndpointVolume v;
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out v));
      return v;
    }
    public static int GetVolume() { float f; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out f)); return (int)Math.Round(f * 100); }
    public static void SetVolume(int pct) { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, pct)) / 100f, Guid.Empty)); }
    public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }
    public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, Guid.Empty)); }
  }

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static class Input {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

    // Keys that live on the extended part of the keyboard. Without the flag,
    // Win+Left arrives as Win+Numpad4 and snapping silently does nothing.
    static readonly HashSet<int> Extended = new HashSet<int> { 0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E,0x5B,0x5C,0x5D,0xA3,0xA5,0x6F,0x90,0x2C };

    public static void Init() { try { SetProcessDPIAware(); } catch { } }

    static void Key(int vk, bool up) {
      uint flags = (uint)(up ? 0x0002 : 0) | (uint)(Extended.Contains(vk) ? 0x0001 : 0);
      keybd_event((byte)vk, (byte)MapVirtualKey((uint)vk, 0), flags, UIntPtr.Zero);
    }

    // pyautogui.hotkey semantics: press in order, release in reverse.
    public static void Chord(int[] vks) {
      foreach (int vk in vks) { Key(vk, false); System.Threading.Thread.Sleep(15); }
      for (int i = vks.Length - 1; i >= 0; i--) { Key(vks[i], true); System.Threading.Thread.Sleep(10); }
    }

    public static void Press(int vk, int times) {
      for (int i = 0; i < Math.Max(1, times); i++) { Key(vk, false); Key(vk, true); System.Threading.Thread.Sleep(30); }
    }

    // Unicode scan-code typing: independent of keyboard layout, no escaping.
    public static void TypeText(string text, int intervalMs) {
      if (string.IsNullOrEmpty(text)) return;
      int size = Marshal.SizeOf(typeof(INPUT));
      foreach (char c in text) {
        INPUT[] inp = new INPUT[2];
        inp[0].type = 1; inp[0].u.ki.wScan = c; inp[0].u.ki.dwFlags = 0x0004;
        inp[1].type = 1; inp[1].u.ki.wScan = c; inp[1].u.ki.dwFlags = 0x0004 | 0x0002;
        if (c == '\n' || c == '\r') { if (c == '\r') continue; Press(0x0D, 1); }
        else SendInput(2, inp, size);
        if (intervalMs > 0) System.Threading.Thread.Sleep(intervalMs);
      }
    }

    public static int[] ScreenSize() { return new int[] { GetSystemMetrics(0), GetSystemMetrics(1) }; }
    public static int[] CursorPos() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }

    // Glide like pyautogui.moveTo(duration=...) so hover effects still fire.
    public static void MoveTo(int x, int y, int durationMs) {
      POINT p; GetCursorPos(out p);
      int steps = Math.Max(1, durationMs / 10);
      for (int i = 1; i <= steps; i++) {
        SetCursorPos(p.X + (x - p.X) * i / steps, p.Y + (y - p.Y) * i / steps);
        if (durationMs > 0) System.Threading.Thread.Sleep(10);
      }
    }

    static uint[] Flags(string button) {
      if (button == "right") return new uint[] { 0x0008, 0x0010 };
      if (button == "middle") return new uint[] { 0x0020, 0x0040 };
      return new uint[] { 0x0002, 0x0004 };
    }

    public static void Click(bool hasPos, int x, int y, string button, int clicks) {
      if (hasPos) { SetCursorPos(x, y); System.Threading.Thread.Sleep(30); }
      uint[] f = Flags(button);
      for (int i = 0; i < Math.Max(1, clicks); i++) {
        mouse_event(f[0], 0, 0, 0, UIntPtr.Zero); mouse_event(f[1], 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
      }
    }

    public static void Drag(int x1, int y1, int x2, int y2, int durationMs) {
      MoveTo(x1, y1, 200);
      mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
      MoveTo(x2, y2, durationMs);
      mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }

    // Raw wheel units (120 = one notch); > 0 scrolls up/right.
    public static void Scroll(int units, bool horizontal) {
      mouse_event(horizontal ? 0x01000u : 0x0800u, 0, 0, units, UIntPtr.Zero);
    }
  }

  public static class Win {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SystemParametersInfoW(uint a, uint b, string c, uint d);

    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString(); }

    // Visible, titled, un-owned top-level windows: what alt-tab shows.
    public static string List() {
      var sb = new StringBuilder();
      IntPtr fg = GetForegroundWindow();
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
        string t = Title(h);
        if (string.IsNullOrEmpty(t) || t == "Program Manager") return true;
        // Cloaked = parked UWP shells ("Windows Input Experience"), invisible to the user.
        int cloaked = 0;
        try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
        if (cloaked != 0) return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        sb.Append(h.ToInt64()).Append('\t').Append(pid).Append('\t').Append(h == fg ? "1" : "0").Append('\t').Append(t.Replace('\t', ' ').Replace('\n', ' ')).Append('\n');
        return true;
      }, IntPtr.Zero);
      return sb.ToString();
    }

    // Windows refuses SetForegroundWindow to a background process unless it
    // borrows the foreground thread's input queue first.
    public static bool Focus(long handle) {
      IntPtr h = new IntPtr(handle);
      if (IsIconic(h)) ShowWindow(h, 9);
      IntPtr fg = GetForegroundWindow();
      uint p1, p2;
      uint t1 = GetWindowThreadProcessId(fg, out p1);
      uint t2 = GetWindowThreadProcessId(h, out p2);
      bool attached = t1 != t2 && AttachThreadInput(t1, t2, true);
      BringWindowToTop(h);
      bool ok = SetForegroundWindow(h);
      if (attached) AttachThreadInput(t1, t2, false);
      return ok;
    }

    public static void MonitorOff() { PostMessage(new IntPtr(0xFFFF), 0x0112, new IntPtr(0xF170), new IntPtr(2)); }

    public static bool SetWallpaper(string path) { return SystemParametersInfoW(20, 0, path, 3); }
  }
}
`;

const HASH = crypto.createHash('sha1').update(CS_SOURCE).digest('hex').slice(0, 12);
const DLL = path.join(os.tmpdir(), `mark-native-${HASH}.dll`);
let compiling = null;

/** Compile the helper DLL once per source version. Resolves true when usable. */
function ensureDll() {
  if (!IS_WIN) return Promise.resolve(false);
  if (fs.existsSync(DLL)) return Promise.resolve(true);
  compiling ||= (async () => {
    const src = path.join(os.tmpdir(), `mark-native-${HASH}.cs`);
    fs.writeFileSync(src, CS_SOURCE, 'utf8');
    const tmpDll = `${DLL}.${process.pid}.tmp`;
    const r = await runPS(
      `Add-Type -Path ${psQuote(src)} -OutputAssembly ${psQuote(tmpDll)} -OutputType Library`,
      { timeout: 60_000 },
    );
    try {
      if (fs.existsSync(tmpDll) && !fs.existsSync(DLL)) fs.renameSync(tmpDll, DLL);
    } catch {
      /* another process won the race — theirs is identical */
    }
    try {
      fs.rmSync(tmpDll, { force: true });
    } catch {
      /* ignore */
    }
    if (!fs.existsSync(DLL)) {
      compiling = null;
      throw new Error(`could not compile the input helper: ${(r.stderr || '').trim().split('\n')[0]}`);
    }
    return true;
  })();
  return compiling;
}

/**
 * Run a PowerShell snippet with [MarkNative.*] loaded. Throws on failure with
 * the first line of PowerShell's error, so callers can turn it into Mark's
 * "Action failed (...)" strings.
 */
async function native(script, { timeout = 20_000 } = {}) {
  if (!IS_WIN) throw new Error('native helpers are Windows-only');
  await ensureDll();
  const r = await runPS(
    `$ErrorActionPreference='Stop'\nAdd-Type -Path ${psQuote(DLL)}\n[MarkNative.Input]::Init()\n${script}`,
    { timeout },
  );
  if (!r.ok) {
    const line = (r.stderr || '').trim().split(/\r?\n/).find((l) => l.trim()) || `exit ${r.code}`;
    throw new Error(line.replace(/^.*?:\s*/, '').slice(0, 200));
  }
  return r.stdout.trim();
}

// ── Key names (pyautogui vocabulary) → Windows virtual-key codes ─────────────
const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, shiftleft: 0xa0, shiftright: 0xa1,
  ctrl: 0x11, control: 0x11, ctrlleft: 0xa2, ctrlright: 0xa3, alt: 0x12, option: 0x12, altleft: 0xa4,
  altright: 0xa5, pause: 0x13, capslock: 0x14, esc: 0x1b, escape: 0x1b, space: 0x20, ' ': 0x20,
  pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26,
  right: 0x27, down: 0x28, printscreen: 0x2c, print_screen: 0x2c, prtsc: 0x2c, prntscrn: 0x2c,
  insert: 0x2d, delete: 0x2e, del: 0x2e, win: 0x5b, winleft: 0x5b, winright: 0x5c, windows: 0x5b,
  super: 0x5b, command: 0x5b, cmd: 0x5b, apps: 0x5d, menu: 0x5d, numlock: 0x90, scrolllock: 0x91,
  volumemute: 0xad, volumedown: 0xae, volumeup: 0xaf, nexttrack: 0xb0, prevtrack: 0xb1, stop: 0xb2,
  playpause: 0xb3, multiply: 0x6a, add: 0x6b, subtract: 0x6d, decimal: 0x6e, divide: 0x6f,
  equal: 0xbb, equals: 0xbb, '=': 0xbb, plus: 0xbb, '+': 0xbb, minus: 0xbd, '-': 0xbd, comma: 0xbc,
  ',': 0xbc, period: 0xbe, '.': 0xbe, slash: 0xbf, '/': 0xbf, semicolon: 0xba, ';': 0xba,
  apostrophe: 0xde, quote: 0xde, "'": 0xde, bracketleft: 0xdb, '[': 0xdb, bracketright: 0xdd,
  ']': 0xdd, backslash: 0xdc, '\\': 0xdc, backquote: 0xc0, grave: 0xc0, '`': 0xc0,
};
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i;
for (let i = 0; i <= 9; i++) {
  VK[String(i)] = 0x30 + i;
  VK[`num${i}`] = 0x60 + i;
}
for (let c = 97; c <= 122; c++) VK[String.fromCharCode(c)] = c - 32;

function vkOf(name) {
  const raw = String(name || '');
  const k = raw.length === 1 ? raw.toLowerCase() : raw.toLowerCase().trim().replace(/[\s-]+/g, '');
  const code = VK[k] ?? VK[raw.toLowerCase().trim()];
  if (code == null) throw new Error(`unknown key '${name}'`);
  return code;
}

// ── macOS / Linux fallbacks (osascript / xdotool) ────────────────────────────
const MAC_MOD = { command: 'command down', cmd: 'command down', ctrl: 'control down', control: 'control down',
  shift: 'shift down', alt: 'option down', option: 'option down', fn: 'function down' };
const MAC_CODE = { enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  bracketleft: 33, bracketright: 30, equal: 24, minus: 27 };
const X_KEY = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'super', super: 'super',
  command: 'super', enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab',
  space: 'space', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End',
  pageup: 'Prior', pagedown: 'Next', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  volumeup: 'XF86AudioRaiseVolume', volumedown: 'XF86AudioLowerVolume', volumemute: 'XF86AudioMute',
  playpause: 'XF86AudioPlay', equal: 'equal', minus: 'minus', bracketleft: 'bracketleft',
  bracketright: 'bracketright', print_screen: 'Print', printscreen: 'Print' };

async function macChord(keys) {
  const mods = keys.slice(0, -1).map((k) => MAC_MOD[k.toLowerCase()]).filter(Boolean);
  const last = keys[keys.length - 1].toLowerCase();
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  const stmt = MAC_CODE[last] != null ? `key code ${MAC_CODE[last]}${using}` : `keystroke ${JSON.stringify(last)}${using}`;
  const r = await run('osascript', ['-e', `tell application "System Events" to ${stmt}`]);
  if (!r.ok) throw new Error(r.stderr.trim() || 'osascript failed');
}

async function xdo(args) {
  const r = await run('xdotool', args);
  if (!r.ok) throw new Error(r.code === 'ENOENT' || /ENOENT/.test(r.stderr) ? 'xdotool is not installed' : r.stderr.trim());
}

// ── Public API ───────────────────────────────────────────────────────────────

/** pyautogui.hotkey(*keys) */
async function hotkey(...keys) {
  keys = keys.flat().map((k) => String(k).trim()).filter(Boolean);
  if (!keys.length) throw new Error('no keys given');
  if (IS_WIN) return native(`[MarkNative.Input]::Chord(@(${keys.map(vkOf).join(',')}))`);
  if (process.platform === 'darwin') return macChord(keys);
  return xdo(['key', keys.map((k) => X_KEY[k.toLowerCase()] || k).join('+')]);
}

/** pyautogui.press(key, presses=times) */
async function press(key, times = 1) {
  if (IS_WIN) return native(`[MarkNative.Input]::Press(${vkOf(key)}, ${Math.max(1, times | 0)})`);
  for (let i = 0; i < Math.max(1, times); i++) {
    if (process.platform === 'darwin') await macChord([key]);
    else await xdo(['key', X_KEY[String(key).toLowerCase()] || key]);
  }
}

/** pyautogui.write / typewrite — character by character. */
async function typeText(text, intervalMs = 0) {
  text = String(text || '');
  if (!text) return;
  if (IS_WIN) {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    return native(
      `[MarkNative.Input]::TypeText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')), ${Math.max(0, intervalMs | 0)})`,
      { timeout: 30_000 + text.length * (intervalMs + 5) },
    );
  }
  if (process.platform === 'darwin') {
    const r = await run('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(text)}`]);
    if (!r.ok) throw new Error(r.stderr.trim());
    return;
  }
  return xdo(['type', '--delay', String(Math.max(1, intervalMs | 0)), '--', text]);
}

function clipboard() {
  try {
    return require('electron').clipboard || null;
  } catch {
    return null;
  }
}

function clipboardRead() {
  const cb = clipboard();
  return cb ? cb.readText() : null;
}

function clipboardWrite(text) {
  const cb = clipboard();
  if (!cb) return false;
  cb.writeText(String(text));
  return true;
}

const pasteModifier = () => (process.platform === 'darwin' ? 'command' : 'ctrl');

/** Put text on the clipboard and paste it (pyperclip.copy + ctrl+v). Falls back to typing. */
async function pasteText(text) {
  if (!clipboardWrite(text)) return typeText(text, 0);
  await sleep(120);
  return hotkey(pasteModifier(), 'v');
}

async function click({ x, y, button = 'left', clicks = 1 } = {}) {
  const hasPos = x != null && y != null && x !== '' && y !== '';
  if (IS_WIN) {
    return native(
      `[MarkNative.Input]::Click($${hasPos}, ${hasPos ? Number(x) | 0 : 0}, ${hasPos ? Number(y) | 0 : 0}, '${button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left'}', ${Math.max(1, clicks | 0)})`,
    );
  }
  if (process.platform === 'linux') {
    const b = { left: '1', middle: '2', right: '3' }[button] || '1';
    if (hasPos) await xdo(['mousemove', String(x), String(y)]);
    return xdo(['click', '--repeat', String(clicks), b]);
  }
  const r = await run('cliclick', [`${clicks === 2 ? 'dc' : button === 'right' ? 'rc' : 'c'}:${hasPos ? `${x},${y}` : '.'}`]);
  if (!r.ok) throw new Error('mouse control on macOS needs cliclick (brew install cliclick)');
}

async function moveTo(x, y, durationMs = 300) {
  if (IS_WIN) return native(`[MarkNative.Input]::MoveTo(${x | 0}, ${y | 0}, ${durationMs | 0})`);
  if (process.platform === 'linux') return xdo(['mousemove', String(x), String(y)]);
  const r = await run('cliclick', [`m:${x},${y}`]);
  if (!r.ok) throw new Error('mouse control on macOS needs cliclick (brew install cliclick)');
}

async function drag(x1, y1, x2, y2, durationMs = 500) {
  if (IS_WIN) return native(`[MarkNative.Input]::Drag(${x1 | 0}, ${y1 | 0}, ${x2 | 0}, ${y2 | 0}, ${durationMs | 0})`);
  if (process.platform === 'linux') {
    return xdo(['mousemove', String(x1), String(y1), 'mousedown', '1', 'mousemove', String(x2), String(y2), 'mouseup', '1']);
  }
  const r = await run('cliclick', [`dd:${x1},${y1}`, `du:${x2},${y2}`]);
  if (!r.ok) throw new Error('mouse control on macOS needs cliclick (brew install cliclick)');
}

/**
 * Scroll by `units` raw wheel units (120 = one notch; > 0 = up, or right when
 * horizontal). This is what pyautogui.scroll(n) sends on Windows, so Mark's
 * scroll_up(500) stays ~4 notches here too.
 */
async function scroll(units, horizontal = false) {
  units = Number(units) | 0;
  if (IS_WIN) return native(`[MarkNative.Input]::Scroll(${units}, $${horizontal})`);
  if (process.platform === 'linux') {
    const btn = horizontal ? (units > 0 ? '7' : '6') : units > 0 ? '4' : '5';
    const notches = Math.max(1, Math.min(50, Math.round(Math.abs(units) / 120)));
    return xdo(['click', '--repeat', String(notches), btn]);
  }
  throw new Error('scrolling is not supported on this OS without extra tools');
}

async function screenSize() {
  if (IS_WIN) {
    const out = await native('[MarkNative.Input]::ScreenSize() -join ","');
    const [w, h] = out.split(',').map(Number);
    return { width: w, height: h };
  }
  try {
    const { screen } = require('electron');
    const d = screen.getPrimaryDisplay();
    return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  } catch {
    return { width: 1920, height: 1080 };
  }
}

/** Capture the primary screen to a PNG file (pyautogui.screenshot().save). */
async function screenshotTo(file) {
  if (IS_WIN) {
    await native(
      'Add-Type -AssemblyName System.Drawing\n' +
        '$s = [MarkNative.Input]::ScreenSize()\n' +
        '$bmp = New-Object System.Drawing.Bitmap $s[0], $s[1]\n' +
        '$g = [System.Drawing.Graphics]::FromImage($bmp)\n' +
        '$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)\n' +
        `$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)\n` +
        '$g.Dispose(); $bmp.Dispose()',
      { timeout: 20_000 },
    );
    return file;
  }
  const r =
    process.platform === 'darwin'
      ? await run('screencapture', ['-x', file])
      : await run('import', ['-window', 'root', file]).then((x) => (x.ok ? x : run('scrot', ['-o', file])));
  if (!r.ok) throw new Error(r.stderr.trim() || 'screenshot failed');
  return file;
}

/** Visible top-level windows: [{handle, pid, active, title}]. */
async function listWindows() {
  if (!IS_WIN) {
    if (process.platform === 'linux') {
      const r = await run('wmctrl', ['-l', '-p']);
      if (!r.ok) return [];
      return r.stdout.split('\n').filter(Boolean).map((l) => {
        const m = l.match(/^(\S+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/);
        return m ? { handle: m[1], pid: Number(m[2]), active: false, title: m[3] } : null;
      }).filter(Boolean);
    }
    return [];
  }
  const out = await native('[Console]::OutputEncoding = [Text.Encoding]::UTF8\n[MarkNative.Win]::List()');
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [handle, pid, active, ...rest] = l.split('\t');
    return { handle: Number(handle), pid: Number(pid), active: active === '1', title: rest.join('\t') };
  });
}

async function focusHandle(handle) {
  return (await native(`[MarkNative.Win]::Focus([long]${Number(handle)})`)).toLowerCase() === 'true';
}

// ── Audio (Windows Core Audio) ───────────────────────────────────────────────
const getVolume = async () => Number(await native('[MarkNative.Audio]::GetVolume()'));
const setVolume = (v) => native(`[MarkNative.Audio]::SetVolume(${Math.max(0, Math.min(100, Math.round(Number(v))))})`);
const getMute = async () => (await native('[MarkNative.Audio]::GetMute()')).toLowerCase() === 'true';
const setMute = (m) => native(`[MarkNative.Audio]::SetMute($${Boolean(m)})`);

const monitorOff = () => native('[MarkNative.Win]::MonitorOff()');
const setWallpaperWin = async (file) =>
  (await native(`[MarkNative.Win]::SetWallpaper(${psQuote(file)})`)).toLowerCase() === 'true';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  IS_WIN,
  native,
  ensureDll,
  vkOf,
  hotkey,
  press,
  typeText,
  pasteText,
  clipboardRead,
  clipboardWrite,
  click,
  moveTo,
  drag,
  scroll,
  screenSize,
  screenshotTo,
  listWindows,
  focusHandle,
  getVolume,
  setVolume,
  getMute,
  setMute,
  monitorOff,
  setWallpaperWin,
  sleep,
};
