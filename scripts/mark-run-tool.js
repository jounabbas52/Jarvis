// Run one Mark LIV tool in the real Electron main process, without a window.
//
//   npx electron scripts/mark-run-tool.js <tool_name> '<json args>'
//   npx electron scripts/mark-run-tool.js --list
//
// Uses the same userData directory as the app, so it sees the real config
// (API key) and memory. Events the tool would send to the HUD are printed.

const path = require('path');
const { app } = require('electron');

app.setPath('userData', path.join(app.getPath('appData'), 'jarvis-lite'));
// Headless: no window is ever shown, and some shells cannot start a GPU process.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const bus = require('../electron/mark/bus');
  bus.bind(() => ({
    isDestroyed: () => false,
    webContents: { send: (_ch, ev) => console.log('[event]', JSON.stringify(ev).slice(0, 400)) },
  }));
  const confirm = require('../electron/mark/confirm');
  confirm.bind({
    show: (t, d) => console.log('[confirm-show]', t, d),
    hide: () => console.log('[confirm-hide]'),
    log: (m) => console.log('[log]', m),
  });
  const mark = require('../electron/mark');
  // Registry is built inside registerMarkHandlers; build it without IPC.
  mark.registerMarkHandlers({ getWindow: () => null, showWindow: () => {}, quit: () => {} });
  bus.bind(() => ({
    isDestroyed: () => false,
    webContents: { send: (_ch, ev) => console.log('[event]', JSON.stringify(ev).slice(0, 400)) },
  }));

  const self = process.argv.findIndex((a) => a.endsWith('mark-run-tool.js'));
  const [name, json] = process.argv.slice(self + 1);
  try {
    if (!name || name === '--list') {
      const s = require('../electron/mark').INLINE_TOOLS.map((t) => t.name);
      console.log('inline:', s.join(', '));
      const { Registry } = require('../electron/mark/registry');
      const r = new Registry({
        actionDirs: [path.join(__dirname, '..', 'electron', 'mark', 'actions')],
        pluginDirs: [path.join(__dirname, '..', 'electron', 'mark', 'plugins')],
        reserved: new Set(s),
        logger: console.log,
      });
      console.log('registered:', r.declarations().map((d) => d.name).join(', '));
    } else {
      const args = json ? JSON.parse(json) : {};
      const t0 = Date.now();
      const out = await mark.runTool(name, args, {});
      console.log(`\n=== ${name} (${Date.now() - t0} ms) ===`);
      console.log(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2));
      if (out.scheduling) console.log('scheduling:', out.scheduling);
    }
  } catch (e) {
    console.error(e);
  }
  // Give deferred work (confirm runs, detached launches) a moment.
  setTimeout(() => app.exit(0), 1500);
});
