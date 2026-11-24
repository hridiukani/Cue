import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

const resolve = {
  alias: {
    '@': path.resolve(here, 'src'),
    'server-only': path.resolve(here, 'test/stubs/server-only.ts'),
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        },
      },
      {
        resolve,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          // Creates a throwaway migrated database (see @cue/db/testing), drops it after.
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
