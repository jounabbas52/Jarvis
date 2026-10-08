// A confirmation the model cannot forge — the Node port of core/confirm.py.
//
// The token is issued by the interface: an action parks its irreversible work
// here, the HUD shows a CONFIRM / CANCEL banner, and the work runs only when a
// human presses CONFIRM (`mark:confirm-resolve` from the renderer). Nothing
// blocks — the tool returns at once with a sentence for the model to say.

const TIMEOUT_MS = 90_000;

let pending = null;
let showCb = null;
let hideCb = null;
let logCb = null;

function bind({ show, hide, log }) {
  showCb = show;
  hideCb = hide;
  logCb = log || null;
}

function log(msg) {
  try {
    logCb?.(msg);
  } catch {
    /* best effort */
  }
}

/** Park an irreversible action behind the on-screen gate. */
function request(key, title, detail, run) {
  if (!showCb) {
    return `I cannot confirm '${title}' right now because the interface is not available, so I have not done it.`;
  }
  pending = { key, title, detail, run, at: Date.now() };
  try {
    showCb(title, detail);
  } catch (e) {
    pending = null;
    return `Could not ask for confirmation: ${e?.message || e}. Nothing was done.`;
  }
  log(`SYS: Awaiting confirmation — ${title}`);
  return (
    `[CONFIRMATION_PENDING] I have put a confirmation on screen for: ${title}. ` +
    "Say ONE short sentence in the user's own language telling them you need " +
    'them to confirm it on the HUD before you do it. Do not claim it is done.'
  );
}

/** Called when the user presses CONFIRM or CANCEL. */
function resolve(accepted) {
  const p = pending;
  pending = null;
  try {
    hideCb?.();
  } catch {
    /* ignore */
  }
  if (!p) return;
  if (Date.now() - p.at > TIMEOUT_MS) {
    log(`SYS: Confirmation expired — ${p.title}`);
    return;
  }
  if (!accepted) {
    log(`SYS: Cancelled — ${p.title}`);
    return;
  }
  // Deferred so the IPC reply goes out before, say, the machine shuts down.
  setImmediate(async () => {
    try {
      const result = (await p.run()) || 'Done.';
      log(`SYS: Confirmed — ${p.title}. ${result}`);
    } catch (e) {
      log(`ERR: ${p.title} failed — ${e?.message || e}`);
    }
  });
}

/** '' when nothing is waiting. Lets an action avoid stacking two banners. */
function pendingTitle() {
  if (!pending || Date.now() - pending.at > TIMEOUT_MS) return '';
  return pending.title;
}

module.exports = { TIMEOUT_MS, bind, request, resolve, pendingTitle };
