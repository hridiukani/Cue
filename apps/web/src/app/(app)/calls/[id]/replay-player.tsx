'use client';

import type { Speaker, Speed } from '@cue/shared';
import { useEffect, useRef, useState } from 'react';
import { buttonClass } from '@/components/button-styles';
import { formatDuration } from '@/lib/call-filters';
import type { Banner, ReplayState } from '@/lib/replay-state';
import { getRealtimeTicket } from '../actions';
import { AudioTrack } from './audio-track';
import { SuggestionPanel } from './suggestion-panel';
import { useReplay } from './use-replay';

const SPEEDS: { value: Speed; label: string }[] = [
  { value: '1x', label: '1×' },
  { value: '2x', label: '2×' },
  { value: 'instant', label: 'Instant' },
];

const SPEAKER_LABEL: Record<Speaker, string> = { rep: 'Rep', prospect: 'Prospect' };

export function ReplayPlayer({
  recordingId,
  durationMs,
  wsUrl,
  playbooks,
  audioSrc,
}: {
  recordingId: string;
  durationMs: number;
  wsUrl: string;
  /** The recording's audio route, or null for transcript-only recordings. */
  audioSrc: string | null;
  /** The signed-in user's playbooks; one can be used for suggestions. */
  playbooks: { id: string; name: string }[];
}) {
  const r = useReplay({ recordingId, wsUrl, durationMs, getTicket: getRealtimeTicket });
  const { state } = r;
  const [chosenSpeed, setChosenSpeed] = useState<Speed>('1x');
  const [playbookId, setPlaybookId] = useState(''); // '' = no playbook
  const startReplay = () => {
    r.start(chosenSpeed, playbookId || null);
  };
  // While dragging the seek bar, show the drag position; send one seek on release.
  const [dragMs, setDragMs] = useState<number | null>(null);

  const connected = state.connection === 'open';
  const started = state.playback !== 'idle';
  const finished = state.playback === 'ended' || state.playback === 'failed';
  const canControl = connected && started && !finished;
  const shownPosition = dragMs ?? state.positionMs;

  const commitSeek = () => {
    if (dragMs !== null) r.seek(dragMs);
    setDragMs(null);
  };

  return (
    <div className="space-y-4">
      <ConnectionBadge state={state} />
      {state.banner && (
        <StatusBanner
          banner={state.banner}
          onAction={() => {
            const action = state.banner?.action;
            if (action === 'retry') r.play();
            else if (action === 'reconnect') r.reconnectNow();
            else if (action === 'restart') startReplay();
            r.dismissBanner();
          }}
          onDismiss={r.dismissBanner}
        />
      )}

      <div className="space-y-4 border-y border-rule py-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          {!started || finished ? (
            <button
              type="button"
              disabled={!connected}
              onClick={startReplay}
              className={buttonClass('primary')}
            >
              {finished ? '↺ Replay again' : '▶ Start replay'}
            </button>
          ) : state.playback === 'playing' ? (
            <button
              type="button"
              disabled={!canControl}
              onClick={r.pause}
              className={buttonClass('primary')}
            >
              ❚❚ Pause
            </button>
          ) : (
            <button
              type="button"
              disabled={!canControl}
              onClick={r.play}
              className={buttonClass('primary')}
            >
              ▶ Play
            </button>
          )}

          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Playbook</span>
            <select
              value={playbookId}
              // Fixed for the session: pick before starting (or start a new replay).
              disabled={started && !finished}
              onChange={(e) => {
                setPlaybookId(e.target.value);
              }}
              className="max-w-44 border-0 border-b border-border bg-transparent py-1 text-[15px] focus:border-ring focus:outline-none"
            >
              <option value="">None (generic)</option>
              {playbooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Speed</span>
            <select
              value={started ? state.speed : chosenSpeed}
              disabled={started && !canControl}
              onChange={(e) => {
                const speed = e.target.value as Speed;
                setChosenSpeed(speed);
                if (started) r.setSpeed(speed);
              }}
              className="border-0 border-b border-border bg-transparent py-1 text-[15px] focus:border-ring focus:outline-none"
            >
              {SPEEDS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <span className="ml-auto font-mono text-lg tabular text-foreground">
            {formatDuration(shownPosition)} / {formatDuration(state.durationMs)}
          </span>
        </div>

        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={Math.max(1, state.durationMs)}
          step={1000}
          value={Math.min(shownPosition, state.durationMs)}
          disabled={!canControl}
          onChange={(e) => {
            setDragMs(Number(e.target.value));
          }}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          className="w-full accent-signal disabled:opacity-50"
        />
        <p className="text-xs text-muted-foreground">
          Seeking back starts a new replay session; the earlier one keeps everything it saved.
        </p>
        {audioSrc && (
          <AudioTrack
            src={audioSrc}
            transcriptDurationMs={state.durationMs}
            sessionId={state.sessionId}
            playback={state.playback}
            positionMs={state.positionMs}
            speed={state.speed}
          />
        )}
      </div>

      {/* Live two-sided transcript on the left, the streaming suggestion on the right. */}
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <Transcript state={state} />
        <SuggestionPanel
          availability={state.suggestions}
          suggestion={state.suggestion}
          past={state.pastSuggestions}
          speed={state.speed}
          onFeedback={r.sendFeedback}
          onRendered={r.reportRendered}
        />
      </div>
    </div>
  );
}

