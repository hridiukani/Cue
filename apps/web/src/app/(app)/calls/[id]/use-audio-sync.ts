'use client';

import type { Speed } from '@cue/shared';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { AudioSync, type AudioSyncSnapshot, type Timeline } from '@/lib/audio-sync';

const TICK_MS = 250;
/** Media events that change what the indicator should say: re-check at once. */
const MEDIA_EVENTS = ['waiting', 'playing', 'seeked', 'canplay', 'stalled', 'error', 'ended'];

/** Re-render only when something the rep can see changed (drift in 10 ms steps). */
function sameView(a: AudioSyncSnapshot | null, b: AudioSyncSnapshot): boolean {
  const round = (ms: number | null) => (ms === null ? null : Math.round(ms / 10));
  return (
    a !== null &&
    a.status === b.status &&
    round(a.driftMs) === round(b.driftMs) &&
    a.resyncs === b.resyncs
  );
}

/**
 * Drives an <audio> element from the replay's transcript timeline (the
 * server's `state` messages). The audio never sends anything to the server:
 * play, pause, seek and speed go to the server, and the audio follows what
 * the server reports, so both share one timeline.
 */
export function useAudioSync(opts: {
  audioRef: RefObject<HTMLAudioElement | null>;
  enabled: boolean;
  transcriptDurationMs: number;
  sessionId: string | null;
  playback: Timeline['playback'];
  positionMs: number;
  speed: Speed;
}) {
  const { audioRef, enabled, transcriptDurationMs, sessionId, playback, positionMs, speed } = opts;
  const syncRef = useRef<AudioSync | null>(null);
  const [snapshot, setSnapshot] = useState<AudioSyncSnapshot | null>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!enabled || !el) return;
    const sync = new AudioSync(el, performance, { transcriptDurationMs });
    syncRef.current = sync;
    const tick = () => {
      const next = sync.tick();
      setSnapshot((prev) => (sameView(prev, next) ? prev : next));
    };
    const timer = setInterval(tick, TICK_MS);
    for (const e of MEDIA_EVENTS) el.addEventListener(e, tick);
    return () => {
      clearInterval(timer);
      for (const e of MEDIA_EVENTS) el.removeEventListener(e, tick);
      el.pause();
      syncRef.current = null;
    };
  }, [audioRef, enabled, transcriptDurationMs]);

  // Every server state (and every new session) re-anchors the audio.
  useEffect(() => {
    syncRef.current?.setTimeline({ playback, positionMs, speed });
  }, [enabled, sessionId, playback, positionMs, speed]);

  const unblock = useCallback(() => {
    syncRef.current?.unblock();
  }, []);

  return { snapshot, unblock };
}
