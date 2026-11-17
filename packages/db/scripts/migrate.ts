import { loadDbConfig, loadRootEnvFile } from '../src/config';
import { runMigrations } from '../src/migrate';

loadRootEnvFile();
const { databaseUrl } = loadDbConfig();
await runMigrations(databaseUrl);
console.log('Migrations applied.');
