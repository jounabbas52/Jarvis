'use client';

import { useEffect, useRef, useState } from 'react';
import type { QuizQuestion } from '@/lib/mark/types';
import { hud } from '@/lib/mark/hud';
import { PanelHeader } from './ContentPanel';

interface Result {
  question: string;
  type: string;
  given: string;
  answer: string;
  correct: boolean | null;
}

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.,;:!?'"`()[\]{}-]+/g, ' ')
    .trim();

/**
 * Mark's plugin-supplied grader, done locally from question.answer.
 * true = right, false = wrong, null = the assistant should judge it: open
 * answers and near-miss gap-fills are its call, not a guess made here.
 */
export function gradeLocally(q: QuizQuestion, given: string): boolean | null {
  const answer = q.answer;
  if (answer == null || String(answer).trim() === '') return null;
  const g = norm(given);
  const a = norm(answer);
  const opts = q.options || [];
  if (opts.length) {
    if (g === a) return true;
    // The answer is one of the options, word for word: anything else is wrong.
    if (opts.some((o) => norm(o) === a)) return false;
    // An answer given as a letter ("B") or a 1-based index points at an option.
    const idx = /^[a-z]$/.test(a) ? a.charCodeAt(0) - 97 : /^\d+$/.test(a) ? Number(a) - 1 : -1;
    if (idx >= 0 && idx < opts.length) return norm(opts[idx]) === g;
    // A labelled option ("B) Paris") against the bare answer "Paris" or "B".
    const m = g.match(/^([a-z]|\d+) (.+)$/);
    if (m) return m[2] === a || m[1] === a;
    return null;
  }
  if (!g) return false;
  return g === a ? true : null;
}

/** The interactive quiz under the HUD: ask, mark, and report back. */
export default function QuizPanel({
  topic,
  questions,
  height,
  onDismiss,
  onFinish,
}: {
  topic: string;
  questions: QuizQuestion[];
  height: number;
  onDismiss(): void;
  onFinish(summary: { topic: string; right: number; total: number; message: string }): void;
}) {
  const [i, setI] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [answered, setAnswered] = useState<Result | null>(null);
  const [field, setField] = useState('');
  const nextRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  // A fresh quiz starts from question one; the head looks down at the board.
  useEffect(() => {
    setI(0);
    setResults([]);
    setAnswered(null);
    setField('');
    hud.glance(0, 0.6, 1.3);
  }, [questions]);

  useEffect(() => {
    if (answered) nextRef.current?.focus();
    else fieldRef.current?.focus();
  }, [answered, i]);

  if (!questions.length) return null;
  const q = questions[Math.min(i, questions.length - 1)];
  const total = questions.length;
  const last = i >= total - 1;
  const opts = q.options || [];

  const submit = (given: string) => {
    if (answered) return;
    const r: Result = {
      question: String(q.question ?? ''),
      type: String(q.type ?? ''),
      given: String(given ?? '').trim(),
      answer: String(q.answer ?? ''),
      correct: gradeLocally(q, given),
    };
    setResults((rs) => [...rs, r]);
    setAnswered(r);
  };

  const finish = (all: Result[]) => {
    const right = all.filter((r) => r.correct === true).length;
    const unsure = all.filter((r) => r.correct === null).length;
    const n = all.length;
    // Handed back to the assistant as a message, not a tool return: the tool
    // call ended minutes ago. Same channel a dropped file uses.
    const lines = [
      `[QUIZ_DONE] topic=${topic || 'general'} | auto-marked ${right}/${n} correct` +
        (unsure ? `, ${unsure} still need your marking` : ''),
    ];
    all.forEach((r, k) => {
      const state = r.correct === true ? 'correct' : r.correct === false ? 'wrong' : 'NEEDS MARKING';
      lines.push(
        `${k + 1}. [${r.type}] ${r.question} | they answered: ${r.given || '(blank)'} | expected: ${r.answer} | ${state}`,
      );
    });
    lines.push(
      'Mark every question flagged NEEDS MARKING yourself — accept an answer ' +
        'that means the same thing. Then tell them how they did in their own ' +
        'language: the score, what they got wrong and why, in a couple of ' +
        'sentences. Offer another round only if it fits. ' +
        'Remember something only if it would still matter next week — that they ' +
        'are working through a subject, or keep missing the same thing. A score ' +
        'from one session is not worth a memory, and a memory per quiz would ' +
        'bury the things that are.',
    );
    onFinish({ topic, right, total: n, message: lines.join('\n') });
  };

  const next = () => {
    if (last) {
      finish(results);
    } else {
      setI(i + 1);
      setAnswered(null);
      setField('');
    }
  };

  let note: [string, string] | null = null;
  if (answered) {
    const extra = q.note ? `\n${String(q.note)}` : '';
    if (answered.correct === true) note = [`✓  correct${extra}`, 'var(--mk-green)'];
    else if (answered.correct === false) note = [`✕  ${String(q.answer ?? '')}${extra}`, 'var(--mk-red)'];
    else note = [`…  noted — I'll go over this one with you${extra}`, 'var(--mk-acc2)'];
  }

  return (
    <div className="mk-panel" style={{ height, gap: 6 }}>
      <PanelHeader title={(topic || 'quiz').toUpperCase().slice(0, 48)} right={`${i + 1} / ${total}`} onDismiss={onDismiss} />
      <div className="mk-rule" />
      <div className="mk-quiz-q">{String(q.question ?? '')}</div>

      <div className="mk-quiz-answers">
        {opts.length ? (
          opts.map((t, k) => (
            <button key={`${i}-${k}`} className="mk-quiz-btn" disabled={!!answered} onClick={() => submit(t)}>
              {'   ' + t}
            </button>
          ))
        ) : (
          <div className="mk-quiz-row">
            <input
              ref={fieldRef}
              className="mk-quiz-field"
              placeholder="your answer"
              value={field}
              disabled={!!answered}
              onChange={(e) => setField(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit(field);
              }}
            />
            <button className="mk-quiz-btn primary" style={{ width: 90 }} disabled={!!answered} onClick={() => submit(field)}>
              ANSWER
            </button>
          </div>
        )}
      </div>

      {note && (
        <div className="mk-quiz-note" style={{ color: note[1] }}>
          {note[0]}
        </div>
      )}

      {answered && (
        <div className="mk-quiz-foot">
          <button ref={nextRef} className="mk-quiz-btn primary" style={{ width: 110 }} onClick={next}>
            {last ? 'FINISH  →' : 'NEXT  →'}
          </button>
        </div>
      )}
    </div>
  );
}
