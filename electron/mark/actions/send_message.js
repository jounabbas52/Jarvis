// send_message — the Node port of Mark LIV's actions/send_message.py.
//
// Pure keystroke automation, exactly like Mark: open the messaging app, search
// the contact with Ctrl+F (Cmd+F on macOS), paste the name, Enter, paste the
// message, Enter. Instagram and Messenger go through the browser as in Mark.
// pyautogui/pyperclip become the shared _native helpers; every key goes
// through the `native` object (not destructured) so a test can stub it.

const { run, launchDetached } = require('../util/ps');
const native = require('./_native');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mark read os_system from its config; ctx.os carries the same value here.
let currentOs = 'windows';
const isMac = () => currentOs === 'mac';

async function pasteText(text) {
  // pyperclip.copy + ctrl/cmd+v; typing when there is no clipboard (as Mark
  // fell back to pyautogui.write).
  if (native.clipboardWrite(text)) {
    await sleep(150);
    await native.hotkey(isMac() ? 'command' : 'ctrl', 'v');
    await sleep(100);
  } else {
    await native.typeText(text, 30);
  }
}

async function clearAndPaste(text) {
  await native.hotkey(isMac() ? 'command' : 'ctrl', 'a');
  await sleep(100);
  await native.press('delete');
  await sleep(100);
  await pasteText(text);
}

async function openApp(appName) {
  try {
    if (currentOs === 'windows') {
      await native.press('win');
      await sleep(500);
      await pasteText(appName);
      await sleep(600);
      await native.press('enter');
      await sleep(2500);
      return true;
    }
    if (currentOs === 'mac') {
      let r = await run('open', ['-a', appName], { timeout: 10_000 });
      if (!r.ok) r = await run('open', ['-a', `${appName}.app`], { timeout: 10_000 });
      await sleep(2500);
      return r.ok;
    }
    // Linux: the first launcher that exists wins.
    let launched = false;
    for (const launcher of [['gtk-launch', [appName.toLowerCase()]], [appName.toLowerCase(), []]]) {
      if (await spawnable(launcher[0], launcher[1])) {
        launched = true;
        break;
      }
    }
    await sleep(2500);
    return launched;
  } catch (e) {
    console.log(`[SendMessage] ⚠️ Could not open ${appName}: ${e.message || e}`);
    return false;
  }
}

