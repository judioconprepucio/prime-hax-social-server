import { buildApp } from './app.js';
import { closePool } from './db.js';
import { serverConfig } from './config.js';

const config = serverConfig();
const app = await buildApp();

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closePool();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await closePool();
  process.exit(1);
}
