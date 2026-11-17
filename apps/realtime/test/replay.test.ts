import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createDb,
  type Db,
  getSession,
  listSessionUtterances,
  schema,
  upsertDataset,
  upsertRecording,
} from '@cue/db';
import { type ServerMessage, ServerMessageSchema } from '@cue/shared';
import { signTicket } from '@cue/shared/ticket';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import WebSocket from 'ws';
import { FakeClock } from '../src/clock';
import { loadConfig } from '../src/config';
import { buildServer, type RealtimeServer } from '../src/server';

/**
 * End-to-end: a real realtime server on a random port, real WebSocket
 * clients, and the throwaway Postgres. The fixture recording is ~1.1 s long so
 * 1x playback is fast.
 */

const SECRET = 'r'.repeat(32);
const FIXTURE = [
  { speaker: 'rep' as const, text: 'hello there friend', startedMs: 0, endedMs: 300 },
  { speaker: 'prospect' as const, text: 'hi how are you', startedMs: 400, endedMs: 700 },
  { speaker: 'rep' as const, text: 'doing great thanks', startedMs: 800, endedMs: 1100 },
];

let db: Db;
let closeDb: () => Promise<void>;
let recordingId: string;

beforeAll(async () => {
  ({ db, close: closeDb } = createDb(inject('testDatabaseUrl')));
  const datasetId = `test/${randomUUID()}`;
  await upsertDataset(db, {
    id: datasetId,
    name: 'Fixture',
    url: 'u',
    license: 'mit',
    revision: null,
  });
  recordingId = await upsertRecording(db, {
    datasetId,
    externalId: 'fixture-1',
    title: 'Fixture call',
    timing: 'real',
    hasAudio: false,
    language: 'en',
    metadata: {},
    utterances: FIXTURE,
  });
});
afterAll(() => closeDb());

async function makeUser(): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ email: `rt-${randomUUID()}@test.local` })
    .returning({ id: schema.users.id });
  if (!u) throw new Error('no user');
  return u.id;
}

function config() {
  return loadConfig({
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('testDatabaseUrl'),
    REALTIME_TICKET_SECRET: SECRET,
    REALTIME_PORT: '0',
  });
}

