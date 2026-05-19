import type { FastifyPluginAsync } from 'fastify';
import type { RedisStore } from '../store/redis.js';

declare module 'fastify' {
  interface FastifyInstance {
    redisStore: RedisStore;
  }
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', { logLevel: 'warn' }, async (_req, reply) => {
    return reply.send({ status: 'ok' });
  });

  app.get('/readyz', { logLevel: 'warn' }, async (_req, reply) => {
    try {
      await app.redisStore.raw.ping();
      return reply.send({ redis: 'ok' });
    } catch {
      return reply.code(503).send({ redis: 'unavailable' });
    }
  });
};
