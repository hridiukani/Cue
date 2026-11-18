import {
  CLOSE_CODE,
  type FinalUtterance,
  type ServerMessage,
  type SessionState,
  type Speaker,
  type Speed,
} from '@cue/shared';

/**
 * UI state of the replay player, derived only from protocol messages and
 * socket events. A pure reducer, so every state the user can see is testable
 * without a browser.
 */

export type ConnectionStatus =
  | 'connecting' // opening the socket / authenticating
  | 'open' // ready
  | 'reconnecting' // dropped; retrying with backoff
  | 'offline' // gave up retrying; user can press Reconnect
  | 'not_found'; // the session no longer exists (or isn't ours)

export interface InterimLine {
  key: string;
  speaker: Speaker;
  text: string;
  startMs: number;
}

export interface Banner {
  level: 'info' | 'warning' | 'error';
  message: string;
  /** What the banner's button does, if it has one. */
  action?: 'retry' | 'reconnect' | 'restart';
}

export interface ReplayState {
  connection: ConnectionStatus;
  /** Reconnect attempt number (1-based) while reconnecting. */
  attempt: number;
  sessionId: string | null;
  /** 'idle' = no replay started yet in this page. */
  playback: SessionState | 'idle';
  positionMs: number;
  speed: Speed;
  durationMs: number;
  finals: FinalUtterance[];
  interims: Record<string, InterimLine>;
  banner: Banner | null;
}

export type ReplayAction =
  | { type: 'server'; message: ServerMessage }
  | { type: 'connecting' }
  | { type: 'socket_closed'; code: number; attempt: number; willRetry: boolean }
  | { type: 'gave_up' }
  | { type: 'dismiss_banner' };

export function initialReplayState(durationMs: number): ReplayState {
  return {
    connection: 'connecting',
    attempt: 0,
    sessionId: null,
    playback: 'idle',
    positionMs: 0,
    speed: '1x',
    durationMs,
    finals: [],
    interims: {},
    banner: null,
  };
}

/** Insert or replace by utteranceId, keeping timeline order. */
function upsertFinal(finals: FinalUtterance[], f: FinalUtterance): FinalUtterance[] {
  const rest = finals.filter((x) => x.utteranceId !== f.utteranceId);
  rest.push(f);
  return rest.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function withoutInterim(interims: Record<string, InterimLine>, key: string) {
  if (!(key in interims)) return interims;
  return Object.fromEntries(Object.entries(interims).filter(([k]) => k !== key));
}

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case 'connecting':
      return {
        ...state,
        connection: state.connection === 'reconnecting' ? 'reconnecting' : 'connecting',
      };

    case 'socket_closed': {
      // Interims are stale once the socket is gone; finals stay.
      const base = { ...state, interims: {} };
      if (action.code === CLOSE_CODE.notFound) {
        return {
          ...base,
          connection: 'not_found',
          banner: {
            level: 'error',
            message: 'This replay is no longer available.',
            action: 'restart',
          },
        };
      }
      if (!action.willRetry) return base;
      return {
        ...base,
        connection: 'reconnecting',
        attempt: action.attempt,
        banner: {
          level: 'warning',
          message:
            action.code === CLOSE_CODE.serverShutdown
              ? `The server is restarting. Reconnecting (attempt ${String(action.attempt)})…`
              : action.code === CLOSE_CODE.clientTooSlow
                ? `Your connection couldn't keep up. Reconnecting (attempt ${String(action.attempt)})…`
                : `Connection lost. Reconnecting (attempt ${String(action.attempt)})…`,
        },
      };
    }

    case 'gave_up':
      return {
        ...state,
        connection: 'offline',
        interims: {},
        banner: { level: 'error', message: "Can't reach the replay server.", action: 'reconnect' },
      };

    case 'dismiss_banner':
      return { ...state, banner: null };

    case 'server':
      return onServerMessage(state, action.message);
  }
}

function onServerMessage(state: ReplayState, m: ServerMessage): ReplayState {
  switch (m.type) {
    case 'ready':
      return {
        ...state,
        connection: 'open',
        attempt: 0,
        // A reconnect banner is resolved once we're back.
        banner: state.banner?.level === 'warning' ? null : state.banner,
      };

    case 'session':
      if (m.sessionId === state.sessionId) return { ...state, durationMs: m.durationMs };
      // A different session (new replay, or a backward seek): start a fresh transcript.
      return {
        ...state,
        sessionId: m.sessionId,
        durationMs: m.durationMs,
        finals: [],
        interims: {},
        banner: state.banner?.action === 'restart' ? null : state.banner,
      };

    case 'snapshot':
      return {
        ...state,
        finals: [...m.utterances].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
        interims: {},
      };

    case 'state':
      return {
        ...state,
        playback: m.state,
        positionMs: m.positionMs,
        speed: m.speed,
        interims: m.state === 'playing' ? state.interims : {},
        banner:
          m.state === 'failed'
            ? { level: 'error', message: 'This replay failed.', action: 'restart' }
            : state.banner,
      };

    case 'interim':
      return {
        ...state,
        interims: {
          ...state.interims,
          [m.key]: { key: m.key, speaker: m.speaker, text: m.text, startMs: m.startMs },
        },
      };

    case 'final': {
      const final: FinalUtterance = {
        utteranceId: m.utteranceId,
        speaker: m.speaker,
        key: m.key,
        text: m.text,
        startMs: m.startMs,
        endMs: m.endMs,
      };
      return {
        ...state,
        finals: upsertFinal(state.finals, final),
        interims: withoutInterim(state.interims, m.key),
      };
    }

    case 'status':
      if (m.code === 'persist_failed') {
        return { ...state, banner: { level: 'error', message: m.message, action: 'retry' } };
      }
      return { ...state, banner: { level: m.level, message: m.message } };

    case 'error':
      return {
        ...state,
        banner: {
          level: m.code === 'bad_request' ? 'warning' : 'error',
          message: m.message,
          ...(m.code === 'invalid_state' || m.code === 'not_found'
            ? { action: 'restart' as const }
            : {}),
        },
      };

    case 'pong':
      return state;
  }
}

// ------------------------------------------------------------------ reconnect

export const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Delay before reconnect attempt `attempt` (1-based): 0.5 s doubling up to
 * 10 s, with jitter (50–100 %) so many clients don't reconnect in lockstep
 * after a server restart.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}

/** Whether a close code means "try again" (vs. a final answer). */
export function shouldReconnect(code: number): boolean {
  // 1000 = we closed it on purpose; 4404 = session gone (a final answer).
  // 4401 (bad/expired/reused ticket) IS retried: each attempt fetches a fresh ticket,
  // and if the user is really signed out, fetching the ticket redirects to /signin.
  return code !== 1000 && code !== CLOSE_CODE.notFound;
}