async function startServer(
  opts: { clock?: FakeClock } = {},
): Promise<{ server: RealtimeServer; url: string }> {
  const server = buildServer(config(), { db, ...(opts.clock ? { clock: opts.clock } : {}) });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = server.app.server.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${String(port)}/ws` };
}

/** A test client that records every server message and the close code. */
class Client {
  readonly messages: ServerMessage[] = [];
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => {
        resolve();
      });
      this.ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`upgrade refused: ${String(res.statusCode)}`));
      });
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code) => {
        this.closeCode = code;
        resolve(code);
      });
    });
    this.ws.on('message', (data: Buffer) => {
      this.messages.push(ServerMessageSchema.parse(JSON.parse(data.toString('utf8'))));
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }

  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  async waitFor(pred: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out waiting for ${label}; got ${JSON.stringify(this.messages.map((m) => m.type))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Open, authenticate, and wait for `ready`. */
  async hello(userId: string): Promise<this> {
    await this.opened;
    this.send({ type: 'hello', v: 1, ticket: signTicket(userId, SECRET) });
    await this.waitFor(() => this.of('ready').length === 1, 'ready');
    return this;
  }
}

const finalsText = (c: Client) => c.of('final').map((f) => f.text);

describe('replay over WebSocket', () => {
  it('streams interims and finals in order, saves each final, and ends the session', async () => {
    const { server, url } = await startServer();
    try {
      const user = await makeUser();
      const c = await new Client(url).hello(user);
      c.send({ type: 'start', recordingId, speed: '1x' });
      await c.waitFor(() => c.of('state').some((s) => s.state === 'ended'), 'ended');

      const [session] = c.of('session');
      expect(session).toMatchObject({
        recordingId,
        title: 'Fixture call',
        durationMs: 1100,
        timing: 'real',
      });
      expect(c.of('interim').length).toBeGreaterThan(0);
      expect(finalsText(c)).toEqual(FIXTURE.map((u) => u.text));
      // Every interim for an utterance arrives before its final.
      const firstFinal = c.messages.findIndex((m) => m.type === 'final');
      expect(c.messages.findIndex((m) => m.type === 'interim')).toBeLessThan(firstFinal);

      const saved = await listSessionUtterances(db, user, session?.sessionId ?? '');
      expect(saved.map((u) => u.text)).toEqual(FIXTURE.map((u) => u.text));
      // Save-before-send: every final's id is a saved utterance id.
      expect(c.of('final').map((f) => f.utteranceId)).toEqual(saved.map((u) => u.id));
      expect((await getSession(db, user, session?.sessionId ?? ''))?.status).toBe('ended');
      c.close();
    } finally {
      await server.app.close();
    }
  });

  it('resumes after the socket drops: snapshot of saved finals, then the rest, no duplicates', async () => {
    const { server, url } = await startServer();
    try {
      const user = await makeUser();
      const a = await new Client(url).hello(user);
      a.send({ type: 'start', recordingId, speed: '1x' });
      await a.waitFor(() => a.of('final').length >= 1, 'first final');
      const sessionId = a.of('session')[0]?.sessionId ?? '';
      a.close();
      await a.closed;
      await new Promise((r) => setTimeout(r, 200)); // let the server pause and save

      expect((await getSession(db, user, sessionId))?.status).toBe('live');

      const b = await new Client(url).hello(user);
      b.send({ type: 'resume', sessionId });
      await b.waitFor(() => b.of('snapshot').length === 1, 'snapshot');
      const snapshot = b.of('snapshot')[0]?.utterances ?? [];
      const savedBefore = await listSessionUtterances(db, user, sessionId);
      expect(snapshot.map((u) => u.utteranceId)).toEqual(savedBefore.map((u) => u.id));
      expect(b.of('state').at(-1)?.state).toBe('paused');

      b.send({ type: 'play' });
      await b.waitFor(() => b.of('state').some((s) => s.state === 'ended'), 'ended');
      const all = await listSessionUtterances(db, user, sessionId);
      expect(all.map((u) => u.text)).toEqual(FIXTURE.map((u) => u.text)); // each exactly once
      expect([...snapshot.map((u) => u.text), ...finalsText(b)]).toEqual(
        FIXTURE.map((u) => u.text),
      );
      b.close();
    } finally {
      await server.app.close();
    }
  });

  it('survives a server restart: the session stays live, resumes and finishes', async () => {
    const first = await startServer();
    const user = await makeUser();
    const a = await new Client(first.url).hello(user);
    a.send({ type: 'start', recordingId, speed: '1x' });
    await a.waitFor(() => a.of('final').length >= 1, 'first final');
    const sessionId = a.of('session')[0]?.sessionId ?? '';

    await first.server.app.close(); // graceful shutdown
    expect(await a.closed).toBe(1001);
    const afterShutdown = await getSession(db, user, sessionId);
    expect(afterShutdown?.status).toBe('live');
    expect(afterShutdown?.positionMs).toBeGreaterThanOrEqual(300);

    const second = await startServer();
    try {
      const b = await new Client(second.url).hello(user);
      b.send({ type: 'resume', sessionId });
      await b.waitFor(() => b.of('snapshot').length === 1, 'snapshot');
      b.send({ type: 'play' });
      await b.waitFor(() => b.of('state').some((s) => s.state === 'ended'), 'ended');
      const all = await listSessionUtterances(db, user, sessionId);
      expect(all.map((u) => u.text)).toEqual(FIXTURE.map((u) => u.text));
      b.close();
    } finally {
      await second.server.app.close();
    }
  });

  it('seeking backward starts a new session and leaves the old one untouched', async () => {
    const { server, url } = await startServer();
    try {
      const user = await makeUser();
      const c = await new Client(url).hello(user);
      c.send({ type: 'start', recordingId, speed: '1x' });
      await c.waitFor(() => c.of('final').length >= 2, 'two finals');
      const oldId = c.of('session')[0]?.sessionId ?? '';

      const oldSaved = (await listSessionUtterances(db, user, oldId)).map((u) => u.id);
      const seekAt = c.messages.length;
      c.send({ type: 'seek', positionMs: 0 });
      await c.waitFor(() => c.of('session').length === 2, 'new session');
      const newId = c.of('session')[1]?.sessionId ?? '';
      expect(newId).not.toBe(oldId);

      // The replaced session ends quietly: no "ended" reaches the browser before the new session.
      const newSessionAt = c.messages.findIndex((m, i) => i >= seekAt && m.type === 'session');
      const between = c.messages.slice(seekAt, newSessionAt);
      expect(between.some((m) => m.type === 'state' && m.state === 'ended')).toBe(false);

      // The old session is ended, and everything it saved is still there (append-only).
      const old = await getSession(db, user, oldId);
      expect(old?.status).toBe('ended');
      const oldAfter = (await listSessionUtterances(db, user, oldId)).map((u) => u.id);
      expect(oldAfter.slice(0, oldSaved.length)).toEqual(oldSaved);

      await c.waitFor(
        () => c.messages.slice(newSessionAt).some((m) => m.type === 'state' && m.state === 'ended'),
        'new session ended',
      );
      const fresh = await listSessionUtterances(db, user, newId);
      expect(fresh.map((u) => u.text)).toEqual(FIXTURE.map((u) => u.text));
      c.close();
    } finally {
      await server.app.close();
    }
  });

  it('plays the whole recording at instant speed', async () => {
    const { server, url } = await startServer();
    try {
      const user = await makeUser();
      const c = await new Client(url).hello(user);
      c.send({ type: 'start', recordingId, speed: 'instant' });
      await c.waitFor(() => c.of('state').some((s) => s.state === 'ended'), 'ended');
      expect(c.of('interim')).toHaveLength(0);
      expect(finalsText(c)).toEqual(FIXTURE.map((u) => u.text));
      c.close();
    } finally {
      await server.app.close();
    }
  });
});

describe('WebSocket auth and validation', () => {
  it('closes with 4401 for a bad ticket, and refuses a reused one', async () => {
    const { server, url } = await startServer();
    try {
      const bad = new Client(url);
      await bad.opened;
      bad.send({ type: 'hello', v: 1, ticket: 'v1.forged.ticket' });
      expect(await bad.closed).toBe(4401);

      const user = await makeUser();
      const ticket = signTicket(user, SECRET);
      const first = new Client(url);
      await first.opened;
      first.send({ type: 'hello', v: 1, ticket });
      await first.waitFor(() => first.of('ready').length === 1, 'ready');
      const second = new Client(url);
      await second.opened;
      second.send({ type: 'hello', v: 1, ticket });
      expect(await second.closed).toBe(4401);
      first.close();
    } finally {
      await server.app.close();
    }
  });

  it('closes with 4401 when a command arrives before hello', async () => {
    const { server, url } = await startServer();
    try {
      const c = new Client(url);
      await c.opened;
      c.send({ type: 'start', recordingId, speed: '1x' });
      expect(await c.closed).toBe(4401);
    } finally {
      await server.app.close();
    }
  });

  it("treats another user's session as not found (4404) and writes nothing to it", async () => {
    const { server, url } = await startServer();
    try {
      const alice = await makeUser();
      const bob = await makeUser();
      const a = await new Client(url).hello(alice);
      a.send({ type: 'start', recordingId, speed: 'instant' });
      await a.waitFor(() => a.of('final').length >= 1, 'final');
      const sessionId = a.of('session')[0]?.sessionId ?? '';
      a.close();

      const b = await new Client(url).hello(bob);
      b.send({ type: 'resume', sessionId });
      expect(await b.closed).toBe(4404);
      expect(b.of('snapshot')).toHaveLength(0);
    } finally {
      await server.app.close();
    }
  });

  it('answers a malformed message with an error and keeps the connection open', async () => {
    const { server, url } = await startServer();
    try {
      const c = await new Client(url).hello(await makeUser());
      c.send({ type: 'seek', positionMs: -5 });
      await c.waitFor(() => c.of('error').length === 1, 'error');
      expect(c.of('error')[0]?.code).toBe('bad_request');
      c.send({ type: 'ping' });
      await c.waitFor(() => c.of('pong').length === 1, 'pong');
      c.close();
    } finally {
      await server.app.close();
    }
  });

  it('closes with 4408 if hello never arrives', async () => {
    const clock = new FakeClock(Date.now());
    const { server, url } = await startServer({ clock });
    try {
      const c = new Client(url);
      await c.opened;
      await new Promise((r) => setTimeout(r, 50)); // let the server register the connection
      clock.advance(5000);
      expect(await c.closed).toBe(4408);
    } finally {
      await server.app.close();
    }
  });

  it('refuses the upgrade from a browser origin that is not allowed', async () => {
    const { server, url } = await startServer();
    try {
      const c = new Client(url, { origin: 'https://evil.example' });
      await expect(c.opened).rejects.toThrow(/403/);
    } finally {
      await server.app.close();
    }
  });
});
