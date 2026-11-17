import { type Db, getSessionUser } from '@cue/db';
import {
  CLOSE_CODE,
  type ClientMessage,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ServerMessageBody,
} from '@cue/shared';
import type { TicketVerifier } from '../auth/ticket-verifier';
import type { Clock } from '../clock';
import type { ReplaySession, Sink } from '../session/replay-session';
import type { SessionManager } from '../session/session-manager';

export const HELLO_TIMEOUT_MS = 5000;

/**
 * The parts of a `ws` WebSocket we use. Structural, so it doesn't matter which
 * copy of the `ws` package created the socket (fastify-websocket ships its own).
 */
export interface SocketLike {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

export interface ConnectionDeps {
  db: Db;
  clock: Clock;
  manager: SessionManager;
  verifier: TicketVerifier;
  log: { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
}

function frameToString(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data) && data.every((d) => Buffer.isBuffer(d))) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return null;
}

/**
 * One browser WebSocket. Flow: hello (ticket) → ready → start | resume → a
 * stream of session events. All inbound frames are validated; the user id
 * always comes from the verified ticket, never from a message.
 */
export function handleConnection(socket: SocketLike, deps: ConnectionDeps): void {
  let seq = 0;
  let userId: string | null = null;
  let session: ReplaySession | null = null;
  let closed = false;

  const send = (body: ServerMessageBody): void => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ ...body, seq: seq++, serverTs: deps.clock.now() }));
  };
  const close = (code: number, reason: string): void => {
    if (!closed) socket.close(code, reason);
  };
  const sink: Sink = { send, bufferedBytes: () => socket.bufferedAmount, close };
  const fail = (
    code: 'bad_request' | 'not_found' | 'invalid_state' | 'internal',
    message: string,
  ) => {
    send({ type: 'error', code, message });
  };

  const helloTimer = deps.clock.setTimeout(() => {
    if (!userId) close(CLOSE_CODE.helloTimeout, 'no hello');
  }, HELLO_TIMEOUT_MS);

  const switchTo = async (next: ReplaySession): Promise<void> => {
    if (session && session !== next) await session.detach();
    session = next;
    next.attach(sink);
    send({
      type: 'session',
      sessionId: next.id,
      recordingId: next.info.recordingId,
      title: next.info.title,
      durationMs: next.info.durationMs,
      timing: next.info.timing,
      capabilities: next.capabilities,
    });
  };

  const onHello = async (ticket: string): Promise<void> => {
    if (userId) {
      fail('bad_request', 'already authenticated');
      return;
    }
    const check = deps.verifier.check(ticket);
    if (!check.ok) {
      close(CLOSE_CODE.unauthorized, `ticket ${check.reason}`);
      return;
    }
    // The ticket is valid, but is the user still there?
    if (!(await getSessionUser(deps.db, check.userId))) {
      close(CLOSE_CODE.unauthorized, 'unknown user');
      return;
    }
    deps.clock.clearTimeout(helloTimer);
    userId = check.userId;
    send({ type: 'ready', v: PROTOCOL_VERSION });
  };

  const onStart = async (uid: string, msg: Extract<ClientMessage, { type: 'start' }>) => {
    const r = await deps.manager.start(uid, msg.recordingId, msg.speed, msg.positionMs ?? 0);
    if (!r.ok) {
      fail(
        'not_found',
        r.error === 'empty_recording'
          ? 'This recording has no transcript.'
          : 'Recording not found.',
      );
      return;
    }
    await switchTo(r.session);
    r.session.sendState();
  };

  const onResume = async (uid: string, sessionId: string) => {
    const r = await deps.manager.resume(uid, sessionId);
    if (!r.ok) {
      // Missing and someone else's look the same (never reveal another user's session).
      if (r.error === 'not_found') close(CLOSE_CODE.notFound, 'session not found');
      else if (r.error === 'not_live')
        fail('invalid_state', 'This replay has ended. Start a new one.');
      else fail('invalid_state', 'The recording for this replay is no longer available.');
      return;
    }
    await switchTo(r.session);
    send({
      type: 'snapshot',
      utterances: r.saved.map((u) => ({
        utteranceId: u.id,
        speaker: u.speaker,
        key: `saved-${u.id}`,
        text: u.text,
        startMs: u.startedMs,
        endMs: u.endedMs,
      })),
    });
    send({
      type: 'status',
      level: 'info',
      code: 'session_resumed',
      message: 'Reconnected. Press play to continue.',
      retryable: false,
    });
    r.session.sendState();
  };

  const onSeek = async (uid: string, current: ReplaySession, positionMs: number) => {
    if (positionMs >= current.positionMs) {
      current.seekForward(positionMs);
      return;
    }
    // Backward: utterances are append-only, so this becomes a new session.
    const wasPlaying = current.state === 'playing';
    const r = await deps.manager.restartFrom(current, uid, positionMs, '1x');
    if (!r.ok) {
      fail('not_found', 'Recording not found.');
      return;
    }
    session = null;
    await switchTo(r.session);
    if (!wasPlaying) r.session.pause();
    r.session.sendState();
  };

  const handle = async (msg: ClientMessage): Promise<void> => {
    if (msg.type === 'hello') {
      await onHello(msg.ticket);
      return;
    }
    if (!userId) {
      close(CLOSE_CODE.unauthorized, 'hello first');
      return;
    }
    const uid = userId;
    if (msg.type === 'ping') {
      send({ type: 'pong' });
      return;
    }
    if (msg.type === 'start') {
      await onStart(uid, msg);
      return;
    }
    if (msg.type === 'resume') {
      await onResume(uid, msg.sessionId);
      return;
    }
    const current = session;
    if (!current) {
      fail('invalid_state', 'No replay is running.');
      return;
    }
    if (msg.type === 'play') current.play();
    else if (msg.type === 'pause') current.pause();
    else if (msg.type === 'setSpeed') current.setSpeed(msg.speed);
    else await onSeek(uid, current, msg.positionMs);
  };

  // Process messages one at a time, in order.
  let chain = Promise.resolve();
  socket.on('message', (data, isBinary) => {
    const raw = isBinary ? null : frameToString(data);
    if (raw === null) {
      close(CLOSE_CODE.unauthorized, 'only text frames are accepted');
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      if (parsed.error === 'message too large')
        close(CLOSE_CODE.messageTooLarge, 'message too large');
      else if (!userId) close(CLOSE_CODE.unauthorized, 'hello first');
      else fail('bad_request', parsed.error);
      return;
    }
    chain = chain
      .then(() => handle(parsed.message))
      .catch((err: unknown) => {
        deps.log.error({ err }, 'websocket handler failed');
        fail('internal', 'Something went wrong.');
      });
  });

  socket.on('close', () => {
    closed = true;
    deps.clock.clearTimeout(helloTimer);
    const current = session;
    session = null;
    // Pause and save; the session stays live so the browser can resume.
    if (current) chain = chain.then(() => current.detach()).catch(() => undefined);
  });
}
