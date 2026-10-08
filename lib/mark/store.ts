// Mark LIV interface state.
//
// React-visible state only: the activity log, panels, banners, settings. The
// 50 Hz audio signals live in ./hud.ts. The Live session itself lives in
// ./live.ts, which registers itself here as the controller; UI components call
// the actions below and never touch the session directly.

import { create } from 'zustand';
import { hud } from './hud';
import type {
  HudState,
  MarkConfig,
  MarkEvent,
  QuizQuestion,
  ReviewFinding,
  RemoteKeyInfo,
} from './types';
import { markBridge } from './types';

export interface LogLine {
  id: number;
  text: string;
  ts: number;
}

/** What the Live controller (live.ts) provides to the interface. */
export interface MarkController {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(text: string): void;
  interrupt(): void;
  setMuted(muted: boolean): void;
  /** Rebuild the session. keepContext=false starts a fresh conversation. */
  reconnect(keepContext: boolean, reason: string): void;
  wakeToggle(enable: boolean): Promise<'enabled' | 'disabled' | 'need_download'>;
  wakeManual(): void;
  wakeInstall(onProgress?: (msg: string) => void): Promise<[boolean, string]>;
  setPushToTalk(enabled: boolean): Promise<'global' | 'window' | 'off'>;
  pttHold(held: boolean): void;
  closeCamera(): void;
}

let controller: MarkController | null = null;
export function setMarkController(c: MarkController): void {
  controller = c;
}
export function markController(): MarkController | null {
  return controller;
}

interface MarkState {
  ready: boolean;
  config: MarkConfig | null;
  state: HudState;
  muted: boolean;
  connected: boolean;
  logs: LogLine[];

  content: { title: string; text: string; at: number } | null;
  confirm: { title: string; detail: string } | null;
  cameraOn: boolean;
  quiz: { topic: string; questions: QuizQuestion[] } | null;
  review: { title: string; summary: string; findings: ReviewFinding[]; unclear: string[] } | null;
  clipboard: string | null;
  phoneConnected: boolean;
  remote: RemoteKeyInfo | null;
  currentFile: string | null;
  wake: { enabled: boolean; awake: boolean; ready: boolean };
  ptt: { enabled: boolean; held: boolean; scope: 'global' | 'window' | 'off' };
  autostart: boolean;
  /** Which overlay is open, if any. */
  overlay: null | 'setup' | 'customize' | 'plugins' | 'plugin-settings' | 'audio' | 'memory' | 'remote';

  init(): Promise<void>;
  refreshConfig(): Promise<MarkConfig | null>;
  saveConfig(fields: Partial<MarkConfig>): Promise<MarkConfig | null>;
  saveApiKey(key: string, os?: MarkConfig['os']): Promise<boolean>;

  writeLog(text: string): void;
  setHudState(s: HudState): void;
  setConnected(c: boolean): void;
  showContent(title: string, text: string): void;
  hideContent(): void;

  sendText(text: string): void;
  interrupt(): void;
  toggleMute(): void;
  answerConfirm(accepted: boolean): void;
  setCameraOn(on: boolean): void;
  closeCamera(): void;
  hideQuiz(): void;
  hideReview(): void;
  dismissClipboard(): void;
  setCurrentFile(file: string | null): void;
  setOverlay(o: MarkState['overlay']): void;

  /** Voice is fixed at connect time: a new voice means a fresh session. */
  setVoice(voice: string): Promise<void>;
  /** New mic/speaker: rebuild the session, keep the conversation. */
  setAudioDevices(input: string, output: string): Promise<void>;
  setHudStyle(style: MarkConfig['hud_style']): Promise<void>;
  toggleBrief(): Promise<void>;
  toggleAutostart(): Promise<void>;
  togglePushToTalk(): Promise<void>;
  toggleWakeWord(): Promise<'enabled' | 'disabled' | 'need_download'>;
  wakeManual(): void;
  installWakeWord(onProgress?: (msg: string) => void): Promise<[boolean, string]>;
  setWakeState(w: Partial<MarkState['wake']>): void;
  setPtt(p: Partial<MarkState['ptt']>): void;
  /** Window-scoped Ctrl+Space, for when the global chord is unavailable. */
  pttHold(held: boolean): void;
  openRemote(): Promise<void>;
  newRemoteKey(): Promise<void>;
}

