import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { createDb } from '../src/client';
import { getPgError, PG_ERROR, type PgErrorInfo } from '../src/errors';
import { calls, playbooks, suggestions, users, utterances } from '../src/schema';

/** Connect to this run's throwaway database (created in global-setup.ts). */
export function connectTestDb() {
  return createDb(inject('testDatabaseUrl'));
}

export type TestDb = ReturnType<typeof connectTestDb>['db'];

/**
 * Run `fn` and return the Postgres error code it failed with (e.g. '23505'),
 * plus the constraint name. Rethrows anything that isn't a Postgres error.
 */
export async function pgError(fn: () => Promise<unknown>): Promise<PgErrorInfo> {
  try {
    await fn();
  } catch (err) {
    const info = getPgError(err);
    if (info) return info;
    throw err;
  }
  throw new Error('expected the query to fail, but it succeeded');
}

// Postgres error codes used in assertions.
export const PG = PG_ERROR;

// Factories: each creates the minimum valid row, isolated by unique values so
// tests can run in parallel against the same database.

export async function makeUser(db: TestDb) {
  const [row] = await db
    .insert(users)
    .values({ email: `user-${randomUUID()}@test.local`, name: 'Test User' })
    .returning();
  return required(row);
}

export async function makePlaybook(db: TestDb, userId: string) {
  const [row] = await db
    .insert(playbooks)
    .values({
      userId,
      name: 'Test playbook',
      productDescription: 'A product',
      idealCustomer: 'Someone',
    })
    .returning();
  return required(row);
}

export async function makeCall(db: TestDb, userId: string, playbookId: string | null = null) {
  const [row] = await db
    .insert(calls)
    .values({ userId, playbookId, title: 'Test call', startedAt: new Date() })
    .returning();
  return required(row);
}

export async function makeUtterance(db: TestDb, callId: string) {
  const [row] = await db
    .insert(utterances)
    .values({ callId, speaker: 'prospect', text: 'Hello?', startedMs: 0, endedMs: 900 })
    .returning();
  return required(row);
}

export async function makeSuggestion(db: TestDb, callId: string, utteranceId: string) {
  const [row] = await db
    .insert(suggestions)
    .values({ callId, utteranceId, model: 'test-model', promptVersion: 'test-v1' })
    .returning();
  return required(row);
}

function required<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('insert returned no row');
  return row;
}
