import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type Db, schema } from '@cue/db';
import { type ServerMessage, ServerMessageSchema } from '@cue/shared';
import { signTicket } from '@cue/shared/ticket';
import { inject } from 'vitest';
import WebSocket from 'ws';
import type { Clock } from '../src/clock';
import { loadConfig } from '../src/config';
import { buildServer, type RealtimeServer } from '../src/server';
import type { LlmClient } from '@cue/suggest';

/** Shared helpers for the realtime integration tests. */

export const TEST_TICKET_SECRET = 'r'.repeat(32);

export async function makeUser(db: Db): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ email: `rt-${randomUUID()}@test.local` })
    .returning({ id: schema.users.id });
  if (!u) throw new Error('no user');
  return u.id;
}

export function testConfig(env: Record<string, string> = {}) {
  return loadConfig({
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('testDatabaseUrl'),
    REALTIME_TICKET_SECRET: TEST_TICKET_SECRET,
    REALTIME_PORT: '0',
    ...env,
  });
}

/** Start a real realtime server on a random port. */
export async function startServer(
  db: Db,
  opts: { clock?: Clock; llm?: LlmClient | null; env?: Record<string, string> } = {},
): Promise<{ server: RealtimeServer; url: string }> {
  const server = buildServer(testConfig(opts.env), {
    db,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.llm !== undefined ? { llm: opts.llm } : {}),
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = server.app.server.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${String(port)}/ws` };
}

/** A test client that records every server message and the close code. */
export class Client {
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
    this.send({ type: 'hello', v: 1, ticket: signTicket(userId, TEST_TICKET_SECRET) });
    await this.waitFor(() => this.of('ready').length === 1, 'ready');
    return this;
  }
}
