'use client';

// The Mark LIV main window (ui.py MainWindow): header, SYS MONITOR, the HUD
// with its content/review/quiz panel, the activity log column, footer, and
// the floating drawer / clipboard panel / overlays on top. Everything goes
// through useMarkStore; nothing here touches the Live session directly.

import './mark.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { markController, useMarkStore } from '@/lib/mark/store';
import { hud } from '@/lib/mark/hud';
import HudCanvas from './HudCanvas';
import MarkOverlays from './overlays';
import Header from './Header';
import LeftPanel, { APP_VERSION } from './LeftPanel';
import RightPanel, { toggleMuteLogged } from './RightPanel';
import QuickDrawer, { toggleFullscreen } from './QuickDrawer';
import ContentPanel from './ContentPanel';
import ReviewPanel from './ReviewPanel';
import QuizPanel from './QuizPanel';
import CameraPreview from './CameraPreview';
import ClipboardPanel from './ClipboardPanel';
import { DEFAULT_UI_COLOR, paletteVars } from './palette';

type Slot = 'content' | 'review' | 'quiz';

// Mark's splitter gives each panel this much room the first time it opens.
const FIRST_HEIGHT: Record<Slot, number> = { content: 220, review: 260, quiz: 250 };
const MIN_PANEL = 60;
const MIN_HUD = 120;

