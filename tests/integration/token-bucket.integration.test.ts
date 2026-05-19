import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TokenBucketLimiter } from '../../src/algorithms/token-bucket.js';
import { startRedis, stopRedis, flushRedis, type TestRedis } from './helpers.js';
import type { Rule, RateLimitRequest } from '../../src/types/index.js';

const rule: Rule = {
  ruleId: 'tb-int',
  tenantId: 'tenant1',
  route: 'POST:/upload',
  algorithm: 'token_bucket',
  limit: 10,
  windowSec: 1,
  burst: 20,
  failOpen: true,
  dryRun: false,
  keyExtractor: 'ip',
};

const req: RateLimitRequest = {
  tenantId: 'tenant1',
  route: 'POST:/upload',
  clientKey: '127.0.0.1',
};

describe('TokenBucket — integration (real Redis)', () => {
  let redis: TestRedis;
  let limiter: TokenBucketLimiter;

  beforeAll(async () => {
    redis = await startRedis();
    limiter = new TokenBucketLimiter(redis.store);
  });

  afterAll(() => stopRedis(redis));
  beforeEach(() => flushRedis(redis));

  it('absorbs burst up to burst cap under concurrency', async () => {
    const BURST = rule.burst!;
    const TOTAL = BURST + 10; // 10 over burst

    const results = await Promise.all(
      Array.from({ length: TOTAL }, () => limiter.check(req, rule))
    );
    const allowed = results.filter(r => r.allowed).length;
    expect(allowed).toBe(BURST);
  });

  it('refills tokens after waiting', async () => {
    // Exhaust burst
    await Promise.all(
      Array.from({ length: rule.burst! }, () => limiter.check(req, rule))
    );
    expect((await limiter.check(req, rule)).allowed).toBe(false);

    // Wait 2 windows → 20 tokens refilled, capped at burst=20
    await new Promise(r => setTimeout(r, 2200));
    expect((await limiter.check(req, rule)).allowed).toBe(true);
  });

  it('remaining never goes negative under concurrent exhaustion', async () => {
    const results = await Promise.all(
      Array.from({ length: rule.burst! * 3 }, () => limiter.check(req, rule))
    );
    for (const r of results) {
      expect(r.remaining).toBeGreaterThanOrEqual(0);
    }
  });
});
