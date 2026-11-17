import { defineConfig } from 'drizzle-kit';
import { loadDbConfig } from './src/config';
import { loadRootEnvFile } from './src/env-file';

// drizzle-kit is run by hand, so pick up the repo-root .env if there is one.
loadRootEnvFile();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: loadDbConfig().databaseUrl },
});
