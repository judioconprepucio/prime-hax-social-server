import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { getPool } from './db.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chat.js';
import { socialRoutes } from './routes/social.js';

export async function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: true,
    bodyLimit: 32 * 1024
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });

  app.get('/health', async (_request, reply) => {
    try {
      await getPool().query('SELECT 1');
      return { status: 'ok', service: 'prime-hax-social' };
    } catch (error) {
      app.log.error({ err: error }, 'database health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(socialRoutes, { prefix: '/v1/social' });
  await app.register(chatRoutes, { prefix: '/v1/social' });

  app.setErrorHandler((error, request, reply) => {
    if (error.validation) return reply.code(400).send({ error: 'invalid_request' });
    request.log.error({ err: error }, 'request failed');
    return reply.code(error.statusCode >= 400 ? error.statusCode : 500).send({ error: 'server_error' });
  });

  return app;
}
