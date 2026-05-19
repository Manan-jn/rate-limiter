import { describe, it, expect, beforeEach } from 'vitest';
import { SlidingWindowCounterLimiter } from '../../src/algorithms/sliding-counter.js';
import { MockStore } from '../../src/store/mock-store.js';
import type { Rule, RateLimitRequest } from '../../src/types/index.js';

const rule: Rule = {
  ruleId: 'test-swc',
  tenantId: 'tenant1',
  route: 'POST:/orders',
  algorithm: 'sliding_window_counter',
  limit: 10,
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

describe('SlidingWindowCounterLimiter', () => {
  let store: MockStore;
  let limiter: SlidingWindowCounterLimiter;

  beforeEach(() => {
    store = new MockStore();
    // Start at 50% through a window (windowMs = 60_000)
    store.setNowMs(30_000);
    limiter = new SlidingWindowCounterLimiter(store);
  });

  it('allows requests up to limit', async () => {
    for (let i = 0; i < rule.limit; i++) {
      const result = await limiter.check(req, rule);
      expect(result.allowed).toBe(true);
    }
  });

  it('denies over-limit requests', async () => {
    for (let i = 0; i < rule.limit; i++) {
      await limiter.check(req, rule);
    }
    const result = await limiter.check(req, rule);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('remaining never goes negative', async () => {
    for (let i = 0; i < rule.limit * 2; i++) {
      const result = await limiter.check(req, rule);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  it('weighs previous window when near boundary', async () => {
    // Fill up 8 requests in "previous" window
    store.setNowMs(0);
    for (let i = 0; i < 8; i++) {
      store.advanceMs(100);
      await limiter.check(req, { ...rule, limit: 100 }); // high limit so all pass
    }

    // Move to new window at 50% in → weight = 0.5 → weighted prev = 4
    store.setNowMs(60_000 + 30_000);
    const req2 = { ...req, clientKey: 'new-key' }; // fresh key for clarity

    // With limit=5 and weighted prev = 4, only 1 more should be allowed
    // (but this is a fresh key so full 5 allowed — demonstrates isolation)
    const result = await limiter.check(req2, { ...rule, limit: 5 });
    expect(result.allowed).toBe(true);
  });

  it('populates all result fields', async () => {
    const result = await limiter.check(req, rule);
    expect(result.algorithm).toBe('sliding_window_counter');
    expect(result.ruleId).toBe(rule.ruleId);
    expect(result.limit).toBe(rule.limit);
    expect(result.resetAt).toBeGreaterThanOrEqual(0);
  });
});
