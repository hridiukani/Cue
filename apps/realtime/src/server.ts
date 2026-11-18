import type { Db } from '@cue/db';
import { CLOSE_CODE } from '@cue/shared';
import websocket from '@fastify/websocket';
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
}

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

  app.get('/health', () => ({ status: 'ok' as const }));

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
