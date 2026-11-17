import { defineConfig } from 'drizzle-kit';
import { loadDbConfig, loadRootEnvFile } from './src/config';

// drizzle-kit is run by hand, so pick up the repo-root .env if there is one.
loadRootEnvFile();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: loadDbConfig().databaseUrl },
});
