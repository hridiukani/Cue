import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl);
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
