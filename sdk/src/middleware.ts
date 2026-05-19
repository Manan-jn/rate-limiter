import crypto from 'node:crypto';
import type { KeyExtractorType } from './key-extractors.js';
import { extractKey } from './key-extractors.js';

export interface SDKConfig {
  serviceUrl: string;   // e.g. 'http://rate-limiter:8080'
  tenantId: string;
  keyExtractor: KeyExtractorType;
  keyHeader?: string;
  checkSecret?: string; // HMAC-SHA256 shared secret
  failOpen?: boolean;   // default true — allow requests when service unreachable
}

interface CheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter: number;
}

async function callCheck(config: SDKConfig, clientKey: string, route: string): Promise<CheckResult> {
  const body = JSON.stringify({ tenantId: config.tenantId, clientKey, route });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (config.checkSecret) {
    const sig = crypto.createHmac('sha256', config.checkSecret).update(body).digest('hex');
    headers['X-Signature'] = sig;
  }

  const resp = await fetch(`${config.serviceUrl}/api/v1/check`, {
    method: 'POST',
    headers,
    body,
  });

  const result = await resp.json() as CheckResult;
  return result;
}

// Fastify plugin (3-line integration)
export async function rateLimitPlugin(
  app: {
    addHook: (hook: string, fn: (req: unknown, reply: unknown) => Promise<void>) => void;
  },
  config: SDKConfig,
): Promise<void> {
  app.addHook('preHandler', async (req: unknown, reply: unknown) => {
    const r = req as {
      ip?: string;
      method: string;
      routeOptions?: { url?: string };
      headers: Record<string, string | string[] | undefined>;
    };
    const rep = reply as {
      header: (k: string, v: string) => void;
      code: (n: number) => { send: (body: unknown) => void };
    };

    const clientKey = extractKey(r, config.keyExtractor, config.keyHeader);
    const route = `${r.method}:${r.routeOptions?.url ?? '/'}`;

    let result: CheckResult;
    try {
      result = await callCheck(config, clientKey, route);
    } catch {
      if (config.failOpen !== false) return; // fail-open default
      rep.code(503).send({ error: 'Rate limiter unavailable' });
      return;
    }

    rep.header('X-RateLimit-Limit', String(result.limit));
    rep.header('X-RateLimit-Remaining', String(result.remaining));
    rep.header('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      rep.header('Retry-After', String(result.retryAfter));
      rep.code(429).send({ error: 'Too Many Requests', retryAfter: result.retryAfter });
    }
  });
}

// Express middleware (3-line integration)
export function expressRateLimit(config: SDKConfig) {
  return async (
    req: {
      ip?: string;
      method: string;
      path: string;
      headers: Record<string, string | string[] | undefined>;
    },
    res: {
      setHeader: (k: string, v: string) => void;
      status: (n: number) => { json: (body: unknown) => void };
    },
    next: () => void,
  ): Promise<void> => {
    const clientKey = extractKey(req, config.keyExtractor, config.keyHeader);
    const route = `${req.method}:${req.path}`;

    let result: CheckResult;
    try {
      result = await callCheck(config, clientKey, route);
    } catch {
      if (config.failOpen !== false) { next(); return; }
      res.status(503).json({ error: 'Rate limiter unavailable' });
      return;
    }

    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      res.status(429).json({ error: 'Too Many Requests', retryAfter: result.retryAfter });
      return;
    }
    next();
  };
}
