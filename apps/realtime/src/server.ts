import Fastify, { type FastifyInstance } from 'fastify';
import type { RealtimeConfig } from './config';

export function buildServer(config: RealtimeConfig): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });

  app.get('/health', () => ({ status: 'ok' as const }));

  return app;
}
