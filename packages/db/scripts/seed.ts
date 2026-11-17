import { createDb } from '../src/client';
import { loadDbConfig } from '../src/config';
import { loadRootEnvFile } from '../src/env-file';
import { seedDemo } from '../src/seed';

loadRootEnvFile();
const { db, close } = createDb(loadDbConfig().databaseUrl);
try {
  const result = await seedDemo(db);
  console.log('Seeded demo data:', result);
} finally {
  await close();
}
