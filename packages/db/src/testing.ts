import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { loadTestDbConfig } from './config';
import { loadRootEnvFile } from './env-file';
import { runMigrations } from './migrate';

/**
 * TEST-ONLY helpers, exported as `@cue/db/testing` (not from the main entry,
 * so app code can't import them by accident).
 */

export interface TestDatabase {
  /** Connection URL of the freshly migrated throwaway database. */
  url: string;
  /** Drop the database (disconnecting anyone still connected). */
  drop: () => Promise<void>;
}

/**
 * Create an empty database with a random name on the TEST_DATABASE_URL server
 * and apply all migrations. Each test run gets its own database, so runs never
 * see each other's data.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  loadRootEnvFile();
  const adminUrl = loadTestDbConfig().databaseUrl;
  const dbName = `cue_test_${randomBytes(6).toString('hex')}`;

  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    await admin.end();
    throw new Error(`Could not create test database on ${redact(adminUrl)}. Is Postgres up?`, {
      cause: err,
    });
  }

  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${dbName}`;
  try {
    await runMigrations(testUrl.toString());
  } catch (err) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
    throw err;
  }

  return {
    url: testUrl.toString(),
    drop: async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

function redact(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}
