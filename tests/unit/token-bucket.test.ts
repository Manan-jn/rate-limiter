import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBucketLimiter } from '../../src/algorithms/token-bucket.js';
import { MockStore } from '../../src/store/mock-store.js';
import type { Rule, RateLimitRequest } from '../../src/types/index.js';

const rule: Rule = {
  ruleId: 'test-tb',
  tenantId: 'tenant1',
  route: 'POST:/upload',
  algorithm: 'token_bucket',
  limit: 10,       // 10 tokens per windowSec
  windowSec: 1,    // 1s window → 10 tokens/s
  burst: 15,       // burst cap
  failOpen: true,
  dryRun: false,
  keyExtractor: 'ip',
};

const req: RateLimitRequest = {
  tenantId: 'tenant1',
  route: 'POST:/upload',
  clientKey: '127.0.0.1',
};

describe('TokenBucketLimiter', () => {
  let store: MockStore;
  let limiter: TokenBucketLimiter;

  beforeEach(() => {
    store = new MockStore();
    store.setNowMs(1_000_000);
    limiter = new TokenBucketLimiter(store);
  });

  it('allows requests up to burst cap', async () => {
    for (let i = 0; i < rule.burst!; i++) {
      const result = await limiter.check(req, rule);
      expect(result.allowed).toBe(true);
    }
  });

  it('denies when burst exhausted', async () => {
    for (let i = 0; i < rule.burst!; i++) {
      await limiter.check(req, rule);
    }
    const result = await limiter.check(req, rule);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('remaining never goes negative', async () => {
    for (let i = 0; i < rule.burst! * 2; i++) {
      const result = await limiter.check(req, rule);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  it('refills tokens over time', async () => {
    // Exhaust burst
    for (let i = 0; i < rule.burst!; i++) {
      await limiter.check(req, rule);
    }
    expect((await limiter.check(req, rule)).allowed).toBe(false);

    // Advance 2 seconds → 20 tokens refilled, capped at burst=15
    store.advanceMs(2000);
    const result = await limiter.check(req, rule);
    expect(result.allowed).toBe(true);
  });

  it('uses burst cap when no burst explicitly set in rule', async () => {
    const ruleNoBurst: Rule = { ...rule, burst: undefined };
    // limit=10 is used as burst
    for (let i = 0; i < rule.limit; i++) {
      const result = await limiter.check(req, ruleNoBurst);
      expect(result.allowed).toBe(true);
    }
    // Different clientKey → own independent bucket → still allowed
    const result = await limiter.check({ ...req, clientKey: 'k2' }, ruleNoBurst);
    expect(result.allowed).toBe(true);
  });

  it('populates all result fields', async () => {
    const result = await limiter.check(req, rule);
    expect(result.algorithm).toBe('token_bucket');
    expect(result.ruleId).toBe(rule.ruleId);
    expect(result.limit).toBe(rule.burst);
  });
});