const MAX_LOG = 400;
let logSeq = 0;

export const useMarkStore = create<MarkState>((set, get) => ({
  ready: false,
  config: null,
  state: 'SLEEPING',
  muted: false,
  connected: false,
  logs: [],
  content: null,
  confirm: null,
  cameraOn: false,
  quiz: null,
  review: null,
  clipboard: null,
  phoneConnected: false,
  remote: null,
  currentFile: null,
  wake: { enabled: false, awake: true, ready: false },
  ptt: { enabled: false, held: false, scope: 'off' },
  autostart: false,
  overlay: null,

  async init() {
    if (get().ready) return;
    const bridge = markBridge();
    if (!bridge) {
      set({ ready: true });
      return;
    }
    bridge.onEvent((e) => handleEvent(e));
    const config = await bridge.configGet();
    const autostart = await bridge.autostartGet().catch(() => false);
    set({
      ready: true,
      config,
      autostart,
      overlay: config.configured ? null : 'setup',
      wake: { ...get().wake, enabled: config.wake_word_enabled, awake: !config.wake_word_enabled },
      ptt: { ...get().ptt, enabled: config.push_to_talk_enabled },
    });
    applyAccent(config.ui_color);
    bridge.clipboardWatch(true).catch(() => {});
  },

  async refreshConfig() {
    const bridge = markBridge();
    if (!bridge) return null;
    const config = await bridge.configGet();
    set({ config });
    applyAccent(config.ui_color);
    return config;
  },

  async saveConfig(fields) {
    const bridge = markBridge();
    if (!bridge) return null;
    const config = await bridge.configSet(fields);
    set({ config });
    applyAccent(config.ui_color);
    return config;
  },

  async saveApiKey(key, os) {
    const bridge = markBridge();
    if (!bridge) return false;
    const ok = await bridge.saveApiKey(key);
    if (os) await bridge.configSet({ os });
    const config = await bridge.configGet();
    set({ config, overlay: ok ? null : 'setup' });
    if (ok) controller?.start();
    return ok;
  },

  writeLog(text) {
    const line = { id: ++logSeq, text: String(text), ts: Date.now() };
    set((s) => ({ logs: [...s.logs, line].slice(-MAX_LOG) }));
  },

  setHudState(state) {
    hud.setState(state);
    set({ state });
  },

  setConnected(connected) {
    set({ connected });
  },

  showContent(title, text) {
    set({ content: { title, text, at: Date.now() } });
    hud.contentShown();
  },

  hideContent() {
    set({ content: null });
  },

  sendText(text) {
    const t = text.trim();
    if (!t) return;
    controller?.sendText(t);
  },

  interrupt() {
    controller?.interrupt();
  },

  toggleMute() {
    const muted = !get().muted;
    set({ muted });
    controller?.setMuted(muted);
  },

  answerConfirm(accepted) {
    set({ confirm: null });
    markBridge()?.confirmResolve(accepted);
  },

  setCameraOn(cameraOn) {
    set({ cameraOn });
  },

  closeCamera() {
    controller?.closeCamera();
    set({ cameraOn: false });
  },

  hideQuiz() {
    set({ quiz: null });
  },

  hideReview() {
    set({ review: null });
  },

  dismissClipboard() {
    set({ clipboard: null });
  },

  setCurrentFile(file) {
    set({ currentFile: file });
    markBridge()?.setCurrentFile(file);
  },

  setOverlay(overlay) {
    set({ overlay });
  },

  async setVoice(voice) {
    const prev = get().config?.voice_name;
    await get().saveConfig({ voice_name: voice });
    if (prev !== voice) controller?.reconnect(false, 'new voice');
  },

  async setAudioDevices(input, output) {
    await get().saveConfig({ input_device: input, output_device: output });
    controller?.reconnect(true, 'audio device');
  },

  async setHudStyle(hud_style) {
    await get().saveConfig({ hud_style });
  },

  async toggleBrief() {
    const cfg = get().config;
    if (cfg) await get().saveConfig({ morning_brief_enabled: !cfg.morning_brief_enabled });
  },

  async toggleAutostart() {
    const bridge = markBridge();
    if (!bridge) return;
    const autostart = await bridge.autostartSet(!get().autostart);
    set({ autostart });
  },

  async togglePushToTalk() {
    const enabled = !get().ptt.enabled;
    await get().saveConfig({ push_to_talk_enabled: enabled });
    const scope = controller ? await controller.setPushToTalk(enabled) : 'off';
    set({ ptt: { enabled, held: false, scope } });
  },

  async toggleWakeWord() {
    const enable = !get().wake.enabled;
    const res = controller ? await controller.wakeToggle(enable) : 'disabled';
    if (res !== 'need_download') await get().refreshConfig();
    return res;
  },

  wakeManual() {
    controller?.wakeManual();
  },

  async installWakeWord(onProgress) {
    if (!controller) return [false, 'The assistant is not running.'];
    return controller.wakeInstall(onProgress);
  },

  setWakeState(w) {
    set((s) => ({ wake: { ...s.wake, ...w } }));
  },

  setPtt(p) {
    set((s) => ({ ptt: { ...s.ptt, ...p } }));
  },

  pttHold(held) {
    controller?.pttHold(held);
  },

  async openRemote() {
    const bridge = markBridge();
    if (!bridge) return;
    const remote = await bridge.remoteKey();
    if (!remote) {
      get().writeLog('SYS: Remote dashboard is unavailable.');
      return;
    }
    set({ remote, overlay: 'remote' });
  },

  async newRemoteKey() {
    const bridge = markBridge();
    if (!bridge) return;
    const remote = await bridge.remoteNewKey();
    if (remote) set({ remote });
  },
}));

