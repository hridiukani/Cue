'use client';

import type { FeedbackSignal, Speed, SuggestionFailureReason } from '@cue/shared';
import { useEffect } from 'react';
import type { SuggestionsAvailability, SuggestionView } from '@/lib/replay-state';

const DROP_REASON: Record<SuggestionFailureReason, string> = {
  cancelled_newer: 'Replaced by a newer line',
  cancelled_rep_spoke: 'You started talking',
  cancelled_stopped: 'Replay paused or moved',
  first_token_timeout: 'Too slow (no answer within 1.5 s)',
  timeout: 'Too slow to finish',
  rate_limited: 'Rate limited by the model provider',
  api_error: 'The model provider returned an error',
  empty_output: 'The model had nothing useful',
};

const ms = (v: number | undefined) => (v === undefined ? '–' : `${String(Math.round(v))} ms`);

/**
 * The right-hand column of the call screen: the suggestion streaming in,
 * feedback buttons, a latency readout, and the last few suggestions.
 */
export function SuggestionPanel({
  availability,
  suggestion,
  past,
  speed,
  onFeedback,
  onRendered,
}: {
  availability: SuggestionsAvailability | null;
  suggestion: SuggestionView | null;
  past: SuggestionView[];
  speed: Speed;
  onFeedback: (suggestionId: string, signal: FeedbackSignal) => void;
  onRendered: (suggestionId: string) => void;
}) {
  // Report time-to-paint once a completed suggestion is actually on screen:
  // two animation frames after React commits ≈ after the browser has painted.
  const completedId = suggestion?.status === 'complete' ? suggestion.id : null;
  useEffect(() => {
    if (!completedId) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        onRendered(completedId);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [completedId, onRendered]);

  return (
    <aside className="space-y-4" aria-label="Suggestions">
      <div className="border-t-2 border-signal bg-card p-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Suggested next line
          </h2>
          {availability?.available && (
            <span
              className="truncate text-xs text-muted-foreground"
              title={availability.model ?? ''}
            >
              {availability.playbook ? `Playbook: ${availability.playbook}` : 'No playbook'}
            </span>
          )}
        </div>

        <div className="mt-5 min-h-32">
          {availability && !availability.available ? (
            <p className="text-sm text-muted-foreground">
              Suggestions are off: the realtime server has no model API key (GROQ_API_KEY).
            </p>
          ) : speed === 'instant' ? (
            <p className="text-sm text-muted-foreground">
              Suggestions pause at instant speed. Use 1× or 2×.
            </p>
          ) : !suggestion ? (
            <p className="text-sm text-muted-foreground">
              A suggestion appears here each time the prospect finishes speaking.
            </p>
          ) : (
            <CurrentSuggestion suggestion={suggestion} onFeedback={onFeedback} />
          )}
        </div>
      </div>

      {past.length > 0 && (
        <div className="border-t border-border pt-4">
          <h3 className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Earlier
          </h3>
          <ul className="mt-3 divide-y divide-border">
            {past.map((s) => (
              <li key={s.id} className="py-3 text-sm">
                {s.status === 'complete' ? (
                  <span className="text-foreground">{s.text}</span>
                ) : (
                  <span className="text-muted-foreground/70 italic">
                    Dropped: {s.reason ? DROP_REASON[s.reason] : 'unknown'}
                  </span>
                )}
                {s.status === 'complete' && (
                  <FeedbackButtons suggestion={s} onFeedback={onFeedback} compact />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

function CurrentSuggestion({
  suggestion: s,
  onFeedback,
}: {
  suggestion: SuggestionView;
  onFeedback: (suggestionId: string, signal: FeedbackSignal) => void;
}) {
  if (s.status === 'dropped') {
    return (
      <p className="text-sm text-muted-foreground italic" role="status">
        No suggestion this time. {s.reason ? DROP_REASON[s.reason] : ''}.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="font-serif text-2xl leading-snug text-foreground" aria-live="polite">
        {s.text || <span className="text-muted-foreground">Thinking…</span>}
        {s.status === 'streaming' && (
          <span
            aria-hidden="true"
            className="ml-1 inline-block h-6 w-1.5 animate-pulse bg-signal align-middle"
          />
        )}
      </p>
      {s.status === 'complete' && (
        <>
          <FeedbackButtons suggestion={s} onFeedback={onFeedback} />
          <dl className="grid grid-cols-3 gap-2 border-t border-border pt-4 text-xs">
            <Latency label="First token" value={ms(s.firstTokenMs)} />
            <Latency label="Done" value={ms(s.lastTokenMs)} />
            <Latency label="On screen" value={ms(s.renderedMs)} />
          </dl>
          <p className="text-[11px] leading-tight text-muted-foreground/70">
            From the end of the prospect&apos;s line. In replay that&apos;s when the transcript line
            was emitted, so speech-to-text delay isn&apos;t included.
          </p>
        </>
      )}
    </div>
  );
}

function Latency({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-base tabular text-foreground">{value}</dd>
    </div>
  );
}

function FeedbackButtons({
  suggestion: s,
  onFeedback,
  compact = false,
}: {
  suggestion: SuggestionView;
  onFeedback: (suggestionId: string, signal: FeedbackSignal) => void;
  compact?: boolean;
}) {
  const button = (signal: FeedbackSignal, label: string, icon: string) => {
    const on = s.feedback.includes(signal);
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={label}
        title={label}
        onClick={() => {
          onFeedback(s.id, signal);
        }}
        className={`rounded-sm border px-2.5 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
          on
            ? 'border-rule bg-primary text-primary-foreground'
            : 'border-border bg-transparent text-foreground hover:border-rule'
        }`}
      >
        {icon}
        {!compact && signal === 'used' && <span className="ml-1">Used it</span>}
      </button>
    );
  };
  return (
    <div className={`flex gap-2 ${compact ? 'mt-1' : ''}`}>
      {button('thumbs_up', 'Helpful', '👍')}
      {button('thumbs_down', 'Not helpful', '👎')}
      {button('used', 'I used it', '✓')}
    </div>
  );
}
