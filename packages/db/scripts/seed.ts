import { createDb } from '../src/client';
import { loadDbConfig, loadRootEnvFile } from '../src/config';
import { seedDemo } from '../src/seed';

loadRootEnvFile();
const { db, close } = createDb(loadDbConfig().databaseUrl);
try {
  const result = await seedDemo(db);
  console.log('Seeded demo data:', result);
} finally {
  await close();
}
