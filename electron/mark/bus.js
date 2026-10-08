// Main → renderer events for the Mark LIV HUD.
//
// Everything the main process needs the interface to do goes down ONE channel,
// `mark:event`, as `{ type, ...payload }`. The renderer subscribes once
// (window.jarvis.mark.onEvent) and dispatches on `type` in lib/mark/store.ts.
//
// Event types (keep lib/mark/types.ts `MarkEvent` in step with this list):
//   log            { text }                     activity-log line ("SYS: …", "ERR: …", "JARVIS: …")
//   content        { title, text }              the content panel under the HUD
//   confirm-show   { title, detail }            irreversible-action banner
//   confirm-hide   {}
//   say            { text }                     inject a user-role turn into the Live session
//   camera         { on: boolean }              open / close the live camera preview
//   quiz           { topic, questions }         quiz panel (plugins)
//   quiz-hide      {}
//   review         { title, summary, findings, unclear }   document review panel (plugins)
//   glance         { dx, dy, hold }             the face looks at something
//   ptt            { held: boolean }            global push-to-talk chord
//   clipboard      { text }                     clipboard intelligence panel
//   phone          { connected: boolean }       remote dashboard phone paired
//   remote-command { text }                     a typed command from the phone
//   remote-audio   { data }                     base64 16 kHz PCM from the phone mic
//   remote-wake    {}                           the phone's WAKE button
//   shutdown       {}                         shutdown_jarvis was confirmed by the model

let getWindow = () => null;

function bind(fn) {
  getWindow = fn;
}

function emit(type, payload = {}) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('mark:event', { type, ...payload });
}

module.exports = { bind, emit };
