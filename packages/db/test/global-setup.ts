import type { TestProject } from 'vitest/node';
import { createTestDatabase } from '../src/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

/** Create and migrate a throwaway database before the integration tests; drop it after. */
export default async function setup(project: TestProject) {
  const testDb = await createTestDatabase();
  project.provide('testDatabaseUrl', testDb.url);
  return testDb.drop;
}
