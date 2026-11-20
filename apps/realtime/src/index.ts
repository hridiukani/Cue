import { createDb } from '@cue/db';
import { loadConfig, loadEnvFileIfPresent } from './config';
import { buildServer } from './server';

loadEnvFileIfPresent();
const config = loadConfig();
const { db, close: closeDb } = createDb(config.databaseUrl, { max: config.databasePoolMax });
const { app, manager } = buildServer(config, { db });

const shutdown = (signal: NodeJS.Signals) => {
  app.log.info({ signal }, 'shutting down');
  // app.close() runs the preClose hook: sessions are saved and stay live.
  app
    .close()
    .then(() => closeDb())
    .then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error(err);
        process.exit(1);
      },
    );
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
  manager.startIdleCleanup();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