/** subprocess.Popen semantics: true unless the executable does not exist. */
function spawnable(file, args) {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process');
      const child = spawn(file, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

async function openBrowserUrl(url) {
  try {
    let opened = false;
    try {
      const { shell } = require('electron');
      if (shell?.openExternal) {
        await shell.openExternal(url);
        opened = true;
      }
    } catch {
      /* not in Electron — fall through to the OS opener */
    }
    if (!opened) {
      if (process.platform === 'win32') opened = launchDetached('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
      else opened = launchDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
    }
    if (!opened) return false;
    await sleep(4000);
    return true;
  } catch (e) {
    console.log(`[SendMessage] ⚠️ Could not open browser: ${e.message || e}`);
    return false;
  }
}

async function searchInApp(query) {
  await native.hotkey(isMac() ? 'command' : 'ctrl', 'f');
  await sleep(500);
  await clearAndPaste(query);
  await sleep(1000);
}

async function desktopSend(appName, receiver, message) {
  if (!(await openApp(appName))) return `Could not open ${appName}.`;

  await sleep(1000);
  await searchInApp(receiver);
  await native.press('enter');
  await sleep(800);

  await pasteText(message);
  await sleep(200);
  await native.press('enter');
  await sleep(300);
  return `Message sent to ${receiver} via ${appName}.`;
}

// ── WhatsApp: installed app first, WhatsApp Web otherwise ────────────────────
// Mark only knew the desktop app: it typed "WhatsApp" into Start and pressed
// Enter. Without the app installed that opens a web search or nothing, and
// the Ctrl+F that follows is the browser's find bar — so the message never
// went anywhere and the assistant kept trying. The app is now looked up
// first, and WhatsApp Web in the user's own (already signed-in) browser is the
// fallback.

let waAppCache = null; // { kind: 'appid' | 'exe' | 'mac', target } once found

async function findWhatsAppDesktop() {
  if (waAppCache) return waAppCache;
  if (currentOs === 'windows') {
    // Store / MSIX install: listed in the Start menu's app list.
    const r = await require('../util/ps').runPS(
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Where-Object { $_.Name -match '^WhatsApp' } | Select-Object -First 1 | ForEach-Object { $_.AppID }",
      { timeout: 15_000 },
    );
    const appId = r.stdout.trim().split(/\r?\n/)[0];
    if (r.ok && appId) return (waAppCache = { kind: 'appid', target: appId });
    // Classic installer.
    const fs = require('fs');
    const path = require('path');
    const exe = path.join(process.env.LOCALAPPDATA || '', 'WhatsApp', 'WhatsApp.exe');
    if (process.env.LOCALAPPDATA && fs.existsSync(exe)) return (waAppCache = { kind: 'exe', target: exe });
    return null;
  }
  if (currentOs === 'mac') {
    const fs = require('fs');
    for (const p of ['/Applications/WhatsApp.app', `${process.env.HOME}/Applications/WhatsApp.app`]) {
      if (fs.existsSync(p)) return (waAppCache = { kind: 'mac', target: 'WhatsApp' });
    }
    return null;
  }
  return null; // no official Linux client
}

async function launchWhatsAppDesktop(app) {
  if (app.kind === 'appid') return launchDetached('explorer.exe', [`shell:AppsFolder\\${app.target}`]);
  if (app.kind === 'exe') return launchDetached(app.target, []);
  return (await run('open', ['-a', app.target], { timeout: 10_000 })).ok;
}

async function sendWhatsappWeb(receiver, message) {
  if (!(await openBrowserUrl('https://web.whatsapp.com/'))) return 'Could not open WhatsApp Web in the browser.';
  // openBrowserUrl already waited 4 s; WhatsApp Web needs longer to load its
  // chat list before search works.
  await sleep(6000);

  // WhatsApp Web's own search shortcut. Ctrl+F would open the browser's find
  // bar instead.
  await native.hotkey(isMac() ? 'command' : 'ctrl', isMac() ? 'option' : 'alt', '/');
  await sleep(700);
  await clearAndPaste(receiver);
  await sleep(2000); // results arrive as you type
  await native.press('enter'); // opens the top match; focus moves to its message box
  await sleep(1500);

  await pasteText(message);
  await sleep(300);
  await native.press('enter');
  await sleep(300);
  return (
    `Message sent to ${receiver} via WhatsApp Web (the WhatsApp app is not installed). ` +
    'If WhatsApp Web was not signed in, or the chat did not match, it may not have gone through.'
  );
}

async function sendWhatsapp(receiver, message) {
  const app = await findWhatsAppDesktop();
  if (!app) return sendWhatsappWeb(receiver, message);

  if (!(await launchWhatsAppDesktop(app))) return sendWhatsappWeb(receiver, message);
  await sleep(3500);
  await searchInApp(receiver);
  await native.press('enter');
  await sleep(800);
  await pasteText(message);
  await sleep(200);
  await native.press('enter');
  await sleep(300);
  return `Message sent to ${receiver} via WhatsApp.`;
}
const sendTelegram = (r, m) => desktopSend('Telegram', r, m);
const sendSignal = (r, m) => desktopSend('Signal', r, m);
const sendDiscord = (r, m) => desktopSend('Discord', r, m);

async function sendInstagram(receiver, message) {
  if (!(await openBrowserUrl('https://www.instagram.com/direct/new/'))) return 'Could not open Instagram in browser.';

  await pasteText(receiver);
  await sleep(1500);

  await native.press('down');
  await sleep(300);
  await native.press('enter');
  await sleep(400);

  for (let i = 0; i < 4; i++) {
    await native.press('tab');
    await sleep(150);
  }
  await native.press('enter');
  await sleep(2000);

  await pasteText(message);
  await sleep(200);
  await native.press('enter');
  await sleep(300);

  return `Message sent to ${receiver} via Instagram.`;
}

async function sendMessenger(receiver, message) {
  if (!(await openBrowserUrl('https://www.messenger.com/'))) return 'Could not open Messenger in browser.';

  await searchInApp(receiver);
  await sleep(500);
  await native.press('down');
  await sleep(300);
  await native.press('enter');
  await sleep(1000);

  await pasteText(message);
  await sleep(200);
  await native.press('enter');
  await sleep(300);

  return `Message sent to ${receiver} via Messenger.`;
}

const PLATFORM_MAP = [
  [['whatsapp', 'wp', 'wapp'], sendWhatsapp],
  [['telegram', 'tg'], sendTelegram],
  [['instagram', 'ig', 'insta'], sendInstagram],
  [['signal'], sendSignal],
  [['discord'], sendDiscord],
  [['messenger', 'facebook', 'fb'], sendMessenger],
];

// Python str.title(): capitalise each alphabetic run.
const pyTitle = (s) => s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

function resolvePlatform(platformStr) {
  const key = platformStr.toLowerCase().trim();
  // Whole-word pass first: Mark's substring-only test sent "signal" to
  // Instagram, because "ig" is inside "signal" and Instagram is listed first.
  const words = key.split(/[^a-z0-9]+/).filter(Boolean);
  for (const [keywords, handler] of PLATFORM_MAP) {
    if (keywords.some((k) => words.includes(k))) return handler;
  }
  for (const [keywords, handler] of PLATFORM_MAP) {
    if (keywords.some((k) => key.includes(k))) return handler;
  }
  return (r, m) => desktopSend(pyTitle(platformStr.trim()), r, m);
}

let lastSend = null;

async function sendMessage(parameters, ctx) {
  const params = parameters || {};
  const receiver = String(params.receiver || '').trim();
  const messageText = String(params.message_text || '').trim();
  const platform = String(params.platform || 'whatsapp').trim();

  if (!receiver) return 'Please specify a recipient.';
  if (!messageText) return 'Please specify the message content.';

  currentOs = String(ctx?.os || ({ win32: 'windows', darwin: 'mac' }[process.platform] || 'linux')).toLowerCase();

  // The same message to the same person twice within a minute is the model
  // retrying, not the user asking again. Refusing it is what breaks a loop of
  // apps and browser tabs opening over and over.
  const sig = `${platform.toLowerCase()}|${receiver.toLowerCase()}|${messageText}`;
  if (lastSend && lastSend.sig === sig && Date.now() - lastSend.at < 60_000) {
    return (
      `Already sent this exact message to ${receiver} a moment ago — not sending it again. ` +
      'Tell the user it was sent; do not call this tool again for it.'
    );
  }
  lastSend = { sig, at: Date.now() };

  const preview = messageText.slice(0, 50) + (messageText.length > 50 ? '…' : '');
  console.log(`[SendMessage] 📨 ${platform} → ${receiver}: ${preview}`);
  ctx?.ui?.log?.(`[msg] ${platform} → ${receiver}`);

  let result;
  try {
    result = await resolvePlatform(platform)(receiver, messageText);
  } catch (e) {
    result = `Could not send message: ${e.message || e}`;
  }

  console.log(`[SendMessage] ${result.toLowerCase().includes('sent') ? '✅' : '❌'} ${result}`);
  ctx?.ui?.log?.(`[msg] ${result}`);
  return result;
}

module.exports = {
  TOOL: {
    name: 'send_message',
    description:
      'Sends a text message via WhatsApp, Telegram, or other messaging platform. ' +
      'For WhatsApp it uses the installed WhatsApp app, or WhatsApp Web in the default browser ' +
      "when the app is not installed — so for 'send X a message on WhatsApp Web' call THIS tool " +
      'once with platform WhatsApp; do not open the browser or use browser_control for it. ' +
      'Call it exactly once per message.',
    parameters: {
      type: 'OBJECT',
      properties: {
        receiver: { type: 'STRING', description: 'Recipient contact name' },
        message_text: { type: 'STRING', description: 'The message to send' },
        platform: { type: 'STRING', description: 'Platform: WhatsApp, Telegram, etc.' },
      },
      required: ['receiver', 'message_text', 'platform'],
    },
  },
  run: sendMessage,
  resolvePlatform,
};
