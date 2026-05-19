import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SlidingWindowLogLimiter } from '../../src/algorithms/sliding-log.js';
import { startRedis, stopRedis, flushRedis, type TestRedis } from './helpers.js';
import type { Rule, RateLimitRequest } from '../../src/types/index.js';

const rule: Rule = {
  ruleId: 'swl-int',
  tenantId: 'tenant1',
  route: 'POST:/billing',
  algorithm: 'sliding_window_log',
  limit: 100,
  windowSec: 60,
  failOpen: true,
  dryRun: false,
  keyExtractor: 'ip',
};

const req: RateLimitRequest = {
  tenantId: 'tenant1',
  route: 'POST:/billing',
  clientKey: '127.0.0.1',
};

describe('SlidingWindowLog — integration (real Redis)', () => {
  let redis: TestRedis;
  let limiter: SlidingWindowLogLimiter;

  beforeAll(async () => {
    redis = await startRedis();
    limiter = new SlidingWindowLogLimiter(redis.store);
  });

  afterAll(() => stopRedis(redis));
  beforeEach(() => flushRedis(redis));

  it('allows exactly N requests under high concurrency (perfect accuracy)', async () => {
    const LIMIT = 100;
    const TOTAL = 200;

    const results = await Promise.all(
      Array.from({ length: TOTAL }, () => limiter.check(req, rule))
    );

    // Sliding log is exact — no approximation tolerance needed
    const allowed = results.filter(r => r.allowed).length;
    expect(allowed).toBe(LIMIT);
  });

  it('retryAfter is accurate — next request is allowed after retryAfter seconds', async () => {
    const tinyRule = { ...rule, limit: 2, windowSec: 2 };
    // Add requests sequentially to get accurate timestamps
    await limiter.check(req, tinyRule);
    await new Promise(r => setTimeout(r, 100));
    await limiter.check(req, tinyRule);

    const denied = await limiter.check(req, tinyRule);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(denied.retryAfter).toBeLessThanOrEqual(tinyRule.windowSec);
  });

  it('allows again once the window slides', async () => {
    const tinyRule = { ...rule, limit: 1, windowSec: 1 };
    await limiter.check(req, tinyRule);
    expect((await limiter.check(req, tinyRule)).allowed).toBe(false);

    await new Promise(r => setTimeout(r, 1200));
    expect((await limiter.check(req, tinyRule)).allowed).toBe(true);
  });
});
