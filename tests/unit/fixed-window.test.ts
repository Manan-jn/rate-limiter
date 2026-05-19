import { describe, it, expect, beforeEach } from 'vitest';
import { FixedWindowLimiter } from '../../src/algorithms/fixed-window.js';
import { MockStore } from '../../src/store/mock-store.js';
import type { Rule, RateLimitRequest } from '../../src/types/index.js';

const rule: Rule = {
  ruleId: 'test-fw',
  tenantId: 'tenant1',
  route: 'GET:/api',
  algorithm: 'fixed_window',
  limit: 5,
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

describe('FixedWindowLimiter', () => {
  let store: MockStore;
  let limiter: FixedWindowLimiter;

  beforeEach(() => {
    store = new MockStore();
    store.setNowMs(60_000); // 1 minute in, window = 0..60s → window index = 1
    limiter = new FixedWindowLimiter(store);
  });

  it('allows requests up to limit', async () => {
    for (let i = 0; i < rule.limit; i++) {
      const result = await limiter.check(req, rule);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(rule.limit - i - 1);
    }
  });

  it('denies the request after limit is reached', async () => {
    for (let i = 0; i < rule.limit; i++) {
      await limiter.check(req, rule);
    }
    const result = await limiter.check(req, rule);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('remaining never goes negative', async () => {
    for (let i = 0; i < rule.limit * 2; i++) {
      const result = await limiter.check(req, rule);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  it('resets counter after window expires', async () => {
    for (let i = 0; i < rule.limit; i++) {
      await limiter.check(req, rule);
    }
    expect((await limiter.check(req, rule)).allowed).toBe(false);

    store.advanceMs(rule.windowSec * 1000 + 1);
    const result = await limiter.check(req, rule);
    expect(result.allowed).toBe(true);
  });

  it('populates all result fields correctly', async () => {
    const result = await limiter.check(req, rule);
    expect(result.algorithm).toBe('fixed_window');
    expect(result.ruleId).toBe(rule.ruleId);
    expect(result.limit).toBe(rule.limit);
    expect(result.resetAt).toBeGreaterThan(0);
  });

  it('isolates counters per clientKey', async () => {
    const req2 = { ...req, clientKey: '10.0.0.1' };
    for (let i = 0; i < rule.limit; i++) {
      await limiter.check(req, rule);
    }
    // Different key should still be allowed
    const result = await limiter.check(req2, rule);
    expect(result.allowed).toBe(true);
  });
});
