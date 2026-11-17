import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { runMigrations } from '../src/migrate';
import { connectTestDb } from './helpers';

const { db, close } = connectTestDb();
afterAll(close);

describe('migrations', () => {
  it('create all tables in the empty throwaway database', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`);
    expect(rows.map((r) => r.table_name)).toEqual([
      'auth_accounts',
      'call_summaries',
      'calls',
      'datasets',
      'playbooks',
      'recording_audio',
      'recording_utterances',
      'recordings',
      'suggestion_feedback',
      'suggestions',
      'users',
      'utterances',
    ]);
  });

  it('create the enum types', async () => {
    const rows = await db.execute<{ typname: string }>(sql`
      select typname from pg_type where typtype = 'e' order by typname`);
    expect(rows.map((r) => r.typname)).toEqual([
      'call_mode',
      'call_status',
      'feedback_signal',
      'speaker',
      'suggestion_status',
      'timing',
    ]);
  });

  it('are idempotent: running them again is a no-op', async () => {
    const count = async () =>
      (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
        )
      )[0]?.n;
    const before = await count();
    await runMigrations(inject('testDatabaseUrl'));
    expect(await count()).toBe(before);
    expect(before).toBeGreaterThan(0);
  });
});
