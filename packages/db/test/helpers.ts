import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { createDb } from '../src/client';
import { calls, playbooks, suggestions, users, utterances } from '../src/schema';

/** Connect to this run's throwaway database (created in global-setup.ts). */
export function connectTestDb() {
  return createDb(inject('testDatabaseUrl'));
}

export type TestDb = ReturnType<typeof connectTestDb>['db'];

/**
 * Run `fn` and return the Postgres error code it failed with (e.g. '23505'),
 * plus the constraint name. Drizzle wraps driver errors, so walk `.cause`.
 */
export async function pgError(
  fn: () => Promise<unknown>,
): Promise<{ code: string; constraint: string | undefined }> {
  try {
    await fn();
  } catch (err) {
    let e: unknown = err;
    while (e instanceof Error) {
      if ('code' in e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
        const constraint =
          'constraint_name' in e && typeof e.constraint_name === 'string'
            ? e.constraint_name
            : undefined;
        return { code: e.code, constraint };
      }
      e = e.cause;
    }
    throw err;
  }
  throw new Error('expected the query to fail, but it succeeded');
}

// Postgres error codes used in assertions.
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  invalidTextRepresentation: '22P02', // e.g. a value not in an enum
} as const;

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
