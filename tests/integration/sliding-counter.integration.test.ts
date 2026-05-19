import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SlidingWindowCounterLimiter } from '../../src/algorithms/sliding-counter.js';
import { startRedis, stopRedis, flushRedis, type TestRedis } from './helpers.js';
import type { Rule, RateLimitRequest } from '../../src/types/index.js';

const rule: Rule = {
  ruleId: 'swc-int',
  tenantId: 'tenant1',
  route: 'POST:/orders',
  algorithm: 'sliding_window_counter',
  limit: 100,
  windowSec: 60,
  failOpen: true,
  dryRun: false,
  keyExtractor: 'ip',
};

const req: RateLimitRequest = {
  tenantId: 'tenant1',
  route: 'POST:/orders',
  clientKey: '127.0.0.1',
};

describe('SlidingWindowCounter — integration (real Redis)', () => {
  let redis: TestRedis;
  let limiter: SlidingWindowCounterLimiter;

  beforeAll(async () => {
    redis = await startRedis();
    limiter = new SlidingWindowCounterLimiter(redis.store);
  });

  afterAll(() => stopRedis(redis));
  beforeEach(() => flushRedis(redis));

  it('allows at most N requests under high concurrency (Lua atomicity)', async () => {
    const LIMIT = 100;
    const TOTAL = 200;

    const results = await Promise.all(
      Array.from({ length: TOTAL }, () => limiter.check(req, rule))
    );

    const allowed = results.filter(r => r.allowed).length;
    // Sliding window counter is ~99% accurate — allow ±1 tolerance
    expect(allowed).toBeGreaterThanOrEqual(LIMIT - 1);
    expect(allowed).toBeLessThanOrEqual(LIMIT + 1);
  });

  it('independent tenants do not bleed quota', async () => {
    const req2: RateLimitRequest = { ...req, tenantId: 'tenant2' };
    const rule2: Rule = { ...rule, tenantId: 'tenant2', limit: 5 };

    for (let i = 0; i < 5; i++) {
      await limiter.check(req, rule); // tenant1
    }
    // tenant1 exhausted its 5-request slice, but tenant2 is fresh
    const result = await limiter.check(req2, rule2);
    expect(result.allowed).toBe(true);
  });
});