/** Main-process events. Session-bound ones (say, remote-*) go to the controller. */
function handleEvent(e: MarkEvent): void {
  const s = useMarkStore.getState();
  switch (e.type) {
    case 'log':
      s.writeLog(e.text);
      break;
    case 'content':
      s.showContent(e.title, e.text);
      break;
    case 'confirm-show':
      useMarkStore.setState({ confirm: { title: e.title, detail: e.detail } });
      break;
    case 'confirm-hide':
      useMarkStore.setState({ confirm: null });
      break;
    case 'camera':
      useMarkStore.setState({ cameraOn: e.on });
      break;
    case 'quiz':
      useMarkStore.setState({ quiz: { topic: e.topic, questions: e.questions || [] } });
      break;
    case 'quiz-hide':
      useMarkStore.setState({ quiz: null });
      break;
    case 'review':
      useMarkStore.setState({
        review: { title: e.title, summary: e.summary, findings: e.findings || [], unclear: e.unclear || [] },
      });
      break;
    case 'glance':
      hud.glance(e.dx, e.dy, e.hold);
      break;
    case 'clipboard':
      useMarkStore.setState({ clipboard: e.text });
      break;
    case 'phone':
      useMarkStore.setState({ phoneConnected: e.connected });
      if (e.connected) s.writeLog('SYS: Phone connected via Remote Dashboard.');
      break;
    default:
      // say / ptt / remote-command / remote-audio / shutdown
      sessionEventSink?.(e);
  }
}

let sessionEventSink: ((e: MarkEvent) => void) | null = null;
/** live.ts subscribes here for the events that belong to the session. */
export function onSessionEvent(fn: (e: MarkEvent) => void): void {
  sessionEventSink = fn;
}

// ── Theming ──────────────────────────────────────────────────────────────────
// The whole HUD is tinted from one accent colour, like Mark's live theming.
// CSS reads --mark-accent (+ -rgb); the canvases read it via accentColor().
let accent = '#00d4ff';
export function accentColor(): string {
  return accent;
}

export function applyAccent(hex: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
  accent = hex;
  if (typeof document === 'undefined') return;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const root = document.documentElement.style;
  root.setProperty('--mark-accent', hex);
  root.setProperty('--mark-accent-rgb', `${r}, ${g}, ${b}`);
}
