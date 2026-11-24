'use client';

import type { Speed } from '@cue/shared';
import { useRef, useState } from 'react';
import { buttonClass } from '@/components/button-styles';
import {
  type AudioSyncSnapshot,
  type AudioSyncStatus,
  describeDrift,
  SYNC_TOLERANCE_MS,
  type Timeline,
} from '@/lib/audio-sync';
import { formatDuration } from '@/lib/call-filters';
import { useAudioSync } from './use-audio-sync';

type Tone = 'ok' | 'warn' | 'error' | 'muted';

const TONE: Record<Tone, string> = {
  ok: 'border-border bg-card text-foreground',
  warn: 'border-signal/40 bg-card text-foreground',
  error: 'border-destructive/40 bg-card text-destructive',
  muted: 'border-border bg-secondary text-foreground',
};

function describe(s: AudioSyncSnapshot | null): { tone: Tone; text: string } {
  const status: AudioSyncStatus = s?.status ?? 'idle';
  const drift = s?.driftMs ?? null;
  switch (status) {
    case 'idle':
      return { tone: 'muted', text: 'Audio plays with the replay.' };
    case 'in_sync':
      return {
        tone: 'ok',
        text: `Audio in sync with the transcript (${describeDrift(drift ?? 0)}).`,
      };
    case 'drifting':
      return {
        tone: 'warn',
        text: `Audio is ${describeDrift(drift ?? 0)} of the transcript. It's moved back if this lasts over a second.`,
      };
    case 'buffering':
      return {
        tone: 'warn',
        text: `Audio is loading; the transcript keeps going (${describeDrift(drift ?? 0)}).`,
      };
    case 'paused':
      return { tone: 'muted', text: 'Audio paused with the replay.' };
    case 'off_at_instant':
      return { tone: 'muted', text: 'No audio at instant speed. Switch to 1× or 2× to hear it.' };
    case 'blocked':
      return { tone: 'warn', text: 'Your browser blocked the audio from starting.' };
    case 'audio_ended':
      return { tone: 'muted', text: 'The audio has ended; the transcript continues.' };
    case 'error':
      return {
        tone: 'error',
        text: "The audio couldn't load. The transcript and suggestions carry on without it.",
      };
  }
}

/**
 * The recording's audio, on the transcript's timeline. There are no native
 * controls on purpose: they'd let the audio be scrubbed on its own. Play,
 * pause, seek and speed are the replay's controls; this only adds mute.
 */
export function AudioTrack({
  src,
  transcriptDurationMs,
  sessionId,
  playback,
  positionMs,
  speed,
}: {
  src: string;
  transcriptDurationMs: number;
  sessionId: string | null;
  playback: Timeline['playback'];
  positionMs: number;
  speed: Speed;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [muted, setMuted] = useState(false);
  const { snapshot, unblock } = useAudioSync({
    audioRef,
    enabled: true,
    transcriptDurationMs,
    sessionId,
    playback,
    positionMs,
    speed,
  });
  const { tone, text } = describe(snapshot);
  const last = snapshot?.lastResync;

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-sm border px-3 py-2 text-sm ${TONE[tone]}`}
    >
      {/* preload=metadata: only the header until playback starts; seeking uses Range requests. */}
      <audio ref={audioRef} src={src} preload="metadata" muted={muted} className="hidden" />
      <span aria-hidden="true">🔊</span>
      <span className="flex-1" title={`In sync means within ${String(SYNC_TOLERANCE_MS)} ms.`}>
        {text}
        {snapshot && snapshot.resyncs > 0 && last && (
          <span className="ml-1 opacity-80">
            Resynced {String(snapshot.resyncs)}× (last: {describeDrift(last.driftMs)} at{' '}
            {formatDuration(last.atMs)}).
          </span>
        )}
      </span>
      {snapshot?.status === 'blocked' && (
        <button type="button" onClick={unblock} className={buttonClass('secondary')}>
          Enable audio
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          setMuted((m) => !m);
        }}
        aria-pressed={muted}
        className={buttonClass('ghost')}
      >
        {muted ? 'Unmute' : 'Mute'}
      </button>
    </div>
  );
}