function Transcript({ state }: { state: ReplayState }) {
  const bottom = useRef<HTMLDivElement>(null);
  const interims = Object.values(state.interims).sort((a, b) => a.startMs - b.startMs);
  const lines = state.finals.length + interims.length;

  // Follow the conversation like a live caption.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [lines]);

  if (lines === 0) {
    return (
      <div className="border-t border-border py-10 text-muted-foreground">
        {state.playback === 'idle'
          ? 'Press Start replay. The transcript appears here as each person speaks.'
          : 'Waiting for the first words…'}
      </div>
    );
  }

  return (
    <div className="max-h-[60vh] overflow-y-auto border-t border-border" aria-live="polite">
      {state.finals.map((f) => (
        <Line key={f.utteranceId} speaker={f.speaker} text={f.text} atMs={f.startMs} />
      ))}
      {interims.map((i) => (
        <Line key={i.key} speaker={i.speaker} text={i.text} atMs={i.startMs} interim />
      ))}
      <div ref={bottom} />
    </div>
  );
}

function Line({
  speaker,
  text,
  atMs,
  interim = false,
}: {
  speaker: Speaker;
  text: string;
  atMs: number;
  interim?: boolean;
}) {
  return (
    <div className="flex gap-6 border-b border-border py-4">
      <p className="w-24 shrink-0 font-mono text-xs uppercase leading-6 tracking-wider">
        <span className={speaker === 'prospect' ? 'text-signal' : 'text-foreground'}>
          {SPEAKER_LABEL[speaker]}
        </span>
        <span className="block text-muted-foreground tabular">{formatDuration(atMs)}</span>
      </p>
      <p className={`text-base leading-relaxed ${interim ? 'italic text-muted-foreground' : ''}`}>
        {text}
        {interim && <span className="text-muted-foreground"> …</span>}
      </p>
    </div>
  );
}

function ConnectionBadge({ state }: { state: ReplayState }) {
  const label = {
    waking: 'Waking the server…',
    connecting: 'Connecting…',
    open: 'Connected',
    reconnecting: `Reconnecting (attempt ${String(state.attempt)})…`,
    offline: 'Offline',
    not_found: 'Session ended',
  }[state.connection];
  const dot = {
    waking: 'bg-signal/60 animate-pulse',
    connecting: 'bg-signal animate-pulse',
    open: 'bg-foreground',
    reconnecting: 'bg-signal animate-pulse',
    offline: 'bg-destructive',
    not_found: 'bg-muted-foreground',
  }[state.connection];
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
      {label}
      {state.playback !== 'idle' && (
        <span className="text-muted-foreground/70">· {state.playback}</span>
      )}
    </p>
  );
}

function StatusBanner({
  banner,
  onAction,
  onDismiss,
}: {
  banner: Banner;
  onAction: () => void;
  onDismiss: () => void;
}) {
  const tone = {
    info: 'border-border bg-card text-foreground',
    warning: 'border-signal/40 bg-card text-foreground',
    error: 'border-destructive/40 bg-card text-destructive',
  }[banner.level];
  const actionLabel = { retry: 'Retry', reconnect: 'Reconnect', restart: 'Start a new replay' };
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-3 rounded-sm border px-4 py-2 text-sm ${tone}`}
    >
      <span className="flex-1">{banner.message}</span>
      {banner.action && (
        <button type="button" onClick={onAction} className={buttonClass('secondary')}>
          {actionLabel[banner.action]}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-current opacity-60 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}
