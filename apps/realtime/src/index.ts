import { loadConfig, loadEnvFileIfPresent } from './config';
import { buildServer } from './server';

loadEnvFileIfPresent();
const config = loadConfig();
const app = buildServer(config);

const shutdown = (signal: NodeJS.Signals) => {
  app.log.info({ signal }, 'shutting down');
  app.close().then(
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
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