export default function MarkHud({ className }: { className?: string }) {
  const accent = useMarkStore((s) => s.config?.ui_color || DEFAULT_UI_COLOR);
  const assistantName = useMarkStore((s) => (s.config?.assistant_name || 'JARVIS').trim() || 'JARVIS');
  const content = useMarkStore((s) => s.content);
  const review = useMarkStore((s) => s.review);
  const quiz = useMarkStore((s) => s.quiz);
  const cameraOn = useMarkStore((s) => s.cameraOn);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const vars = useMemo(() => paletteVars(accent), [accent]);

  // ── window title ──────────────────────────────────────────────────────────
  useEffect(() => {
    const prev = document.title;
    document.title = `${assistantName.toUpperCase()} — ${APP_VERSION}`;
    return () => {
      document.title = prev;
    };
  }, [assistantName]);

  // ── bottom panel: the latest arrival among content / review / quiz ────────
  // Content and review share one panel in Mark (a review is rich text laid
  // into it), and the splitter collapses whichever panel did not just open.
  const [arrived, setArrived] = useState<Record<Slot, number>>({ content: 0, review: 0, quiz: 0 });
  const [panelH, setPanelH] = useState(220);
  const panelShown = useRef(false);

  const arrive = useCallback((slot: Slot) => {
    setArrived((a) => ({ ...a, [slot]: performance.now() }));
    if (!panelShown.current) setPanelH(FIRST_HEIGHT[slot]);
  }, []);

  useEffect(() => {
    if (content) arrive('content');
  }, [content, arrive]);
  useEffect(() => {
    if (review) {
      arrive('review');
      hud.glance(0, 0.6, 1.3);
    }
  }, [review, arrive]);
  useEffect(() => {
    if (quiz && quiz.questions.length) arrive('quiz');
  }, [quiz, arrive]);

  const [reviewAt, setReviewAt] = useState(0);
  useEffect(() => {
    if (review) setReviewAt(Date.now());
  }, [review]);

  const candidates: Slot[] = [];
  if (content) candidates.push('content');
  if (review) candidates.push('review');
  if (quiz && quiz.questions.length) candidates.push('quiz');
  const slot = candidates.sort((a, b) => arrived[b] - arrived[a])[0] as Slot | undefined;
  // The content/review panel shows whichever of the two landed last.
  const textSlot: Slot | undefined =
    content && review ? (arrived.content >= arrived.review ? 'content' : 'review') : content ? 'content' : review ? 'review' : undefined;
  const bottom: Slot | undefined = slot === 'quiz' ? 'quiz' : textSlot;

  useEffect(() => {
    panelShown.current = !!bottom;
  }, [bottom]);

  // ── splitter ──────────────────────────────────────────────────────────────
  const centerRef = useRef<HTMLDivElement>(null);
  const onSplitDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelH;
    const total = centerRef.current?.clientHeight || 600;
    const move = (ev: PointerEvent) => {
      const h = startH - (ev.clientY - startY);
      setPanelH(Math.max(MIN_PANEL, Math.min(total - MIN_HUD - 4, h)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ── keyboard: F4 mute, F11 fullscreen, Esc interrupt, windowed PTT ────────
  useEffect(() => {
    let pttHeld = false;
    const release = () => {
      if (!pttHeld) return;
      pttHeld = false;
      markController()?.pttHold(false);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'F4') {
        e.preventDefault();
        if (!e.repeat) toggleMuteLogged();
      } else if (e.key === 'F11') {
        e.preventDefault();
        if (!e.repeat) toggleFullscreen();
      } else if (e.key === 'Escape') {
        useMarkStore.getState().interrupt();
      } else if (e.code === 'Space' && e.ctrlKey) {
        // The chord is only ours when no global hook owns it (non-Windows or
        // the hook failed): then it works while this window has focus.
        const { ptt } = useMarkStore.getState();
        if (!ptt.enabled || ptt.scope === 'global') return;
        e.preventDefault();
        if (!pttHeld) {
          pttHeld = true;
          markController()?.pttHold(true);
        }
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (pttHeld && (e.code === 'Space' || e.key === 'Control')) release();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', release);
      release();
    };
  }, []);

  const s = useMarkStore.getState;

  return (
    <div className={`mk-root${className ? ` ${className}` : ''}`} style={vars as React.CSSProperties}>
      <Header assistantName={assistantName} drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen((o) => !o)} />

      <div className="mk-body">
        <LeftPanel />

        <div className="mk-center" ref={centerRef}>
          <div className="mk-stage">
            {/* Kept mounted under the camera so switching back is instant. */}
            <HudCanvas className="mk-hudcanvas" assistantName={assistantName.toUpperCase()} />
            {cameraOn && <CameraPreview />}
          </div>

          {bottom && <div className="mk-split" onPointerDown={onSplitDown} />}
          {bottom === 'content' && content && (
            <ContentPanel
              title={content.title}
              text={content.text}
              at={content.at}
              height={panelH}
              onDismiss={() => {
                s().hideContent();
                s().hideReview();
              }}
            />
          )}
          {bottom === 'review' && review && (
            <ReviewPanel
              title={review.title}
              summary={review.summary}
              findings={review.findings}
              unclear={review.unclear}
              at={reviewAt || Date.now()}
              height={panelH}
              // One panel in Mark: dismissing it clears what it was showing.
              onDismiss={() => {
                s().hideReview();
                s().hideContent();
              }}
            />
          )}
          {/* Stays mounted while another panel covers it, so an answer in
              progress survives a search result landing on top. */}
          {quiz && quiz.questions.length > 0 && (
            <div style={{ display: bottom === 'quiz' ? 'contents' : 'none' }}>
              <QuizPanel
                key={arrived.quiz}
                topic={quiz.topic}
                questions={quiz.questions}
                height={panelH}
                onDismiss={() => s().hideQuiz()}
                onFinish={({ topic, right, total, message }) => {
                  s().hideQuiz();
                  s().writeLog(`QUIZ: ${topic || 'quiz'} — ${right}/${total} correct`);
                  s().sendText(message);
                }}
              />
            </div>
          )}
        </div>

        <RightPanel />
      </div>

      <div className="mk-footer">
        <span>{'[F4] Mute  ·  [F11] Fullscreen'}</span>
        <span style={{ color: 'var(--mk-pri-dim)' }}>By FatihMakes</span>
      </div>

      {drawerOpen && <QuickDrawer />}
      <ClipboardPanel />
      <MarkOverlays />
    </div>
  );
}
