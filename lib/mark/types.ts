// Shared types for the Mark LIV port. The main-process side of each shape is
// in electron/mark/*.js; keep the two in step.

export type HudState = 'LISTENING' | 'SPEAKING' | 'THINKING' | 'SLEEPING';
export type HudStyle = 'face' | 'core';
export type MediaResolution = 'default' | 'low' | 'medium' | 'high';

export interface TurnTuning {
  enabled: boolean;
  silence_ms: number;
  prefix_ms: number;
  end_sensitivity: string;
  start_sensitivity: string;
}

/** electron/mark/config.js → snapshot() */
export interface MarkConfig {
  configured: boolean;
  os: 'windows' | 'mac' | 'linux';
  assistant_name: string;
  user_name: string;
  voice_name: string;
  voices: string[];
  ui_color: string;
  hud_style: HudStyle;
  wake_word_enabled: boolean;
  push_to_talk_enabled: boolean;
  morning_brief_enabled: boolean;
  proactive_audio: boolean;
  thinking_enabled: boolean;
  media_resolution: MediaResolution;
  turn_tuning: TurnTuning;
  input_device: string;
  output_device: string;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  behavior?: 'BLOCKING' | 'NON_BLOCKING';
}

/** electron/mark/index.js → sessionSetup() */
export interface SessionSetup {
  apiKey: string;
  model: string;
  assistantName: string;
  systemInstruction: string;
  tools: FunctionDeclaration[];
  voice: string;
  proactiveAudio: boolean;
  thinking: boolean;
  mediaResolution: MediaResolution;
  turnTuning: TurnTuning;
}

export interface ToolRunResult {
  result: unknown;
  scheduling: 'WHEN_IDLE' | 'SILENT' | 'INTERRUPT' | null;
}

export interface MemoryRow {
  category: string;
  key: string;
  value: string;
  updated: string;
}

export interface PluginInfo {
  name: string;
  description: string;
  file: string;
  valid: boolean;
  error: string;
  enabled: boolean;
}

export interface PluginSettingsField {
  key: string;
  label?: string;
  type?: 'text' | 'password' | 'number' | 'bool' | 'select' | string;
  default?: unknown;
  placeholder?: string;
  options?: string[];
  help?: string;
}

export interface PluginSettingsSection {
  plugin: string;
  namespace: string;
  title: string;
  fields: PluginSettingsField[];
  values: Record<string, unknown>;
  action: { label: string } | null;
}

export interface QuizQuestion {
  question: string;
  options?: string[];
  answer?: string;
  explanation?: string;
  [k: string]: unknown;
}

export interface ReviewFinding {
  title?: string;
  detail?: string;
  severity?: string;
  quote?: string;
  [k: string]: unknown;
}

export interface Metrics {
  cpu: number;
  ram: number;
  gpu: number;
  temp: number;
  [k: string]: unknown;
}

export interface RemoteKeyInfo {
  url: string;
  key: string;
  autoLoginUrl: string;
  manualUrl: string;
}

/** Everything electron/mark/bus.js can emit. */
export type MarkEvent =
  | { type: 'log'; text: string }
  | { type: 'content'; title: string; text: string }
  | { type: 'confirm-show'; title: string; detail: string }
  | { type: 'confirm-hide' }
  | { type: 'say'; text: string }
  | { type: 'camera'; on: boolean }
  | { type: 'quiz'; topic: string; questions: QuizQuestion[] }
  | { type: 'quiz-hide' }
  | { type: 'review'; title: string; summary: string; findings: ReviewFinding[]; unclear?: string[] }
  | { type: 'glance'; dx: number; dy: number; hold?: number }
  | { type: 'ptt'; held: boolean }
  | { type: 'clipboard'; text: string }
  | { type: 'phone'; connected: boolean }
  | { type: 'remote-command'; text: string }
  | { type: 'remote-audio'; data: string }
  | { type: 'remote-wake' }
  | { type: 'shutdown' };

/** window.jarvis.mark — see electron/preload.js. */
export interface MarkBridge {
  configGet(): Promise<MarkConfig>;
  configSet(fields: Partial<MarkConfig>): Promise<MarkConfig>;
  saveApiKey(key: string): Promise<boolean>;
  sessionSetup(): Promise<SessionSetup>;
  runTool(name: string, args: Record<string, unknown>, extra?: { currentFile?: string | null }): Promise<ToolRunResult>;
  captureScreen(): Promise<{ data: string; mimeType: string; bytes: number }>;

  memoryList(): Promise<MemoryRow[]>;
  memoryForget(category: string, key: string): Promise<string>;
  memoryIdentity(): Promise<{ language: string; name: string }>;
  popLastSession(): Promise<{ date: string; summary: string; language?: string } | null>;
  saveSessionSummary(lines: string[]): Promise<boolean>;

  undoHistory(): Promise<string[]>;
  confirmResolve(accepted: boolean): Promise<void>;

  pluginsList(): Promise<PluginInfo[]>;
  pluginToggle(name: string, enabled: boolean): Promise<PluginInfo[]>;
  pluginSettings(): Promise<PluginSettingsSection[]>;
  pluginSettingsSave(ns: string, values: Record<string, unknown>): Promise<void>;
  pluginSettingsAction(ns: string, values: Record<string, unknown>): Promise<[boolean, string]>;
  openPluginsFolder(): Promise<string>;

  news(query?: string): Promise<string>;
  metrics(): Promise<Metrics | null>;
  sysmonCheck(): Promise<string | null>;
  bgCheck(): Promise<string[]>;
  proactive(payload: { lastUserSpeechAt: number; recentTurns: string[] }): Promise<string | null>;

  clipboardWatch(on: boolean): Promise<void>;
  clipboardWrite(text: string): Promise<void>;
  autostartGet(): Promise<boolean>;
  autostartSet(enabled: boolean): Promise<boolean>;
  desktopShortcut(): Promise<{ ok: boolean; message: string }>;
  setCurrentFile(file: string | null): Promise<string | null>;
  shutdown(): Promise<boolean>;

  pttStart(): Promise<'global' | 'window' | 'off'>;
  pttStop(): Promise<void>;

  remoteKey(): Promise<RemoteKeyInfo | null>;
  remoteNewKey(): Promise<RemoteKeyInfo | null>;
  remoteBroadcast(msg: Record<string, unknown>): Promise<void>;

  onEvent(handler: (e: MarkEvent) => void): () => void;
}

export function markBridge(): MarkBridge | null {
  if (typeof window === 'undefined') return null;
  const j = (window as unknown as { jarvis?: { mark?: MarkBridge } }).jarvis;
  return j?.mark ?? null;
}
