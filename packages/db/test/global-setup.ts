import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { loadRootEnvFile, loadTestDbConfig } from '../src/config';
import { runMigrations } from '../src/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

/**
 * Before the integration tests: create an empty database with a random name on
 * the TEST_DATABASE_URL server and apply all migrations to it. After: drop it.
 * Each run gets its own database, so runs never see each other's data.
 */
export default async function setup(project: TestProject) {
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
  await runMigrations(testUrl.toString());
  project.provide('testDatabaseUrl', testUrl.toString());

  return async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  };
}

function redact(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}
