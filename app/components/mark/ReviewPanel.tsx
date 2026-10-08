'use client';

import { useLayoutEffect, useRef } from 'react';
import type { ReviewFinding } from '@/lib/mark/types';
import { PanelHeader, hms } from './ContentPanel';

// Severity is a shape plus a colour, never a word: the findings are in the
// user's language, and "[SERIOUS]" inside a Turkish sentence is a seam. Shape
// plus colour also still reads for someone who can't tell red from amber.
const MARKS: Record<string, [string, string]> = {
  serious: ['var(--mk-red)', '▲'],
  caution: ['var(--mk-acc2)', '●'],
  note: ['var(--mk-pri-dim)', '·'],
};

const str = (v: unknown) => (v == null ? '' : String(v));

/** A document review, laid into the panel under the HUD. */
export default function ReviewPanel({
  title,
  summary,
  findings,
  unclear,
  at,
  height,
  onDismiss,
}: {
  title: string;
  summary: string;
  findings: ReviewFinding[];
  unclear: string[];
  at: number;
  height: number;
  onDismiss(): void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [at]);

  return (
    <div className="mk-panel" style={{ height }}>
      {/* Left as written, not upper-cased: this is the document's own name,
          and English casing rules mangle other languages (Turkish İ). */}
      <PanelHeader title={(title || 'Document').slice(0, 48)} right={hms(at)} onDismiss={onDismiss} />
      <div className="mk-rule" />
      <div className="mk-panel-text" ref={bodyRef}>
        {summary && <div className="mk-rv-summary">{summary}</div>}

        {(findings || []).map((f, i) => {
          const [colour, mark] = MARKS[str(f.severity)] || MARKS.note;
          const heading = str(f.heading ?? f.title);
          return (
            <div className="mk-rv-finding" key={i}>
              <span style={{ color: colour, fontWeight: 'bold' }}>{mark}</span>{' '}
              <span style={{ color: 'var(--mk-white)', fontWeight: 'bold' }}>{heading}</span>
              {f.detail && <div className="mk-rv-sub">{str(f.detail)}</div>}
              {/* The document's own wording, kept visibly apart from the explanation. */}
              {f.quote && <div className="mk-rv-quote">&ldquo;{str(f.quote)}&rdquo;</div>}
              {f.suggestion ? (
                <div className="mk-rv-sub" style={{ color: 'var(--mk-pri)' }}>
                  &rarr; {str(f.suggestion)}
                </div>
              ) : null}
            </div>
          );
        })}

        {unclear && unclear.length > 0 && (
          <>
            <div className="mk-rv-unclear">The document does not settle:</div>
            {unclear.map((u, i) => (
              <div key={i} className="mk-rv-sub" style={{ color: 'var(--mk-text-med)' }}>
                &middot; {str(u)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
