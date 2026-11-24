import type { ReactNode } from 'react';

/** Quiet italic note, as in the call library: "timing estimated" / "real timing". */
export function TimingBadge({ timing }: { timing: 'real' | 'estimated' }) {
  return timing === 'real' ? (
    <span title="Utterance times come from the recording" className="italic text-foreground">
      real timing
    </span>
  ) : (
    <span
      title="The dataset has no timestamps; timing is estimated from text length"
      className="italic text-muted-foreground"
    >
      timing estimated
    </span>
  );
}

/**
 * A small mono tag. `signal` (orange) draws the eye, `neutral` doesn't, and
 * `ink` reads as a confirmed state.
 */
export function Badge({
  tone,
  title,
  children,
}: {
  tone: 'ink' | 'signal' | 'neutral';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    ink: 'border-rule text-foreground',
    signal: 'border-signal/50 text-signal',
    neutral: 'border-border text-muted-foreground',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
