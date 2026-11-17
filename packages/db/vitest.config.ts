import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          // Creates a throwaway database, migrates it, and drops it afterwards.
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
