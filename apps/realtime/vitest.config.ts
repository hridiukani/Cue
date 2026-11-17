import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          // Creates a throwaway migrated database (see @cue/db/testing), drops it after.
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
