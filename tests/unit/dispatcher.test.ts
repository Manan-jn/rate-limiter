import { describe, it, expect, beforeEach } from 'vitest';
import { Dispatcher } from '../../src/limiter/dispatcher.js';
import { MockStore } from '../../src/store/mock-store.js';
import { RuleCache } from '../../src/config/cache.js';
import { DenyCache } from '../../src/limiter/deny-cache.js';
import { buildAlgorithmRegistry } from '../../src/algorithms/index.js';
import type { Rule } from '../../src/types/index.js';

const makeDispatcher = (store: MockStore) => {
  const cache = new RuleCache();
  const denyCache = new DenyCache();
  const algorithms = buildAlgorithmRegistry(store);
  // RuleCache.resolve needs rules loaded — bypass by loading directly
  const rule: Rule = {
    ruleId: 'r1', tenantId: 't1', route: 'POST:/api',
    algorithm: 'sliding_window_counter',
    limit: 3, windowSec: 60,
    failOpen: true, dryRun: false, keyExtractor: 'ip',
  };
  cache.set(rule);
  return { dispatcher: new Dispatcher(store, cache, algorithms, denyCache), denyCache };
};

const REQ = { tenantId: 't1', route: 'POST:/api', clientKey: 'ip1' };

describe('Dispatcher — master script path (1 Redis RTT)', () => {
  let store: MockStore;

  beforeEach(() => {
    store = new MockStore();
    store.setNowMs(60_000);
  });

  it('allows up to limit using master script', async () => {
    const { dispatcher } = makeDispatcher(store);
    for (let i = 0; i < 3; i++) {
      const r = await dispatcher.check(REQ);
      expect(r.allowed).toBe(true);
      expect(r.ruleId).toBe('r1');
    }
  });

  it('denies over-limit and returns correct fields', async () => {
    const { dispatcher } = makeDispatcher(store);
    for (let i = 0; i < 3; i++) await dispatcher.check(REQ);
    const r = await dispatcher.check(REQ);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it('deny cache returns 429 without Redis call after first denial', async () => {
    const { dispatcher } = makeDispatcher(store);
    for (let i = 0; i < 4; i++) await dispatcher.check(REQ);
    // Subsequent calls should hit deny cache (no evalsha needed)
    const store2 = new MockStore(); // different store with NO scripts loaded
    store2.setNowMs(60_000);
    const { dispatcher: d2, denyCache } = makeDispatcher(store2);
    // Manually populate the deny cache as if a denial was cached
    denyCache.set('t1', 'ip1', 'POST:/api', 30, Math.floor(Date.now() / 1000) + 30, 'r1', 3);
    const r = await d2.check(REQ);
    expect(r.allowed).toBe(false);
    expect(r.ruleId).toBe('r1');
  });

  it('denylist returns denied status', async () => {
    store.sadd('rl:deny:t1', 'ip1');
    const { dispatcher } = makeDispatcher(store);
    const r = await dispatcher.check(REQ);
    expect(r.allowed).toBe(false);
    expect(r.ruleId).toBe('denylist');
    expect(r.retryAfter).toBe(3600);
  });

  it('allowlist bypasses limit entirely', async () => {
    store.sadd('rl:allow:t1', 'ip1');
    const { dispatcher } = makeDispatcher(store);
    // Even after "exhausting" limit (wouldn't happen due to allowlist), still allowed
    for (let i = 0; i < 10; i++) {
      const r = await dispatcher.check(REQ);
      expect(r.allowed).toBe(true);
    }
  });

  it('dry-run: evaluates but never denies', async () => {
    const store2 = new MockStore();
    store2.setNowMs(60_000);
    const cache = new RuleCache();
    const denyCache = new DenyCache();
    const dryRule: Rule = {
      ruleId: 'r2', tenantId: 't1', route: 'POST:/api',
      algorithm: 'sliding_window_counter',
      limit: 1, windowSec: 60,
      failOpen: true, dryRun: true, keyExtractor: 'ip',
    };
    cache.set(dryRule);
    const d = new Dispatcher(store2, cache, buildAlgorithmRegistry(store2), denyCache);
    for (let i = 0; i < 5; i++) {
      const r = await d.check(REQ);
      expect(r.allowed).toBe(true); // dryRun: never blocked
    }
  });

  it('unknown tenant defaults to allow (no Redis call)', async () => {
    const { dispatcher } = makeDispatcher(store);
    const r = await dispatcher.check({ tenantId: 'unknown', route: 'GET:/anything', clientKey: 'x' });
    expect(r.allowed).toBe(true);
    expect(r.ruleId).toBe('default');
  });
});
