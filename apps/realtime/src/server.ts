import type { Db } from '@cue/db';
import { CLOSE_CODE } from '@cue/shared';
import websocket from '@fastify/websocket';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { TicketVerifier } from './auth/ticket-verifier';
import { type Clock, realClock } from './clock';
import type { RealtimeConfig } from './config';
import { SessionManager } from './session/session-manager';
import { GroqClient, type LlmClient } from '@cue/suggest';
import { handleConnection, type SocketLike } from './ws/connection';

export interface ServerDeps {
  db: Db;
  clock?: Clock;
  /** Override the LLM (tests). Default: Groq when GROQ_API_KEY is set, else suggestions off. */
  llm?: LlmClient | null;
  /** Readiness probe for the database (tests). Default: `select 1`. */
  checkDb?: () => Promise<void>;
}

/** How long /health/ready waits for the database before calling it unreachable. */
export const READY_DB_TIMEOUT_MS = 3000;

export interface RealtimeServer {
  app: FastifyInstance;
  manager: SessionManager;
}

export function buildServer(config: RealtimeConfig, deps: ServerDeps): RealtimeServer {
  const app = Fastify({ logger: { level: config.logLevel } });
  const clock = deps.clock ?? realClock;
  const llm =
    deps.llm !== undefined
      ? deps.llm
      : config.groq.apiKey
        ? new GroqClient({ apiKey: config.groq.apiKey, baseUrl: config.groq.baseUrl })
        : null;
  if (!llm) app.log.warn('GROQ_API_KEY is not set: replays run without suggestions');
  const manager = new SessionManager(deps.db, clock, app.log, {
    llm,
    config: { model: config.groq.model, ...config.suggestions },
  });
  const verifier = new TicketVerifier(config.ticketSecret, clock);
  const sockets = new Set<SocketLike>();

  // Liveness: cheap and database-free on purpose. Render's health check calls
  // it, and a paused Supabase project must not make Render restart us in a loop.
  app.get('/health', () => ({ status: 'ok' as const }));

  // Readiness, for people and the wake-up checklist (docs/deploy.md): can we
  // reach the database, and are suggestions on? 503 if the database isn't.
  const checkDb =
    deps.checkDb ??
    (async () => {
      await deps.db.execute(sql`select 1`);
    });
  app.get('/health/ready', async (_req, reply) => {
    const db = await withTimeout(checkDb(), READY_DB_TIMEOUT_MS).then(
      () => 'ok' as const,
      (err: unknown) => {
        app.log.warn({ err }, 'readiness: database unreachable');
        return 'unreachable' as const;
      },
    );
    const body = {
      status: db === 'ok' ? ('ok' as const) : ('degraded' as const),
      db,
      suggestions: llm ? ('on' as const) : ('off' as const),
    };
    return reply.code(db === 'ok' ? 200 : 503).send(body);
  });

  // Hard frame limit at the WebSocket layer; the protocol's own 16 KB limit
  // (with a clear 4413 close) is enforced in the message parser.
  void app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  void app.register((scoped, _opts, done) => {
    scoped.get(
      '/ws',
      {
        websocket: true,
        // Browsers always send Origin; refuse pages from other sites before upgrading.
        preValidation: async (req, reply) => {
          const origin = req.headers.origin;
          if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
            await reply.code(403).send({ error: 'origin not allowed' });
          }
        },
      },
      (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        handleConnection(socket, { db: deps.db, clock, manager, verifier, log: app.log });
      },
    );
    done();
  });

  // Graceful shutdown: save every session's position and keep it live, then
  // tell browsers to reconnect (1001 = going away).
  app.addHook('preClose', async () => {
    await manager.shutdown();
    for (const s of sockets) s.close(CLOSE_CODE.serverShutdown, 'server restarting');
  });

  return { app, manager };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
