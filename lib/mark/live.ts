// The Live session — the port of Mark LIV's JarvisLive (main.py).
//
// One Gemini Live connection at a time, rebuilt forever: a dropped socket, a
// new voice, a new microphone all come back through the same loop. The
// session-resumption handle the server issues is kept (in memory only, on
// purpose — see main.py) and replayed, so a reconnect continues the
// conversation instead of starting an empty one.
//
// This file owns the conversation; the main process owns every tool; the HUD
// reads 50 Hz signals from ./hud.ts and everything else from ./store.ts.

import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import { Player, MicCapture, SEND_RATE, RECEIVE_RATE, int16ToBase64, base64ToInt16 } from './audio';
import { camera } from './camera';
import { EchoGuard } from './echo';
import { hud } from './hud';
import { pcmLevel, pcmVisemes, VisemeStream, VIS_HOP } from './viseme';
import { markBridge, type HudState, type MarkBridge, type MarkEvent, type SessionSetup } from './types';
import { onSessionEvent, setMarkController, useMarkStore, type MarkController } from './store';

const WAKE_SLEEP_TIMEOUT_MS = 120_000;
const TAIL_MARGIN_MS = 250;
const REPEAT_MIN = 12;
const VISION_COOLDOWN_MS = 4_000;

// ── Wake word seam ───────────────────────────────────────────────────────────
// The local detector lives in its own module. It registers itself here, so
// this file builds and runs whether or not a wake-word engine is present.
export interface WakeDetector {
  isReady(): Promise<boolean>;
  install(onProgress?: (msg: string) => void): Promise<[boolean, string]>;
  start(): Promise<boolean>;
  feed(pcm: Int16Array): void;
  onDetect(fn: () => void): void;
  stop(): void;
}
let wakeDetector: WakeDetector | null = null;
export function registerWakeDetector(d: WakeDetector): void {
  wakeDetector = d;
}

// ── Transcript hygiene (main.py _clean_transcript / _is_repeat_chunk) ────────
function cleanTranscript(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/<ctrl\d+>/gi, '').replace(/[\x00-\x08\x0b-\x1f]/g, '').trim();
}

