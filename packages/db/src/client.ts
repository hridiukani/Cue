import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export interface CreateDbOptions {
  /**
   * Most connections this process may open (default: the driver's 10). On a
   * Supabase Session pooler each one holds a Postgres connection, so keep it
   * small per process (DATABASE_POOL_MAX, docs/deploy.md).
   */
  max?: number;
}

export function createDb(databaseUrl: string, opts: CreateDbOptions = {}) {
  const sql = postgres(databaseUrl, opts.max === undefined ? {} : { max: opts.max });
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
