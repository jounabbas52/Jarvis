# Porting Mark LIV into jarvis-lite

Source (read-only reference): `D:\projects\mark liv\Mark-LIV-main\` (Python + PyQt6 + Gemini Live).
Target: `D:\projects\jarvis-lite\` (Next.js 14 static export + Electron 31). Goal: **identical functionality to Mark LIV**.

## Architecture

- **Renderer** (`lib/mark/*`, `app/components/mark/*`) owns the Gemini Live session (`@google/genai` browser build), mic/speaker audio (Web Audio), the HUD, avatar and all panels.
- **Main process** (`electron/mark/*`) owns config + API key, memory, undo, confirmation gate, one-shot Gemini calls, and every tool that touches the machine.
- IPC: renderer → main through `window.jarvis.mark.*` (see `electron/preload.js`, typed in `lib/mark/types.ts` `MarkBridge`). Main → renderer through one channel, `mark:event` `{type, ...}` (see `electron/mark/bus.js`, `MarkEvent`).

## Already written (the contract — do not change public APIs; tell the lead if you need something)

| File | What |
|---|---|
| `electron/mark/config.js` | config store (port of config_manager.py). `get/patch/snapshot`, typed getters, plugin config. |
| `electron/mark/memory.js` | long_term.json port: `loadMemory, updateMemory, formatMemoryForPrompt, searchMemory, allEntriesForUi, forget, identityValue, saveSessionSummary, popLastSession`. |
| `electron/mark/undo.js` | `push(label, fn)`, `undoLast()`, `history()`. fn may be async and return a detail string. |
| `electron/mark/confirm.js` | `request(key, title, detail, run)` → returns the `[CONFIRMATION_PENDING]` sentence; `run` executes only after the user presses CONFIRM. |
| `electron/mark/gemini.js` | port of core/gemini.py: `text(contents, {tier, config, timeoutMs})`, `asJson(...)`, `call(...)` → `{text, response}`, `search(prompt)` → `{text, sources}` (grounded). Tiers `FAST`, `SMART`, `SEARCH`. Contents in JS SDK shape: string or `[{text}, {inlineData:{mimeType, data: base64}}]`. |
| `electron/mark/registry.js` | action/plugin discovery. |
| `electron/mark/bus.js` | `emit(type, payload)` to the renderer. |
| `electron/mark/util/ps.js` | `runPS(script, {timeout})`, `run(file, args, opts)`, `launchDetached`, `psQuote`. All resolve `{ok, stdout, stderr, code}`; never reject; never use a shell string. |
| `electron/mark/index.js` | IPC, inline tools, system prompt, `ctx` construction. |
| `lib/mark/types.ts`, `lib/mark/hud.ts`, `lib/mark/store.ts` | renderer types, 50 Hz HUD signal hub, zustand store + actions. |

## Action module format (`electron/mark/actions/<file>.js`, CommonJS)

```js
module.exports = {
  TOOL: {
    name: 'open_app',                 // same name as Mark's TOOL dict
    description: '...',               // copy Mark's description VERBATIM
    parameters: { type: 'OBJECT', properties: {...}, required: [...] },  // copy verbatim
    // behavior / scheduling: copy if Mark's TOOL has them
  },
  run: async (parameters, ctx) => 'short English result string',
  // plus any extra named exports other code needs
};
```

`ctx` (built in `electron/mark/index.js` `makeCtx()`):
`{ gemini, undo:{push}, confirm:{request, pendingTitle}, config, memory, bus, os ('windows'|'mac'|'linux'), paths:{markDir,userData,home,desktop,documents,downloads,temp}, currentFile, ui:{log(text), showContent(title,text), showQuiz, hideQuiz, showReview, glance}, speak(text) }`

Mapping from Mark's Python: `player.write_log(x)` → `ctx.ui.log(x)`; `player.show_content(t, x)` → `ctx.ui.showContent(t, x)`; `speak(x)` → `ctx.speak(x)`; `from core.undo import push_undo` → `ctx.undo.push`; `core.confirm.request` → `ctx.confirm.request`; `from core import gemini; gemini.text(prompt, gemini.SMART, cfg, timeout)` → `await ctx.gemini.text(prompt, {tier: ctx.gemini.SMART, config: cfg, timeoutMs})`.

Files starting with `_` in actions/ are helpers and never loaded as tools. Keep top-level `require`s of heavy packages lazy (inside functions) so one missing package costs one feature.

## Rules for everyone

1. Port **behaviour**, not just names: read the Python file fully and reproduce every action/branch, the fuzzy matching, the undo registrations, the confirmation gates, error strings and OS branches (Windows first-class; keep mac/linux branches where Mark has them).
2. Only create/edit files you were assigned. Do **not** edit `package.json`, `electron/main.js`, `electron/preload.js`, `electron/mark/index.js`, `lib/mark/store.ts`, `lib/mark/types.ts`, or another agent's files. If you need a change there, say exactly what in your final report.
3. Do **not** run `npm install`. Installed and available: `@google/genai ws selfsigned qrcode playwright-core systeminformation mammoth xlsx jszip pdf-parse@1.1.1 zustand onnxruntime-web (via @huggingface/transformers)`. If you truly need another package, list it in the report and degrade gracefully without it.
4. No git commits.
5. Smoke-test main-process tools headlessly (bash): `cd /d/projects/jarvis-lite && (unset ELECTRON_RUN_AS_NODE; npx electron scripts/mark-run-tool.js <tool> '<json>')`. Don't run anything destructive or disruptive to the user's machine (no shutdown, no wifi toggle, no mass file moves, don't close their windows); prefer read-only/list actions and temp dirs.
6. Renderer code: `npx tsc --noEmit -p .` must pass for your files. Style: match jarvis-lite (TypeScript, 2-space, single quotes, comments explain *why*, like the existing code).
7. Final report: files created, what was ported, anything not ported and why, required changes to shared files, test results.
