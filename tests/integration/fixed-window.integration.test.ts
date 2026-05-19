import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FixedWindowLimiter } from '../../src/algorithms/fixed-window.js';
import { startRedis, stopRedis, flushRedis, type TestRedis } from './helpers.js';
import type { Rule, RateLimitRequest } from '../../src/types/index.js';

const rule: Rule = {
  ruleId: 'fw-int',
  tenantId: 'tenant1',
  route: 'GET:/api',
  algorithm: 'fixed_window',
  limit: 100,
  windowSec: 60,
  failOpen: true,
  dryRun: false,
  keyExtractor: 'ip',
};

const req: RateLimitRequest = {
  tenantId: 'tenant1',
  route: 'GET:/api',
  clientKey: '127.0.0.1',
};

describe('FixedWindow — integration (real Redis)', () => {
  let redis: TestRedis;
  let limiter: FixedWindowLimiter;

  beforeAll(async () => {
    redis = await startRedis();
    limiter = new FixedWindowLimiter(redis.store);
  });

  afterAll(() => stopRedis(redis));
  beforeEach(() => flushRedis(redis));

  it('allows exactly N requests under high concurrency (Lua atomicity)', async () => {
    const LIMIT = 100;
    const TOTAL = 200;

    const results = await Promise.all(
      Array.from({ length: TOTAL }, () => limiter.check(req, rule))
    );

    const allowed = results.filter(r => r.allowed).length;
    expect(allowed).toBe(LIMIT);
  });

  it('sets correct X-RateLimit headers fields', async () => {
    const result = await limiter.check(req, rule);
    expect(result.limit).toBe(rule.limit);
    expect(result.remaining).toBe(rule.limit - 1);
    expect(result.resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('denies once limit reached, allows after window resets', async () => {
    // Fast-exhaust using a tiny limit
    const tinyRule = { ...rule, limit: 3, windowSec: 1 };
    for (let i = 0; i < 3; i++) {
      await limiter.check(req, tinyRule);
    }
    expect((await limiter.check(req, tinyRule)).allowed).toBe(false);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 1200));
    expect((await limiter.check(req, tinyRule)).allowed).toBe(true);
  });
});
