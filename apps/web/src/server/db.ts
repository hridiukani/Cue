import 'server-only';
import { createDb, type Db } from '@cue/db';
import { serverConfig } from '@/config';

// One connection pool per server process. In dev, Next re-evaluates modules on
// every edit, so keep the pool on globalThis to avoid leaking connections.
const globalForDb = globalThis as unknown as { cueDb?: Db };

export function getDb(): Db {
  globalForDb.cueDb ??= createDb(serverConfig().databaseUrl).db;
  return globalForDb.cueDb;
}
