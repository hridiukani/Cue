import { loadDbConfig } from '../src/config';
import { loadRootEnvFile } from '../src/env-file';
import { runMigrations } from '../src/migrate';

loadRootEnvFile();
const { databaseUrl } = loadDbConfig();
await runMigrations(databaseUrl);
console.log('Migrations applied.');
