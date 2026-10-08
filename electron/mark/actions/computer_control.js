// computer_control — the Node port of Mark LIV's actions/computer_control.py.
//
// Direct, low-level control: typing, clicks, hotkeys, scrolling, mouse moves,
// clipboard, screenshots, window focus, and the Gemini-powered screen_find /
// screen_click that locate a described UI element on a screenshot. pyautogui
// and pyperclip are replaced by _native.js (user32 via PowerShell) and
// Electron's clipboard.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, runPS, psQuote } = require('../util/ps');
const native = require('./_native');

const FIRST_NAMES = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Drew', 'Quinn',
  'Avery', 'Blake', 'Cameron', 'Dakota', 'Emerson', 'Finley', 'Harper'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas', 'Jackson'];
const DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'proton.me', 'mail.com'];

const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pad2 = (n) => String(n).padStart(2, '0');

function randomData(dataType) {
  const dt = String(dataType || '').toLowerCase().trim();
  if (dt === 'first_name') return choice(FIRST_NAMES);
  if (dt === 'last_name') return choice(LAST_NAMES);
  if (dt === 'name') return `${choice(FIRST_NAMES)} ${choice(LAST_NAMES)}`;
  if (dt === 'email') {
    return `${choice(FIRST_NAMES).toLowerCase()}.${choice(LAST_NAMES).toLowerCase()}${randint(10, 999)}@${choice(DOMAINS)}`;
  }
  if (dt === 'username') return `${choice(FIRST_NAMES).toLowerCase()}${randint(100, 9999)}`;
  if (dt === 'password') {
    const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const chars = `${letters}${digits}!@#$%`;
    const raw = [choice([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']), choice([...digits]), choice([...'!@#$%'])];
    for (let i = 0; i < 9; i++) raw.push(choice([...chars]));
    for (let i = raw.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [raw[i], raw[j]] = [raw[j], raw[i]];
    }
    return raw.join('');
  }
  if (dt === 'phone') return `+1${randint(200, 999)}${randint(1_000_000, 9_999_999)}`;
  if (dt === 'birthday') return `${pad2(randint(1, 12))}/${pad2(randint(1, 28))}/${randint(1980, 2000)}`;
  if (dt === 'address') return `${randint(100, 9999)} ${choice(['Main St', 'Oak Ave', 'Park Blvd', 'Elm St', 'Cedar Ln'])}`;
  if (dt === 'zip_code') return String(randint(10000, 99999));
  if (dt === 'city') return choice(['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix']);
  return `random_${dataType}_${randint(1000, 9999)}`;
}

/** Identity fields from long-term memory ({key: value}). */
function userProfile(ctx) {
  try {
    const identity = (ctx?.memory?.loadMemory?.() || {}).identity || {};
    const out = {};
    for (const [k, v] of Object.entries(identity)) {
      out[k] = v && typeof v === 'object' ? String(v.value ?? '') : String(v ?? '');
    }
    return out;
  } catch {
    return {};
  }
}

const getOs = (ctx) => String(ctx?.config?.snapshot?.().os || ctx?.os || { win32: 'windows', darwin: 'mac' }[process.platform] || 'linux').toLowerCase();
const trunc = (t) => `${t.slice(0, 60)}${t.length > 60 ? '…' : ''}`;

/** Screenshots may only be written inside the home directory. */
function safeScreenshotPath(requested, ctx) {
  const desktop = ctx?.paths?.desktop || path.join(os.homedir(), 'Desktop');
  const fallback = path.join(desktop, 'jarvis_screenshot.png');
  if (!requested) return fallback;
  try {
    const p = path.resolve(String(requested).replace(/^~(?=$|[\\/])/, os.homedir()));
    const rel = path.relative(path.resolve(os.homedir()), p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return p;
    }
  } catch {
    /* fall back */
  }
  return fallback;
}

async function typeAction(text, intervalMs = 30) {
  text = String(text || '');
  await native.sleep(300);
  await native.typeText(text, intervalMs);
  return `Typed: ${trunc(text)}`;
}

async function clearField(ctx) {
  await native.hotkey(getOs(ctx) === 'mac' ? 'command' : 'ctrl', 'a');
  await native.sleep(100);
  await native.press('delete');
  return 'Field cleared';
}

async function smartType(text, clearFirst, ctx) {
  text = String(text || '');
  if (clearFirst) {
    await clearField(ctx);
    await native.sleep(100);
  }
  if (text.length > 20 && native.clipboardWrite(text)) {
    await native.sleep(100);
    await native.hotkey(getOs(ctx) === 'mac' ? 'command' : 'ctrl', 'v');
    return `Smart-typed (clipboard): ${trunc(text)}`;
  }
  await native.typeText(text, 40);
  return `Smart-typed: ${trunc(text)}`;
}

async function click(x, y, button = 'left', clicks = 1) {
  if (x != null && y != null) {
    await native.click({ x, y, button, clicks });
    return `${clicks === 2 ? 'Double-c' : 'C'}licked (${x}, ${y}) [${button}]`;
  }
  await native.click({ button, clicks });
  return `Clicked at current position [${button}]`;
}

async function hotkey(keys) {
  await native.hotkey(...keys);
  return `Hotkey: ${keys.join('+')}`;
}

async function pressKey(key) {
  await native.press(key);
  return `Pressed: ${key}`;
}

async function scroll(direction = 'down', amount = 3) {
  const vertical = direction === 'up' || direction === 'down';
  const clicks = direction === 'up' || direction === 'right' ? amount : -amount;
  // `amount` means notches to the model ("scroll down 3"); one notch = 120 units.
  await native.scroll(clicks * 120, !vertical);
  return `Scrolled ${direction} ×${amount}`;
}

async function move(x, y) {
  await native.moveTo(x, y, 300);
  return `Mouse → (${x}, ${y})`;
}

async function drag(x1, y1, x2, y2) {
  await native.drag(x1, y1, x2, y2, 500);
  return `Dragged (${x1},${y1}) → (${x2},${y2})`;
}

async function clipboardGet() {
  const text = native.clipboardRead();
  if (text != null) return text;
  await native.hotkey('ctrl', 'c');
  await native.sleep(200);
  return '(copied — clipboard unavailable for read)';
}

async function clipboardPaste(text, ctx) {
  text = String(text || '');
  if (!native.clipboardWrite(text)) return 'clipboard not available';
  await native.sleep(100);
  await native.hotkey(getOs(ctx) === 'mac' ? 'command' : 'ctrl', 'v');
  return `Pasted: ${trunc(text)}`;
}

async function screenshot(savePath, ctx) {
  const p = safeScreenshotPath(savePath, ctx);
  await native.screenshotTo(p);
  return `Screenshot saved: ${p}`;
}

// ── Window focus ─────────────────────────────────────────────────────────────
async function focusWindow(title, ctx) {
  const osName = getOs(ctx);
  title = String(title || '');

  if (osName === 'windows') {
    try {
      // Mark used WScript.Shell.AppActivate, which only matches a title
      // PREFIX. Matching any part of the title first, then falling back to
      // AppActivate, finds "Chrome" in "Inbox - Google Chrome".
      const needle = title.toLowerCase();
      const wins = needle ? await native.listWindows() : [];
      const hit =
        wins.find((w) => w.title.toLowerCase() === needle) ||
        wins.find((w) => w.title.toLowerCase().startsWith(needle)) ||
        wins.find((w) => w.title.toLowerCase().includes(needle));
      if (hit && (await native.focusHandle(hit.handle))) {
        await native.sleep(300);
        return `Focused window: ${hit.title}`;
      }
      await runPS(`[void](New-Object -ComObject WScript.Shell).AppActivate(${psQuote(title)})`, { timeout: 5000 });
      await native.sleep(300);
      return `Focused window: ${title}`;
    } catch (e) {
      return `focus_window (Windows) failed: ${e.message || e}`;
    }
  }

  if (osName === 'mac') {
    const script = `tell application "System Events" to set frontmost of (first process whose name contains ${JSON.stringify(title)}) to true`;
    const r = await run('osascript', ['-e', script], { timeout: 5000 });
    if (!r.ok && /ENOENT/.test(r.stderr)) return `focus_window (macOS) failed: ${r.stderr.trim()}`;
    await native.sleep(300);
    return `Focused window: ${title}`;
  }

  if (osName === 'linux') {
    const r = await run('wmctrl', ['-a', title], { timeout: 5000 });
    if (r.ok) {
      await native.sleep(300);
      return `Focused window: ${title}`;
    }
    const x = await run('xdotool', ['search', '--name', title, 'windowactivate'], { timeout: 5000 });
    if (!x.ok && /ENOENT/.test(x.stderr)) return 'focus_window (Linux) requires wmctrl or xdotool';
    await native.sleep(300);
    return `Focused window: ${title}`;
  }

  return `focus_window: unknown OS '${osName}'`;
}

// ── AI element finder ────────────────────────────────────────────────────────
async function screenFind(description, ctx) {
  if (!ctx?.gemini) {
    console.warn('[ComputerControl] no Gemini client for screen_find');
    return null;
  }
  const tmp = path.join(ctx?.paths?.temp || os.tmpdir(), `mark-screen-${process.pid}-${Date.now()}.png`);
  try {
    const { width: w, height: h } = await native.screenSize();
    await native.screenshotTo(tmp);
    const data = fs.readFileSync(tmp).toString('base64');
    const prompt =
      `This is a screenshot of a ${w}×${h} pixel screen. ` +
      `Locate the UI element described as: '${description}'. ` +
      'Reply with ONLY the center coordinates as: x,y ' +
      'If the element is not visible, reply: NOT_FOUND';
    const response = await ctx.gemini.call([{ inlineData: { mimeType: 'image/png', data } }, { text: prompt }], {
      tier: ctx.gemini.FAST,
      timeoutMs: 20_000,
    });
    if (!response) return null;
    const text = String(response.text || '').trim();
    if (text.toUpperCase().includes('NOT_FOUND')) return null;
    const m = text.match(/(\d+)\s*,\s*(\d+)/);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  } catch (e) {
    console.warn(`[ComputerControl] screen_find failed: ${e.message || e}`);
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
  return null;
}

const int = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

async function computerControl(parameters, ctx) {
  const params = parameters || {};
  const action = String(params.action || '').toLowerCase().trim();
  if (!action) return 'No action specified for computer_control.';

  ctx?.ui?.log?.(`[Computer] ${action}`);
  console.log(`[ComputerControl] ▶ ${action}  ${JSON.stringify(params)}`);

  const coord = (v) => (v == null || v === '' ? null : int(v));

  try {
    switch (action) {
      case 'type':
        return await typeAction(params.text || '');
      case 'smart_type':
        return await smartType(params.text || '', params.clear_first ?? true, ctx);
      case 'click':
      case 'left_click':
        return await click(coord(params.x), coord(params.y), 'left', 1);
      case 'double_click':
        return await click(coord(params.x), coord(params.y), 'left', 2);
      case 'right_click':
        return await click(coord(params.x), coord(params.y), 'right', 1);
      case 'move':
        return await move(int(params.x), int(params.y));
      case 'drag':
        return await drag(int(params.x1), int(params.y1), int(params.x2), int(params.y2));
      case 'hotkey': {
        const raw = params.keys ?? '';
        const keys = typeof raw === 'string' ? raw.split('+').map((k) => k.trim()) : Array.from(raw);
        return await hotkey(keys);
      }
      case 'press':
        return await pressKey(params.key || 'enter');
      case 'scroll':
        return await scroll(params.direction || 'down', int(params.amount ?? 3, 3));
      case 'copy':
        return await clipboardGet();
      case 'paste':
        return await clipboardPaste(params.text || '', ctx);
      case 'screenshot':
        return await screenshot(params.path, ctx);
      case 'screen_find': {
        const coords = await screenFind(params.description || '', ctx);
        return coords ? `${coords[0]},${coords[1]}` : 'NOT_FOUND';
      }
      case 'screen_click': {
        const desc = params.description || '';
        const coords = await screenFind(desc, ctx);
        if (coords) {
          await native.sleep(200);
          await click(coords[0], coords[1]);
          return `Clicked '${desc}' at (${coords[0]}, ${coords[1]})`;
        }
        return `Element not found on screen: '${desc}'`;
      }
      case 'wait': {
        let secs = parseFloat(params.seconds ?? 1.0);
        if (!Number.isFinite(secs)) secs = 1.0;
        secs = Math.min(secs, 30.0);
        await native.sleep(Math.max(0, secs) * 1000);
        return `Waited ${secs}s`;
      }
      case 'clear_field':
        return await clearField(ctx);
      case 'focus_window':
        return await focusWindow(params.title || '', ctx);
      case 'random_data': {
        const dt = params.type || 'name';
        const result = randomData(dt);
        console.log(`[ComputerControl] random ${dt} → ${result}`);
        return result;
      }
      case 'user_data': {
        const field = params.field || 'name';
        let value = userProfile(ctx)[field] || '';
        if (!value) {
          value = randomData(field);
          console.log(`[ComputerControl] No '${field}' in memory, using random: ${value}`);
        }
        return value;
      }
      default:
        return `Unknown action: '${action}'`;
    }
  } catch (e) {
    console.warn(`[ComputerControl] ${action}: ${e.message || e}`);
    return `computer_control '${action}' failed: ${e.message || e}`;
  }
}

module.exports = {
  TOOL: {
    name: 'computer_control',
    description:
      'Direct computer control: type, click, hotkeys, scroll, move mouse, screenshots, find elements on screen.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: {
          type: 'STRING',
          description:
            'type | smart_type | click | double_click | right_click | hotkey | press | scroll | move | copy | paste | screenshot | wait | clear_field | focus_window | screen_find | screen_click | random_data | user_data',
        },
        text: { type: 'STRING', description: 'Text to type or paste' },
        x: { type: 'INTEGER', description: 'X coordinate' },
        y: { type: 'INTEGER', description: 'Y coordinate' },
        keys: { type: 'STRING', description: "Key combination e.g. 'ctrl+c'" },
        key: { type: 'STRING', description: "Single key e.g. 'enter'" },
        direction: { type: 'STRING', description: 'up | down | left | right' },
        amount: { type: 'INTEGER', description: 'Scroll amount (default: 3)' },
        seconds: { type: 'NUMBER', description: 'Seconds to wait' },
        title: { type: 'STRING', description: 'Window title for focus_window' },
        description: { type: 'STRING', description: 'Element description for screen_find/screen_click' },
        type: { type: 'STRING', description: 'Data type for random_data' },
        field: { type: 'STRING', description: 'Field for user_data: name|email|city' },
        clear_first: { type: 'BOOLEAN', description: 'Clear field before typing (default: true)' },
        path: { type: 'STRING', description: 'Save path for screenshot' },
      },
      required: ['action'],
    },
  },
  run: computerControl,
  randomData,
  focusWindow,
  screenFind,
  listWindows: native.listWindows,
};
