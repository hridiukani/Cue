'use client';

import {
  type ClientMessage,
  type FeedbackSignal,
  parseServerMessage,
  PROTOCOL_VERSION,
  type Speed,
} from '@cue/shared';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import {
  initialReplayState,
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
  replayReducer,
  shouldReconnect,
} from '@/lib/replay-state';

/**
 * Owns the realtime WebSocket for one replay page.
 *
 * - Every (re)connect fetches a fresh single-use ticket from a server action.
 *   If the user is signed out, that action redirects to /signin.
 * - After `ready`: resume the current session if there is one, otherwise wait
 *   for the user to press Start.
 * - Unexpected closes retry with backoff; the server keeps the session paused
 *   and sends a snapshot of saved utterances on resume.
 */
export function useReplay(opts: {
  recordingId: string;
  wsUrl: string;
  durationMs: number;
  getTicket: () => Promise<string>;
}) {
  const { recordingId, wsUrl, durationMs, getTicket } = opts;
  const [state, dispatch] = useReducer(replayReducer, durationMs, initialReplayState);

  // Shared between the connection lifecycle (effect) and the controls.
  const socketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingStartRef = useRef<{ speed: Speed; playbookId: string | null } | null>(null);
  const reconnectRef = useRef<() => void>(() => undefined);
  /** When each completed suggestion arrived (performance.now()), to measure time-to-paint. */
  const completedAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    let disposed = false;
    const isDisposed = () => disposed; // a call, so TS doesn't narrow across awaits
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (msg: ClientMessage) => {
      const s = socketRef.current;
      if (s?.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
    };

    const scheduleRetry = (code: number) => {
      attempt += 1;
      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        dispatch({ type: 'gave_up' });
        return;
      }
      dispatch({ type: 'socket_closed', code, attempt, willRetry: true });
      retryTimer = setTimeout(() => void connect(), reconnectDelayMs(attempt));
    };

    async function connect(): Promise<void> {
      dispatch({ type: 'connecting' });
      let ticket: string;
      try {
        ticket = await getTicket();
      } catch {
        // Couldn't reach the web server: treat like a dropped socket.
        if (!isDisposed()) scheduleRetry(1006);
        return;
      }
      if (isDisposed()) return;

      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(
          JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, ticket } satisfies ClientMessage),
        );
      };
      socket.onmessage = (ev: MessageEvent<string>) => {
        const parsed = parseServerMessage(ev.data);
        if (!parsed.ok) return; // ignore anything that isn't our protocol
        const m = parsed.message;
        if (m.type === 'ready') {
          attempt = 0;
          const pending = pendingStartRef.current;
          if (sessionIdRef.current) send({ type: 'resume', sessionId: sessionIdRef.current });
          else if (pending) {
            pendingStartRef.current = null;
            send({
              type: 'start',
              recordingId,
              speed: pending.speed,
              ...(pending.playbookId ? { playbookId: pending.playbookId } : {}),
            });
          }
        }
        if (m.type === 'session') sessionIdRef.current = m.sessionId;
        if (m.type === 'suggestionCompleted') {
          completedAtRef.current.set(m.suggestionId, performance.now());
        }
        dispatch({ type: 'server', message: m });
      };
      socket.onclose = (ev) => {
        if (socketRef.current === socket) socketRef.current = null;
        if (isDisposed()) return;
        if (ev.code === 4404) sessionIdRef.current = null; // gone: the next Start begins fresh
        if (shouldReconnect(ev.code)) scheduleRetry(ev.code);
        else dispatch({ type: 'socket_closed', code: ev.code, attempt, willRetry: false });
      };
    }

    reconnectRef.current = () => {
      attempt = 0;
      if (retryTimer) clearTimeout(retryTimer);
      void connect();
    };
    void connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close(1000, 'page closed');
      socketRef.current = null;
    };
  }, [getTicket, recordingId, wsUrl]);

  const controls = useMemo(() => {
    const send = (msg: ClientMessage) => {
      const s = socketRef.current;
      if (s?.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
    };
    return {
      start: (speed: Speed, playbookId: string | null = null) => {
        sessionIdRef.current = null;
        const open = socketRef.current?.readyState === WebSocket.OPEN;
        if (open) {
          send({ type: 'start', recordingId, speed, ...(playbookId ? { playbookId } : {}) });
        } else {
          pendingStartRef.current = { speed, playbookId }; // sent as soon as we're connected
        }
      },
      sendFeedback: (suggestionId: string, signal: FeedbackSignal) => {
        send({ type: 'feedback', suggestionId, signal });
      },
      /**
       * Call once a completed suggestion is on screen. Reports how long it took
       * to paint since it arrived, measured on this browser's clock only.
       */
      reportRendered: (suggestionId: string) => {
        const arrivedAt = completedAtRef.current.get(suggestionId);
        if (arrivedAt === undefined) return;
        completedAtRef.current.delete(suggestionId);
        const renderDelayMs = Math.max(0, Math.round(performance.now() - arrivedAt));
        send({ type: 'suggestionRendered', suggestionId, renderDelayMs });
        dispatch({ type: 'suggestion_rendered', suggestionId, renderDelayMs });
      },
      play: () => {
        send({ type: 'play' });
      },
      pause: () => {
        send({ type: 'pause' });
      },
      seek: (positionMs: number) => {
        send({ type: 'seek', positionMs: Math.max(0, Math.round(positionMs)) });
      },
      setSpeed: (speed: Speed) => {
        send({ type: 'setSpeed', speed });
      },
      reconnectNow: () => {
        reconnectRef.current();
      },
      dismissBanner: () => {
        dispatch({ type: 'dismiss_banner' });
      },
    };
  }, [recordingId]);

  return { state, ...controls };
}
