import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { extractClientKey } from '../limiter/key-extractor.js';
import type { Dispatcher } from '../limiter/dispatcher.js';
import type { KeyExtractor } from '../types/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    dispatcher: Dispatcher;
    rateLimitConfig: RateLimitConfig;
  }
}

export interface RateLimitConfig {
  keyExtractor: KeyExtractor;
  keyHeader?: string;
  failStrategy: 'open' | 'closed';
}

// Paths that bypass rate limiting entirely (internal/infra endpoints)
const SKIP_ROUTES = new Set([
  'GET:/healthz', 'GET:/readyz', 'GET:/metrics',
  'POST:/api/v1/check',   // handled internally with HMAC auth
  'GET:/api/v1/tenants',  'POST:/api/v1/tenants',
  'DELETE:/api/v1/tenants',
  'POST:/api/v1/allowlist', 'DELETE:/api/v1/allowlist',
  'POST:/api/v1/denylist',  'DELETE:/api/v1/denylist',
]);

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.routeOptions.url ?? '/';
    const route = `${req.method}:${url}`;

    // Skip internal and admin routes — zero Redis overhead
    if (SKIP_ROUTES.has(route) || url.startsWith('/api/v1/tenants/')) return;

    const { keyExtractor, keyHeader, failStrategy } = app.rateLimitConfig;

    const clientKey = extractClientKey(req, keyExtractor, keyHeader);
    const tenantId = (req.headers['x-tenant-id'] as string | undefined) ?? 'default';

    let result;
    try {
      result = await app.dispatcher.check({ tenantId, route, clientKey });
    } catch {
      if (failStrategy === 'closed') {
        return reply.code(503).send({ error: 'Service unavailable' });
      }
      return; // fail-open: let request through
    }

    reply.header('X-RateLimit-Limit', String(result.limit));
    reply.header('X-RateLimit-Remaining', String(result.remaining));
    reply.header('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      // 10% jitter on Retry-After to prevent thundering herd
      const jitter = Math.floor(Math.random() * Math.max(1, result.retryAfter * 0.1));
      const retryAfter = result.retryAfter + jitter;
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: 'Too Many Requests',
        ruleId: result.ruleId,
        limit: result.limit,
        retryAfter,
      });
    }
  });
};

export const rateLimitPlugin = fp(plugin, { name: 'rate-limit' });
