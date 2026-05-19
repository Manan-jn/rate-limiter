import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { RuleSchema, TenantSchema, CheckRequestSchema } from '../config/model.js';
import type { Rule } from '../types/index.js';
import { CONFIG_CHANNEL, type ConfigUpdateEvent } from '../config/watcher.js';

const ADMIN_TOKEN = process.env['ADMIN_TOKEN'] ?? '';
const CHECK_SECRET = process.env['CHECK_SECRET'] ?? '';

function bearerAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const auth = req.headers.authorization;
  if (!auth || !ADMIN_TOKEN) {
    void reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  const token = auth.replace('Bearer ', '');
  // Constant-time comparison to prevent timing attacks
  const expected = Buffer.from(ADMIN_TOKEN);
  const provided = Buffer.from(token.padEnd(ADMIN_TOKEN.length).slice(0, ADMIN_TOKEN.length));
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    void reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function hmacAuth(req: FastifyRequest, reply: FastifyReply, body: string): boolean {
  if (!CHECK_SECRET) return true; // no secret configured = open
  const sig = req.headers['x-signature'] as string | undefined;
  if (!sig) {
    void reply.code(401).send({ error: 'Missing X-Signature header' });
    return false;
  }
  const expected = crypto.createHmac('sha256', CHECK_SECRET).update(body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    void reply.code(401).send({ error: 'Invalid signature' });
    return false;
  }
  return true;
}

async function publishUpdate(store: { raw: { publish: (ch: string, msg: string) => Promise<number> } }, event: ConfigUpdateEvent): Promise<void> {
  await store.raw.publish(CONFIG_CHANNEL, JSON.stringify(event));
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const store = app.redisStore;

  // --- Tenants ---

  app.post('/tenants', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const result = TenantSchema.safeParse(req.body);
    if (!result.success) return reply.code(400).send({ error: result.error.flatten() });

    const tenant = result.data;
    const key = `rl:tenant:${tenant.tenantId}`;
    const exists = await store.raw.exists(key);
    if (exists) return reply.code(409).send({ error: 'Tenant already exists' });

    await store.raw.hset(key, {
      ...tenant,
      createdAt: Date.now(),
    });
    return reply.code(201).send({ tenantId: tenant.tenantId, createdAt: Date.now() });
  });

  app.get('/tenants/:id', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const { id } = req.params as { id: string };
    const tenant = await store.raw.hgetall(`rl:tenant:${id}`);
    if (!tenant || Object.keys(tenant).length === 0) return reply.code(404).send({ error: 'Not found' });

    const ruleKeys = await store.raw.keys(`rl:cfg:${id}:*`);
    const rules: Rule[] = [];
    for (const rk of ruleKeys) {
      const r = await store.raw.hgetall(rk);
      if (r && Object.keys(r).length > 0) {
        const parsed = RuleSchema.safeParse(r);
        if (parsed.success) rules.push(parsed.data as Rule);
      }
    }
    return reply.send({ ...tenant, rules });
  });

  app.delete('/tenants/:id', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const { id } = req.params as { id: string };
    await store.raw.del(`rl:tenant:${id}`);

    // Delete all rules for this tenant
    const ruleKeys = await store.raw.keys(`rl:cfg:${id}:*`);
    if (ruleKeys.length > 0) await store.raw.del(...ruleKeys);

    await publishUpdate(store, { action: 'delete', tenantId: id });
    return reply.code(204).send();
  });

  // --- Rules ---

  app.post('/tenants/:id/rules', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const result = RuleSchema.safeParse({ ...body, tenantId: id });
    if (!result.success) return reply.code(400).send({ error: result.error.flatten() });

    const parsed = result.data;
    const rule: Rule = {
      ruleId: parsed.ruleId ?? randomUUID(),
      tenantId: parsed.tenantId,
      route: parsed.route,
      algorithm: parsed.algorithm,
      limit: parsed.limit,
      windowSec: parsed.windowSec,
      failOpen: parsed.failOpen,
      dryRun: parsed.dryRun,
      keyExtractor: parsed.keyExtractor,
      ...(parsed.burst !== undefined && { burst: parsed.burst }),
      ...(parsed.keyHeader !== undefined && { keyHeader: parsed.keyHeader }),
    };
    await store.raw.hset(`rl:cfg:${rule.tenantId}:${rule.route}`, rule as unknown as Record<string, string>);
    await publishUpdate(store, { action: 'upsert', tenantId: id, route: rule.route, rule });
    return reply.code(201).send({ ruleId: rule.ruleId, tenantId: rule.tenantId });
  });

  app.put('/tenants/:id/rules/:ruleId', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const body = req.body as Record<string, unknown>;
    const result = RuleSchema.safeParse({ ...body, tenantId: id, ruleId });
    if (!result.success) return reply.code(400).send({ error: result.error.flatten() });

    const parsed2 = result.data;
    const rule: Rule = {
      ruleId,
      tenantId: parsed2.tenantId,
      route: parsed2.route,
      algorithm: parsed2.algorithm,
      limit: parsed2.limit,
      windowSec: parsed2.windowSec,
      failOpen: parsed2.failOpen,
      dryRun: parsed2.dryRun,
      keyExtractor: parsed2.keyExtractor,
      ...(parsed2.burst !== undefined && { burst: parsed2.burst }),
      ...(parsed2.keyHeader !== undefined && { keyHeader: parsed2.keyHeader }),
    };
    await store.raw.hset(`rl:cfg:${rule.tenantId}:${rule.route}`, rule as unknown as Record<string, string>);
    await publishUpdate(store, { action: 'upsert', tenantId: id, route: rule.route, rule });
    return reply.send({ ruleId, updatedAt: Date.now() });
  });

  app.delete('/tenants/:id/rules/:ruleId', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const { id } = req.params as { id: string; ruleId: string };
    const body = req.body as { route?: string } | undefined;
    const route = body?.route;
    if (route) {
      await store.raw.del(`rl:cfg:${id}:${route}`);
      await publishUpdate(store, { action: 'delete', tenantId: id, route });
    }
    return reply.code(204).send();
  });

  // --- Allowlist / Denylist ---

  app.post('/allowlist', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const { tenantId, clientKey } = req.body as { tenantId: string; clientKey: string };
    await store.raw.sadd(`rl:allow:${tenantId}`, clientKey);
    return reply.code(201).send();
  });

  app.delete('/allowlist', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const { tenantId, clientKey } = req.body as { tenantId: string; clientKey: string };
    await store.raw.srem(`rl:allow:${tenantId}`, clientKey);
    return reply.code(204).send();
  });

  app.post('/denylist', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const { tenantId, clientKey } = req.body as { tenantId: string; clientKey: string };
    await store.raw.sadd(`rl:deny:${tenantId}`, clientKey);
    return reply.code(201).send();
  });

  app.delete('/denylist', async (req, reply) => {
    if (!bearerAuth(req, reply)) return;
    const { tenantId, clientKey } = req.body as { tenantId: string; clientKey: string };
    await store.raw.srem(`rl:deny:${tenantId}`, clientKey);
    return reply.code(204).send();
  });

  // --- SDK check endpoint ---

  app.post('/check', async (req, reply) => {
    const rawBody = JSON.stringify(req.body);
    if (!hmacAuth(req, reply, rawBody)) return;

    const result = CheckRequestSchema.safeParse(req.body);
    if (!result.success) return reply.code(400).send({ error: result.error.flatten() });

    const decision = await app.dispatcher.check(result.data);
    reply.header('X-RateLimit-Limit', String(decision.limit));
    reply.header('X-RateLimit-Remaining', String(decision.remaining));
    reply.header('X-RateLimit-Reset', String(decision.resetAt));

    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfter));
      return reply.code(429).send(decision);
    }
    return reply.send(decision);
  });
};
