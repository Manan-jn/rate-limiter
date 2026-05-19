import { describe, it, expect, beforeEach } from 'vitest';
import { SlidingWindowLogLimiter } from '../../src/algorithms/sliding-log.js';
import { MockStore } from '../../src/store/mock-store.js';
import type { Rule, RateLimitRequest } from '../../src/types/index.js';

const rule: Rule = {
  ruleId: 'test-swl',
  tenantId: 'tenant1',
  route: 'POST:/billing',
  algorithm: 'sliding_window_log',
  limit: 5,
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

describe('SlidingWindowLogLimiter', () => {
  let store: MockStore;
  let limiter: SlidingWindowLogLimiter;

  beforeEach(() => {
    store = new MockStore();
    store.setNowMs(1_000_000);
    limiter = new SlidingWindowLogLimiter(store);
  });

  it('allows exactly limit requests', async () => {
    for (let i = 0; i < rule.limit; i++) {
      store.advanceMs(1); // unique timestamp per request
      const result = await limiter.check(req, rule);
      expect(result.allowed).toBe(true);
    }
  });

  it('denies the (limit+1)th request', async () => {
    for (let i = 0; i < rule.limit; i++) {
      store.advanceMs(1);
      await limiter.check(req, rule);
    }
    store.advanceMs(1);
    const result = await limiter.check(req, rule);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('remaining never goes negative', async () => {
    for (let i = 0; i < rule.limit * 2; i++) {
      store.advanceMs(1);
      const result = await limiter.check(req, rule);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  it('allows again once oldest entry slides out of window', async () => {
    for (let i = 0; i < rule.limit; i++) {
      store.advanceMs(1);
      await limiter.check(req, rule);
    }
    store.advanceMs(1);
    expect((await limiter.check(req, rule)).allowed).toBe(false);

    // Advance past the full window → all entries expired
    store.advanceMs(rule.windowSec * 1000 + 10);
    store.advanceMs(1);
    const result = await limiter.check(req, rule);
    expect(result.allowed).toBe(true);
  });

  it('populates all result fields', async () => {
    store.advanceMs(1);
    const result = await limiter.check(req, rule);
    expect(result.algorithm).toBe('sliding_window_log');
    expect(result.ruleId).toBe(rule.ruleId);
    expect(result.limit).toBe(rule.limit);
    expect(result.resetAt).toBeGreaterThanOrEqual(0);
  });

  it('isolates per clientKey', async () => {
    for (let i = 0; i < rule.limit; i++) {
      store.advanceMs(1);
      await limiter.check(req, rule);
    }
    store.advanceMs(1);
    const result = await limiter.check({ ...req, clientKey: 'other-ip' }, rule);
    expect(result.allowed).toBe(true);
  });
});
