'use client';

import type { Speaker, Speed } from '@cue/shared';
import { useEffect, useRef, useState } from 'react';
import { buttonClass } from '@/components/button-styles';
import { formatDuration } from '@/lib/call-filters';
import type { Banner, ReplayState } from '@/lib/replay-state';
import { getRealtimeTicket } from '../actions';
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
}: {
  recordingId: string;
  durationMs: number;
  wsUrl: string;
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

      <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
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
            <span className="text-neutral-600">Playbook</span>
            <select
              value={playbookId}
              // Fixed for the session: pick before starting (or start a new replay).
              disabled={started && !finished}
              onChange={(e) => {
                setPlaybookId(e.target.value);
              }}
              className="max-w-44 rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm"
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
            <span className="text-neutral-600">Speed</span>
            <select
              value={started ? state.speed : chosenSpeed}
              disabled={started && !canControl}
              onChange={(e) => {
                const speed = e.target.value as Speed;
                setChosenSpeed(speed);
                if (started) r.setSpeed(speed);
              }}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm"
            >
              {SPEEDS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <span className="ml-auto text-sm tabular-nums text-neutral-600">
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
          className="w-full accent-neutral-900 disabled:opacity-50"
        />
        <p className="text-xs text-neutral-500">
          Seeking back starts a new replay session; the earlier one keeps everything it saved.
        </p>
      </div>

      {/* Live two-sided transcript on the left, the streaming suggestion on the right. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
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
      <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-10 text-center text-sm text-neutral-500">
        {state.playback === 'idle'
          ? 'Press Start replay. The transcript appears here as each person speaks.'
          : 'Waiting for the first words…'}
      </div>
    );
  }

  return (
    <div
      className="max-h-[60vh] space-y-3 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-4"
      aria-live="polite"
    >
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
    <div className={`flex gap-3 ${speaker === 'rep' ? '' : 'flex-row-reverse text-right'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
          speaker === 'rep' ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-900'
        } ${interim ? 'italic opacity-60' : ''}`}
      >
        <p
          className={`mb-0.5 text-xs ${speaker === 'rep' ? 'text-neutral-300' : 'text-neutral-500'}`}
        >
          {SPEAKER_LABEL[speaker]} · {formatDuration(atMs)}
          {interim && ' · speaking…'}
        </p>
        <p>{text}</p>
      </div>
    </div>
  );
}

function ConnectionBadge({ state }: { state: ReplayState }) {
  const label = {
    connecting: 'Connecting…',
    open: 'Connected',
    reconnecting: `Reconnecting (attempt ${String(state.attempt)})…`,
    offline: 'Offline',
    not_found: 'Session ended',
  }[state.connection];
  const dot = {
    connecting: 'bg-amber-400 animate-pulse',
    open: 'bg-emerald-500',
    reconnecting: 'bg-amber-400 animate-pulse',
    offline: 'bg-red-500',
    not_found: 'bg-neutral-400',
  }[state.connection];
  return (
    <p className="flex items-center gap-2 text-xs text-neutral-600" role="status">
      <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
      {label}
      {state.playback !== 'idle' && <span className="text-neutral-400">· {state.playback}</span>}
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
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-red-200 bg-red-50 text-red-900',
  }[banner.level];
  const actionLabel = { retry: 'Retry', reconnect: 'Reconnect', restart: 'Start a new replay' };
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2 text-sm ${tone}`}
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