function isRepeatChunk(txt: string, buf: string[]): boolean {
  if (txt.length < REPEAT_MIN) return buf.length > 0 && txt === buf[buf.length - 1];
  return buf.join(' ').includes(txt);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MarkLive implements MarkController {
  private bridge: MarkBridge;
  private running = false;
  private session: Session | null = null;
  private asstName = 'JARVIS';

  private mic = new MicCapture();
  private player = new Player();
  private echo = new EchoGuard();
  private visemes = new VisemeStream();

  private speaking = false;
  private tailUntil = 0;
  private muted = false;
  private interrupted = false;
  private turnDone = false;
  private turnDoneWaiters: Array<() => void> = [];

  private resumeHandle: string | null = null;
  private reconnectKeep = true;
  private reconnectReason = '';
  private voluntaryClose = false;
  private enhancedLive = true;
  private tunedLive = true;
  private backoff = 3;

  private wakeEnabled = false;
  private awake = true;
  private pttEnabled = false;
  private pttHeld = false;
  private phoneActive = false;
  private phoneTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingVision: { data: string; mimeType: string; question: string; angle: string } | null = null;
  private visionCamActive = false;
  private visionClosePending = false;
  private visionBusy = false;
  private visionLastTime = 0;

  private outBuf: string[] = [];
  private inBuf: string[] = [];
  private lastOutLogged = '';
  private lastUserSpeech = Date.now();
  private sessionLog: string[] = [];
  private briefingSent = false;
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(bridge: MarkBridge) {
    this.bridge = bridge;
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  private log(text: string): void {
    useMarkStore.getState().writeLog(text);
  }

  private setState(s: HudState): void {
    useMarkStore.getState().setHudState(s);
  }

  private broadcast(msg: Record<string, unknown>): void {
    this.bridge.remoteBroadcast(msg).catch(() => {});
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (this.running) return;
    const cfg = useMarkStore.getState().config;
    if (!cfg?.configured) return; // the setup overlay starts us once a key exists
    this.running = true;

    this.wakeEnabled = cfg.wake_word_enabled;
    this.awake = !this.wakeEnabled;
    this.muted = useMarkStore.getState().muted;
    if (cfg.push_to_talk_enabled) this.setPushToTalk(true).catch(() => {});
    if (wakeDetector) {
      wakeDetector.onDetect(() => this.wake('wake word'));
      wakeDetector.isReady().then((ready) => useMarkStore.getState().setWakeState({ ready }));
    }
    this.startBackgroundLoops();
    void this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.closeSession(true);
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const resumedWith = this.resumeHandle !== null;
      let outcome: { code: number; reason: string };
      try {
        outcome = await this.connectOnce();
      } catch (e) {
        outcome = { code: -1, reason: String((e as Error)?.message || e) };
      }
      this.session = null;
      useMarkStore.getState().setConnected(false);
      this.mic.stop();
      this.player.stop();
      this.setSpeaking(false);
      if (this.sessionLog.length >= 3) void this.saveSessionSummary();
      if (!this.running) break;

      // Voluntary rebuild (voice / device change): no backoff, no scary logs.
      if (this.voluntaryClose) {
        this.voluntaryClose = false;
        if (!this.reconnectKeep) this.resumeHandle = null;
        this.backoff = 3;
        continue;
      }

      const err = outcome.reason || '';
      console.warn(`[Mark] session closed (${outcome.code}): ${err}`);

      // A resumption handle the server will not accept must be dropped once,
      // or the feature meant to survive a reconnect would prevent one.
      if (resumedWith && /resum|handle|INVALID_ARGUMENT|NOT_FOUND/i.test(err)) {
        this.log('SYS: Could not restore the conversation — starting fresh.');
        this.resumeHandle = null;
        continue;
      }
      if (this.tunedLive && /INVALID_ARGUMENT|Unknown name|realtime_input|media_resolution|thinking/i.test(err)) {
        this.tunedLive = false;
        console.warn('[Mark] Live tuning rejected — reconnecting without it.');
        continue;
      }
      if (this.enhancedLive && /INVALID_ARGUMENT|proactiv|Unknown name/i.test(err)) {
        this.enhancedLive = false;
        this.log('SYS: Proactive audio unavailable — reconnecting without it.');
        continue;
      }
      if (/API key not valid|API_KEY_INVALID/i.test(err)) {
        this.log('ERR: API key invalid — please re-enter your key.');
        this.setState('SLEEPING');
        this.running = false;
        useMarkStore.getState().setOverlay('setup');
        return;
      }
      if (/network|timed out|ECONN|Failed to fetch|1006/i.test(err) || outcome.code === 1006) {
        this.backoff = Math.min(this.backoff * 2, 60);
        this.log(`NET: Connection failed — retrying in ${this.backoff}s. (a VPN may be required)`);
      } else {
        this.backoff = 3;
      }
      this.setState('SLEEPING');
      this.broadcast({ type: 'status', state: 'sleeping' });
      await sleep(this.backoff * 1000);
    }
  }

  private buildConfig(setup: SessionSetup): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      systemInstruction: setup.systemInstruction,
      tools: [{ functionDeclarations: setup.tools }],
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      // Sliding-window compression: the session never dies of a full context.
      contextWindowCompression: { slidingWindow: {} },
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: setup.voice } } },
    };
    if (this.enhancedLive && setup.proactiveAudio) cfg.proactivity = { proactiveAudio: true };
    if (this.tunedLive) {
      const t = setup.turnTuning;
      if (t.enabled) {
        const detect: Record<string, unknown> = { silenceDurationMs: t.silence_ms, prefixPaddingMs: t.prefix_ms };
        if (t.end_sensitivity === 'high') detect.endOfSpeechSensitivity = 'END_SENSITIVITY_HIGH';
        else if (t.end_sensitivity === 'low') detect.endOfSpeechSensitivity = 'END_SENSITIVITY_LOW';
        if (t.start_sensitivity === 'high') detect.startOfSpeechSensitivity = 'START_SENSITIVITY_HIGH';
        else if (t.start_sensitivity === 'low') detect.startOfSpeechSensitivity = 'START_SENSITIVITY_LOW';
        cfg.realtimeInputConfig = { automaticActivityDetection: detect };
      }
      if (setup.mediaResolution !== 'default') {
        cfg.mediaResolution = `MEDIA_RESOLUTION_${setup.mediaResolution.toUpperCase()}`;
      }
      if (setup.thinking) cfg.thinkingConfig = { thinkingBudget: -1 };
    }
    return cfg;
  }

  /** One session, from connect to close. Resolves with the close reason. */
  private async connectOnce(): Promise<{ code: number; reason: string }> {
    this.setState('THINKING');
    const resumed = this.resumeHandle !== null;
    const setup = await this.bridge.sessionSetup();
    this.asstName = setup.assistantName;
    if (!setup.apiKey) {
      useMarkStore.getState().setOverlay('setup');
      this.running = false;
      return { code: 0, reason: 'no API key' };
    }

    // Fresh client every time: v1alpha carries proactive audio.
    const ai = new GoogleGenAI({
      apiKey: setup.apiKey,
      httpOptions: { apiVersion: this.enhancedLive ? 'v1alpha' : 'v1beta' },
    });

    let resolveClose!: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClose = r));

    this.session = await ai.live.connect({
      model: setup.model,
      config: this.buildConfig(setup),
      callbacks: {
        onmessage: (m: LiveServerMessage) => {
          this.onMessage(m).catch((e) => console.error('[Mark] recv', e));
        },
        onerror: (e: ErrorEvent) => console.warn('[Mark] socket error', e?.message),
        onclose: (e: CloseEvent) => resolveClose({ code: e?.code ?? 0, reason: e?.reason || '' }),
      },
    });

    // Reset transient state that must not carry over.
    this.pendingVision = null;
    this.visionCamActive = false;
    this.visionClosePending = false;
    this.visionBusy = false;
    this.visionLastTime = 0;
    this.interrupted = false;
    this.outBuf = [];
    this.inBuf = [];
    this.visemes.reset();

    const cfg = useMarkStore.getState().config;
    const spkNote = await this.player.start(cfg?.output_device || '');
    if (spkNote) this.log(`SYS: ${spkNote}`);
    try {
      const micNote = await this.mic.start(cfg?.input_device || '', (pcm) => this.onMicChunk(pcm));
      if (micNote) this.log(`SYS: ${micNote}`);
    } catch (e) {
      this.log(`ERR: Microphone — ${(e as Error)?.message || e}`);
    }

    useMarkStore.getState().setConnected(true);
    this.backoff = 3;
    if (resumed) this.log('SYS: Reconnected — conversation restored.');

    if (this.wakeEnabled) {
      await this.ensureWakeDetector();
      this.awake = false;
      useMarkStore.getState().setWakeState({ enabled: true, awake: false });
      this.setState('SLEEPING');
      this.log(`SYS: ${this.asstName} online — sleeping. Say 'Hey Jarvis' to wake me.`);
    } else {
      this.awake = true;
      useMarkStore.getState().setWakeState({ enabled: false, awake: true });
      this.setState(this.muted ? 'SLEEPING' : 'LISTENING');
      this.log(`SYS: ${this.asstName} online.`);
    }
    this.broadcast({ type: 'status', state: 'active' });

    // Morning briefing — once per launch, never while asleep.
    if (!this.briefingSent && cfg?.morning_brief_enabled && this.awake) {
      this.briefingSent = true;
      void this.sendStartupBriefing();
    }

    return closed;
  }

  private closeSession(voluntary: boolean): void {
    this.voluntaryClose = voluntary;
    try {
      this.session?.close();
    } catch {
      /* already closed */
    }
  }

  reconnect(keepContext: boolean, reason: string): void {
    this.reconnectKeep = keepContext;
    this.reconnectReason = reason;
    if (!this.session) return;
    this.log(
      `SYS: Applying ${reason || 'settings'} — reconnecting` +
        (keepContext ? '...' : ' (starting a fresh conversation)...'),
    );
    this.closeSession(true);
  }

  // ── Sending ────────────────────────────────────────────────────────────────
  private sendTurn(text: string): void {
    try {
      this.session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
    } catch (e) {
      console.warn('[Mark] send failed', e);
    }
  }

  sendText(text: string): void {
    if (!this.session) return;
    // A typed command must not be answered while asleep either.
    if (this.wakeEnabled && !this.awake) {
      this.log("SYS: I'm asleep — say 'Hey Jarvis' or tap WAKE NOW first.");
      return;
    }
    this.lastUserSpeech = Date.now();
    this.sendTurn(text);
  }

  /** Plugins' and tools' mid-task speech channel (Mark's plugin_say). */
  private say(text: string): void {
    if (this.session && text) this.sendTurn(text);
  }

  private speakError(tool: string, error: string): void {
    const short = String(error).slice(0, 120);
    this.log(`ERR: ${tool} — ${short}`);
    this.say(`Sir, ${tool} encountered an error. ${short}`);
  }

  // ── Microphone path (main.py _listen_audio callback) ───────────────────────
  private onMicChunk(pcm: Int16Array): void {
    // Asleep: nothing is streamed; frames go to the local detector only.
    if (this.wakeEnabled && !this.awake) {
      wakeDetector?.feed(pcm);
      return;
    }
    // Nothing is streamed while the assistant talks (barge-in stays off, as in Mark).
    if (this.speaking) return;

    const level = pcmLevel(pcm);
    // Echo tail: the speakers have not finished. Drop only our own voice.
    if (performance.now() < this.tailUntil) {
      if (!this.echo.isUserSpeech(pcm, SEND_RATE, level)) return;
      this.tailUntil = 0; // a real voice ends the tail early
    } else if (this.echo.hist.length) {
      this.echo.reset();
    }

    if (this.pttEnabled && !this.pttHeld) return;
    if (this.muted || this.phoneActive || !this.session) return;
    this.sendAudio(pcm);
    hud.setAudioLevel(level);
  }

  private sendAudio(pcm: Int16Array): void {
    try {
      this.session?.sendRealtimeInput({ audio: { data: int16ToBase64(pcm), mimeType: `audio/pcm;rate=${SEND_RATE}` } });
    } catch {
      /* socket closing — the loop will rebuild it */
    }
  }

  // ── Receiving (main.py _receive_audio) ─────────────────────────────────────
  private async onMessage(m: LiveServerMessage): Promise<void> {
    const sru = m.sessionResumptionUpdate;
    if (sru?.resumable && sru.newHandle) this.resumeHandle = sru.newHandle;

    const sc = m.serverContent;
    const parts = sc?.modelTurn?.parts || [];
    for (const p of parts) {
      const data = p.inlineData?.data;
      if (data && (p.inlineData?.mimeType || '').startsWith('audio') && !this.interrupted) {
        this.turnDone = false;
        this.playChunk(base64ToInt16(data));
      }
    }

    if (sc) {
      if (sc.outputTranscription?.text) {
        const txt = cleanTranscript(sc.outputTranscription.text);
        if (txt && !isRepeatChunk(txt, this.outBuf)) {
          this.outBuf.push(txt);
          this.visemes.feedText(txt);
        }
      }
      if (sc.inputTranscription?.text) {
        const txt = cleanTranscript(sc.inputTranscription.text);
        if (txt) {
          this.inBuf.push(txt);
          this.lastUserSpeech = Date.now();
        }
      }
      if (sc.interrupted) {
        // The server decided the user took the floor: stop talking now.
        this.player.flush();
        hud.clearVisemes();
        this.visemes.reset();
      }
      if (sc.turnComplete) this.onTurnComplete();
    }

    if (m.toolCall?.functionCalls?.length) {
      const responses = [];
      for (const fc of m.toolCall.functionCalls) responses.push(await this.executeTool(fc));
      try {
        this.session?.sendToolResponse({ functionResponses: responses });
      } catch (e) {
        console.warn('[Mark] tool response failed', e);
      }
      this.flushPendingVision();
    }
  }

  private playChunk(pcm: Int16Array): void {
    this.setSpeaking(true);
    const at = this.player.enqueue(pcm);
    try {
      const audio = pcmVisemes(pcm, RECEIVE_RATE);
      if (audio.length) {
        const frames = this.visemes.frames(audio, VIS_HOP / RECEIVE_RATE);
        hud.pushVisemes(frames, VIS_HOP / RECEIVE_RATE, at);
        const peak = Math.max(...frames.map((f) => f.level));
        this.echo.noteOutput(pcm, RECEIVE_RATE, peak, at);
        hud.setAudioLevel(peak);
      } else {
        const lvl = pcmLevel(pcm);
        hud.setAudioLevel(lvl);
        this.echo.noteOutput(pcm, RECEIVE_RATE, lvl, at);
      }
    } catch {
      /* cosmetic — never disturb playback */
    }
  }

  private onTurnComplete(): void {
    this.turnDone = true;
    const waiters = this.turnDoneWaiters;
    this.turnDoneWaiters = [];
    waiters.forEach((w) => w());

    if (this.interrupted) {
      this.interrupted = false;
      this.inBuf = [];
      this.outBuf = [];
      this.visemes.reset();
      return;
    }

    const fullIn = this.inBuf.join(' ').trim();
    if (fullIn) {
      this.lastOutLogged = '';
      this.log(`You: ${fullIn}`);
      this.sessionLog.push(`User: ${fullIn}`);
      this.broadcast({ type: 'log', speaker: 'user', text: fullIn, ts: new Date().toISOString() });
    }
    this.inBuf = [];

    let fullOut = this.outBuf.join(' ').trim();
    // Never log the same answer (or a tail of it) twice in a row.
    if (fullOut && fullOut.length >= REPEAT_MIN && this.lastOutLogged && this.lastOutLogged.includes(fullOut)) {
      fullOut = '';
    }
    if (fullOut) {
      this.lastOutLogged = fullOut;
      this.log(`${this.asstName}: ${fullOut}`);
      this.sessionLog.push(`${this.asstName}: ${fullOut}`);
      this.broadcast({ type: 'log', speaker: 'jarvis', text: fullOut, ts: new Date().toISOString() });
    }
    this.outBuf = [];

    if (this.visionClosePending) {
      this.visionClosePending = false;
      this.visionBusy = false;
      setTimeout(() => this.closeCamera(), 2000);
    }
  }

  private waitTurnDone(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.turnDoneWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  private setSpeaking(value: boolean): void {
    if (value === this.speaking) return;
    this.speaking = value;
    if (value) {
      this.tailUntil = 0;
      this.setState('SPEAKING');
    } else {
      // Hold the guard open across the device's own latency plus a margin
      // for the room. The mic stays open: only our own echo is dropped.
      this.tailUntil = performance.now() + this.player.latency * 1000 + TAIL_MARGIN_MS;
      hud.setAudioLevel(0);
      if (!this.muted && this.awake) this.setState('LISTENING');
    }
  }

  /** Playback watchdog: the reply is over once the turn is done AND the audio has played. */
  private checkPlayback(): void {
    if (this.speaking && this.turnDone && !this.player.playing) {
      this.setSpeaking(false);
      this.turnDone = false;
    }
  }

  interrupt(): void {
    this.interrupted = true;
    this.player.flush();
    this.setSpeaking(false);
    this.visemes.reset();
    hud.clearVisemes();
    this.turnDone = false;
    this.log('SYS: Interrupted — listening...');
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      hud.setAudioLevel(0);
      this.setState('SLEEPING');
    } else if (!this.speaking && this.awake) this.setState('LISTENING');
  }

  // ── Tools (main.py _execute_tool) ──────────────────────────────────────────
  private async executeTool(fc: { id?: string; name?: string; args?: Record<string, unknown> }) {
    const name = fc.name || '';
    const args = { ...(fc.args || {}) };
    this.setState('THINKING');
    let response: Record<string, unknown> = { result: 'Done.' };
    let scheduling: string | null = null;

    try {
      if (name === 'screen_process') {
        response = { result: await this.screenProcess(args) };
      } else if (name === 'close_camera') {
        this.closeCamera();
        response = { result: 'Camera closed.' };
      } else if (name === 'shutdown_jarvis') {
        this.log('SYS: Shutdown requested.');
        void this.doShutdown();
        response = { result: 'Shutting down.' };
      } else {
        const out = await this.bridge.runTool(name, args, { currentFile: useMarkStore.getState().currentFile });
        scheduling = out.scheduling;
        const r = out.result;
        response = r && typeof r === 'object' ? (r as Record<string, unknown>) : { result: r ?? 'Done.' };
      }
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      response = { result: `Tool '${name}' failed: ${msg}` };
      this.speakError(name, msg);
    }

    if (!this.muted && !this.speaking) this.setState('LISTENING');
    const fr: Record<string, unknown> = { id: fc.id, name, response };
    if (scheduling) fr.scheduling = scheduling;
    return fr;
  }

  private async screenProcess(args: Record<string, unknown>): Promise<string> {
    const now = performance.now();
    if (this.visionBusy || now - this.visionLastTime < VISION_COOLDOWN_MS) {
      return 'Vision is still processing the previous request. I will not call this again.';
    }
    this.visionBusy = true;
    this.visionLastTime = now;
    const angle = String(args.angle || 'screen').toLowerCase();
    const question = String(args.text || 'What do you see?');
    try {
      let img: { data: string; mimeType: string };
      if (angle === 'camera') {
        img = await camera.captureFrame();
        useMarkStore.getState().setCameraOn(true);
        this.visionCamActive = true;
      } else {
        img = await this.bridge.captureScreen();
      }
      this.pendingVision = { data: img.data, mimeType: img.mimeType, question, angle };
    } catch (e) {
      this.visionBusy = false;
      throw e;
    }
    const stall = angle === 'camera' ? 'Camera' : 'Screen';
    // The image rides on this same exchange; asking for an acknowledgement
    // here is what produced two spoken answers in older Marks.
    return (
      `[VISION_ACTIVE] ${stall} captured and attached to this same exchange. ` +
      'Do not acknowledge and do not answer yet — the image is arriving with this result. ' +
      'Reply once, from what you actually see in it.'
    );
  }

  private flushPendingVision(): void {
    const v = this.pendingVision;
    if (!v || !this.session) return;
    this.pendingVision = null;
    // Label the source: a screenshot of this app has a face in it, and must
    // never be read as a photo of the user.
    const src = v.angle === 'camera' ? '[IMAGE SOURCE: WEBCAM]' : '[IMAGE SOURCE: SCREEN CAPTURE]';
    try {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ inlineData: { mimeType: v.mimeType, data: v.data } }, { text: `${src}\n\n${v.question}` }] }],
        turnComplete: true,
      });
    } catch (e) {
      console.warn('[Mark] vision send failed', e);
    }
    if (this.visionCamActive) {
      this.visionCamActive = false;
      this.visionClosePending = true;
    } else {
      this.visionBusy = false;
    }
  }

  closeCamera(): void {
    camera.stop();
    useMarkStore.getState().setCameraOn(false);
  }

  private async doShutdown(): Promise<void> {
    await this.saveSessionSummary();
    this.say('Say a brief natural goodbye to the user.');
    await sleep(1500);
    await this.bridge.shutdown();
  }

  // ── Wake word ──────────────────────────────────────────────────────────────
  private async ensureWakeDetector(): Promise<boolean> {
    if (!wakeDetector) return false;
    return wakeDetector.start().catch(() => false);
  }

  wake(reason: string): void {
    if (this.awake) return;
    this.awake = true;
    this.lastUserSpeech = Date.now();
    useMarkStore.getState().setWakeState({ awake: true });
    if (!this.muted) this.setState('LISTENING');
    this.log(`SYS: Awake — ${reason}.`);
    this.broadcast({ type: 'status', state: 'active' });
  }

  sleep(reason: string): void {
    if (!this.awake) return;
    this.awake = false;
    this.setSpeaking(false);
    useMarkStore.getState().setWakeState({ awake: false });
    this.setState('SLEEPING');
    this.log(`SYS: Sleeping — ${reason}. Say 'Hey Jarvis' to wake me.`);
    this.broadcast({ type: 'status', state: 'sleeping' });
  }

  async wakeToggle(enable: boolean): Promise<'enabled' | 'disabled' | 'need_download'> {
    if (enable) {
      if (!wakeDetector || !(await wakeDetector.isReady())) return 'need_download';
      this.wakeEnabled = true;
      await this.bridge.configSet({ wake_word_enabled: true });
      useMarkStore.getState().setWakeState({ enabled: true, ready: true });
      await this.ensureWakeDetector();
      this.sleep('wake word enabled');
      return 'enabled';
    }
    this.wakeEnabled = false;
    await this.bridge.configSet({ wake_word_enabled: false });
    useMarkStore.getState().setWakeState({ enabled: false });
    this.wake('wake word disabled');
    return 'disabled';
  }

  wakeManual(): void {
    if (!this.wakeEnabled) return;
    if (this.awake) this.sleep('you tapped sleep');
    else this.wake('you tapped wake');
  }

  async wakeInstall(onProgress?: (msg: string) => void): Promise<[boolean, string]> {
    if (!wakeDetector) return [false, 'The wake-word engine is not included in this build.'];
    const res = await wakeDetector.install((m) => {
      onProgress?.(m);
      this.log(`SYS: ${m}`);
    });
    if (res[0]) useMarkStore.getState().setWakeState({ ready: true });
    return res;
  }

  // ── Push-to-talk ───────────────────────────────────────────────────────────
  async setPushToTalk(enabled: boolean): Promise<'global' | 'window' | 'off'> {
    this.pttEnabled = enabled;
    this.pttHeld = false;
    if (!enabled) {
      await this.bridge.pttStop().catch(() => {});
      useMarkStore.getState().setPtt({ enabled: false, held: false, scope: 'off' });
      return 'off';
    }
    const scope = await this.bridge.pttStart().catch(() => 'window' as const);
    useMarkStore.getState().setPtt({ enabled: true, held: false, scope });
    this.log(`SYS: Push-to-talk on — hold Ctrl+Space${scope === 'global' ? '.' : ' (works while this window is focused).'}`);
    return scope;
  }

  pttHold(held: boolean): void {
    this.pttHeld = held;
    useMarkStore.getState().setPtt({ held });
    // Holding the chord is also a way to wake it.
    if (held && this.wakeEnabled && !this.awake) {
      this.awake = true;
      this.lastUserSpeech = Date.now();
      useMarkStore.getState().setWakeState({ awake: true });
    }
    this.setState(held ? 'LISTENING' : 'SLEEPING');
  }

  // ── Events from the main process ───────────────────────────────────────────
  onEvent(e: MarkEvent): void {
    switch (e.type) {
      case 'say':
        this.say(e.text);
        break;
      case 'ptt':
        if (this.pttEnabled) this.pttHold(e.held);
        break;
      case 'remote-command':
        void this.remoteCommand(e.text);
        break;
      case 'remote-wake':
        if (this.wakeEnabled) this.wake('remote dashboard');
        break;
      case 'remote-audio': {
        // Phone mic live: it takes over from the PC mic until 1 s of silence.
        this.phoneActive = true;
        if (this.phoneTimer) clearTimeout(this.phoneTimer);
        this.phoneTimer = setTimeout(() => (this.phoneActive = false), 1000);
        if (!this.speaking && !this.muted && this.session) {
          try {
            this.session.sendRealtimeInput({ audio: { data: e.data, mimeType: `audio/pcm;rate=${SEND_RATE}` } });
          } catch {
            /* closing */
          }
        }
        break;
      }
      case 'shutdown':
        void this.doShutdown();
        break;
      default:
        break;
    }
  }

  private async remoteCommand(text: string): Promise<void> {
    if (!text) return;
    for (let i = 0; i < 80 && !this.session; i++) await sleep(100);
    if (!this.session) return;
    // A remote command is deliberate control, and the phone has no WAKE button.
    if (this.wakeEnabled && !this.awake) this.wake('remote command');
    this.lastUserSpeech = Date.now();
    this.sendTurn(text);
    this.log(`[Web]: ${text}`);
  }

  // ── Background engines ─────────────────────────────────────────────────────
  private startBackgroundLoops(): void {
    this.timers.push(setInterval(() => this.checkPlayback(), 100));

    // Auto-sleep after two minutes of silence (wake-word mode only).
    this.timers.push(
      setInterval(() => {
        if (!this.wakeEnabled || !this.awake || this.speaking) return;
        if (Date.now() - this.lastUserSpeech > WAKE_SLEEP_TIMEOUT_MS) this.sleep('no speech for 2 minutes');
      }, 5000),
    );

    // Hardware alerts, never over an active conversation.
    this.timers.push(
      setInterval(async () => {
        const alert = await this.bridge.sysmonCheck().catch(() => null);
        if (!alert || !this.session || !this.awake || this.speaking) return;
        if (Date.now() - this.lastUserSpeech < 10_000) return;
        this.sendTurn(alert);
      }, 10_000),
    );

    // Proactive check-ins, evaluated once a minute.
    this.timers.push(
      setInterval(async () => {
        if (!this.session || !this.awake || this.speaking) return;
        const prompt = await this.bridge
          .proactive({ lastUserSpeechAt: this.lastUserSpeech, recentTurns: this.sessionLog.slice(-8) })
          .catch(() => null);
        if (prompt && this.session && !this.speaking) this.sendTurn(prompt);
      }, 60_000),
    );

    // Background topic monitor: first check 5 minutes in, then every 30.
    const bgCheck = async () => {
      if (!this.session || !this.awake || this.speaking) return;
      if (Date.now() - this.lastUserSpeech < 30_000) return;
      const alerts = await this.bridge.bgCheck().catch(() => [] as string[]);
      if (!alerts.length) return;
      const lang = (await this.bridge.memoryIdentity().catch(() => ({ language: '' }))).language || 'English';
      for (const alert of alerts) {
        this.sendTurn(`${alert}\n\nInform the user about this development naturally in ${lang}. One brief sentence only.`);
        await sleep(6000);
      }
    };
    setTimeout(() => {
      void bgCheck();
      this.timers.push(setInterval(() => void bgCheck(), 1_800_000));
    }, 300_000);
  }

  /** Two phases: an instant greeting, then the news fetched in parallel. */
  private async sendStartupBriefing(): Promise<void> {
    const { language: lang, name } = await this.bridge.memoryIdentity().catch(() => ({ language: '', name: '' }));
    const d = new Date();
    const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const news = this.bridge.news('top world news today').catch(() => '');

    await sleep(300);
    if (!this.session) return;

    const langClause = lang
      ? ` Speak this greeting in ${lang}, then follow the user's own language from their first reply onward.`
      : '';
    const nameClause = name ? ` Address the user as ${name}.` : '';
    let sessionClause = '';
    const last = await this.bridge.popLastSession().catch(() => null);
    if (last) {
      const days = Math.round((Date.now() - new Date(`${last.date}T00:00:00`).getTime()) / 86_400_000);
      const when = days <= 0 ? 'earlier today' : days === 1 ? 'yesterday' : `${days} days ago`;
      sessionClause = ` Also briefly and naturally mention that ${when}: ${last.summary}`;
    }

    this.turnDone = false;
    this.sendTurn(
      `Greet the user warmly, mention it is ${timeStr}, and say you are fetching today's news now.${sessionClause} ` +
        `Keep it to 2 short sentences max. Do not call any tools.${langClause}${nameClause}`,
    );

    const langStr = lang
      ? ` Speak in ${lang} unless the user has since spoken another language, in which case use theirs.`
      : '';
    // Wait for the greeting to finish so the two do not overlap.
    const waited = await this.waitTurnDone(6000);
    await sleep(waited ? 800 : 1000);
    let newsText = '';
    try {
      newsText = await Promise.race([news, sleep(8000).then(() => '')]);
    } catch {
      newsText = '';
    }
    if (!this.session) return;
    const failed = !newsText || /^(No news found|Search failed|Please provide)/.test(newsText);
    if (!failed) {
      useMarkStore.getState().showContent('NEWS — top world news today', newsText);
      this.sendTurn(
        `[BRIEFING] Here are today's top news headlines:\n${newsText}\n\n` +
          'Pick ONE headline, summarise it in one sentence, then say the full list ' +
          `is displayed on screen. Do not call any tools.${langStr}`,
      );
    } else {
      this.log(`SYS: News unavailable — backend returned: ${JSON.stringify(String(newsText).slice(0, 120))}`);
      this.sendTurn(`News headlines could not be fetched right now. Let the user know briefly.${langStr}`);
    }
  }

  private async saveSessionSummary(): Promise<void> {
    const lines = this.sessionLog;
    if (lines.length < 3) return;
    this.sessionLog = [];
    await this.bridge.saveSessionSummary(lines).catch(() => false);
  }
}

let instance: MarkLive | null = null;

/** Start the assistant. Idempotent; safe to call before a key is configured. */
export function startMarkLive(): void {
  const bridge = markBridge();
  if (!bridge) return;
  if (!instance) {
    instance = new MarkLive(bridge);
    setMarkController(instance);
    onSessionEvent((e) => instance?.onEvent(e));
  }
  void instance.start();
}
