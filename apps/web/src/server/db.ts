import 'server-only';
import { createDb, type Db } from '@cue/db';
import { serverConfig } from '@/config';

// One connection pool per server process. In dev, Next re-evaluates modules on
// every edit, so keep the pool on globalThis to avoid leaking connections.
const globalForDb = globalThis as unknown as { cueDb?: Db };

export function getDb(): Db {
  const { databaseUrl, databasePoolMax } = serverConfig();
  globalForDb.cueDb ??= createDb(databaseUrl, { max: databasePoolMax }).db;
  return globalForDb.cueDb;
}
