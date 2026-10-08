// Mark LIV config — the Node port of memory/config_manager.py.
//
// Everything lives in one JSON file under userData, the equivalent of Mark's
// config/api_keys.json: the Gemini key, names, voice, colour and every toggle.
// Every setter is a read-modify-write of the keys it owns, so one setting can
// never clobber another and a corrupt file degrades to defaults instead of a
// crash.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MARK_DIR = path.join(app.getPath('userData'), 'mark');
const CONFIG_FILE = path.join(MARK_DIR, 'config.json');

const AVAILABLE_VOICES = ['Charon', 'Puck', 'Kore', 'Fenrir', 'Aoede'];
const DEFAULT_VOICE = 'Charon';
const HUD_STYLES = ['face', 'core'];
const MEDIA_RESOLUTIONS = ['default', 'low', 'medium', 'high'];
const DEFAULT_UI_COLOR = '#00d4ff';

function osName() {
  return { win32: 'windows', darwin: 'mac' }[process.platform] || 'linux';
}

function ensureDir() {
  fs.mkdirSync(MARK_DIR, { recursive: true });
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function patch(fields) {
  ensureDir();
  const data = { ...load(), ...(fields || {}) };
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 4));
  fs.renameSync(tmp, CONFIG_FILE);
  return data;
}

function get(key, fallback) {
  const v = load()[key];
  return v === undefined ? fallback : v;
}

// ── API key ──────────────────────────────────────────────────────────────────
const getGeminiKey = () => String(get('gemini_api_key', '') || '').trim();
const isConfigured = () => getGeminiKey().length > 15;
const saveApiKey = (key) => patch({ gemini_api_key: String(key || '').trim() });

// ── Identity ─────────────────────────────────────────────────────────────────
const getAssistantName = () => String(get('assistant_name', 'JARVIS') || 'JARVIS').trim() || 'JARVIS';
const getUserName = () => String(get('user_name', '') || '').trim();

function getVoice() {
  const v = get('voice_name', DEFAULT_VOICE) || DEFAULT_VOICE;
  return AVAILABLE_VOICES.includes(v) ? v : DEFAULT_VOICE;
}

function getUiColor() {
  const c = String(get('ui_color', DEFAULT_UI_COLOR) || '');
  return /^#[0-9a-f]{6}$/i.test(c) ? c : DEFAULT_UI_COLOR;
}

function getHudStyle() {
  const v = String(get('hud_style', 'face')).trim().toLowerCase();
  return HUD_STYLES.includes(v) ? v : 'face';
}

// ── Live-session tuning (see config_manager.get_turn_tuning) ────────────────
function getTurnTuning() {
  const cfg = get('turn_tuning', {});
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const int = (key, dflt, lo, hi) => {
    const n = parseInt(c[key] ?? dflt, 10);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  return {
    enabled: Boolean(c.enabled ?? false),
    silence_ms: int('silence_ms', 550, 200, 3000),
    prefix_ms: int('prefix_ms', 150, 0, 1000),
    end_sensitivity: String(c.end_sensitivity ?? 'high').toLowerCase(),
    start_sensitivity: String(c.start_sensitivity ?? 'default').toLowerCase(),
  };
}

function getMediaResolution() {
  const v = String(get('media_resolution', 'medium')).trim().toLowerCase();
  return MEDIA_RESOLUTIONS.includes(v) ? v : 'medium';
}

// ── Plugins ──────────────────────────────────────────────────────────────────
function getPluginEnabled(name) {
  const p = get('plugins_enabled', {});
  return p && typeof p === 'object' && name in p ? Boolean(p[name]) : true;
}

function savePluginEnabled(name, enabled) {
  const p = { ...(get('plugins_enabled', {}) || {}) };
  p[name] = Boolean(enabled);
  patch({ plugins_enabled: p });
}

function getPluginConfig(namespace) {
  const pc = get('plugin_config', {});
  const v = pc && typeof pc === 'object' ? pc[namespace] : null;
  return v && typeof v === 'object' ? { ...v } : {};
}

function getPluginSetting(namespace, key, fallback) {
  const v = getPluginConfig(namespace)[key];
  return v === undefined ? fallback : v;
}

function savePluginConfig(namespace, values) {
  const pc = { ...(get('plugin_config', {}) || {}) };
  pc[namespace] = { ...(pc[namespace] || {}), ...(values || {}) };
  patch({ plugin_config: pc });
}

/**
 * The settings the renderer needs, in one object. Deliberately excludes the
 * API key's value — the renderer is told whether one exists, and fetches the
 * key itself only through `mark:api-key` when it opens a session.
 */
function snapshot() {
  return {
    configured: isConfigured(),
    os: String(get('os_system', osName())).toLowerCase(),
    assistant_name: getAssistantName(),
    user_name: getUserName(),
    voice_name: getVoice(),
    voices: AVAILABLE_VOICES,
    ui_color: getUiColor(),
    hud_style: getHudStyle(),
    wake_word_enabled: Boolean(get('wake_word_enabled', false)),
    push_to_talk_enabled: Boolean(get('push_to_talk_enabled', false)),
    morning_brief_enabled: Boolean(get('morning_brief_enabled', true)),
    proactive_audio: Boolean(get('proactive_audio', true)),
    thinking_enabled: Boolean(get('thinking_enabled', false)),
    media_resolution: getMediaResolution(),
    turn_tuning: getTurnTuning(),
    input_device: String(get('input_device', '') || '').trim(),
    output_device: String(get('output_device', '') || '').trim(),
  };
}

// Keys the renderer may write through `mark:config-set`. The API key has its
// own channel, and plugin state has its own, so a bug in a settings panel
// cannot overwrite either.
const RENDERER_WRITABLE = new Set([
  'assistant_name', 'user_name', 'voice_name', 'ui_color', 'hud_style', 'os_system',
  'wake_word_enabled', 'push_to_talk_enabled', 'morning_brief_enabled',
  'proactive_audio', 'thinking_enabled', 'media_resolution', 'turn_tuning',
  'input_device', 'output_device',
]);

function setFromRenderer(fields) {
  const clean = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (!RENDERER_WRITABLE.has(k)) continue;
    if (k === 'voice_name') clean[k] = AVAILABLE_VOICES.includes(v) ? v : DEFAULT_VOICE;
    else if (k === 'hud_style') clean[k] = HUD_STYLES.includes(v) ? v : 'face';
    else if (k === 'media_resolution') clean[k] = MEDIA_RESOLUTIONS.includes(v) ? v : 'medium';
    else if (k === 'assistant_name') clean[k] = String(v || '').trim() || 'JARVIS';
    else if (k === 'ui_color') clean[k] = /^#[0-9a-f]{6}$/i.test(String(v)) ? v : DEFAULT_UI_COLOR;
    else clean[k] = v;
  }
  patch(clean);
  return snapshot();
}

module.exports = {
  MARK_DIR,
  CONFIG_FILE,
  AVAILABLE_VOICES,
  DEFAULT_VOICE,
  DEFAULT_UI_COLOR,
  osName,
  load,
  get,
  patch,
  getGeminiKey,
  isConfigured,
  saveApiKey,
  getAssistantName,
  getUserName,
  getVoice,
  getUiColor,
  getHudStyle,
  getTurnTuning,
  getMediaResolution,
  getPluginEnabled,
  savePluginEnabled,
  getPluginConfig,
  getPluginSetting,
  savePluginConfig,
  snapshot,
  setFromRenderer,
};
