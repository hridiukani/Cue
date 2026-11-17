import { defineConfig } from 'drizzle-kit';
import { loadDbConfig } from './src/config';

// drizzle-kit is run by hand, so pick up the repo-root .env if there is one.
try {
  process.loadEnvFile('../../.env');
} catch {
  // No .env file: fall back to the real environment.
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: loadDbConfig().databaseUrl },
});
