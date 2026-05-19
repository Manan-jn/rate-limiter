import { describe, it, expect, beforeEach } from 'vitest';
import { MockStore } from '../../src/store/mock-store.js';

describe('MockStore', () => {
  let store: MockStore;

  beforeEach(() => {
    store = new MockStore();
    store.setNowMs(1_000_000);
  });

  describe('fixed-window script', () => {
    it('increments and allows up to limit', async () => {
      const limit = 3;
      for (let i = 0; i < limit; i++) {
        const [allowed, remaining] = await store.evalsha<[number, number, number]>(
          'fixed-window', ['k1'], [limit, 60]
        );
        expect(allowed).toBe(1);
        expect(remaining).toBe(limit - i - 1);
      }
    });

    it('denies when over limit', async () => {
      for (let i = 0; i < 3; i++) {
        await store.evalsha('fixed-window', ['k2'], [3, 60]);
      }
      const [allowed, remaining] = await store.evalsha<[number, number, number]>(
        'fixed-window', ['k2'], [3, 60]
      );
      expect(allowed).toBe(0);
      expect(remaining).toBe(0);
    });

    it('resets after window expires', async () => {
      await store.evalsha('fixed-window', ['k3'], [1, 60]);
      const [denied] = await store.evalsha<[number, number, number]>('fixed-window', ['k3'], [1, 60]);
      expect(denied).toBe(0);

      store.advanceMs(61_000); // expire window
      const [allowed] = await store.evalsha<[number, number, number]>('fixed-window', ['k3'], [1, 60]);
      expect(allowed).toBe(1);
    });
  });

  describe('token-bucket script', () => {
    it('allows requests up to burst', async () => {
      const burst = 5;
      for (let i = 0; i < burst; i++) {
        const [allowed] = await store.evalsha<[number, number, number]>(
          'token-bucket', ['tb1'], [store['_nowMs'], 1 / 1000, burst, 1]
        );
        expect(allowed).toBe(1);
      }
    });

    it('denies when tokens exhausted', async () => {
      const burst = 2;
      for (let i = 0; i < burst; i++) {
        await store.evalsha('token-bucket', ['tb2'], [store['_nowMs'], 1 / 1000, burst, 1]);
      }
      const [allowed] = await store.evalsha<[number, number, number]>(
        'token-bucket', ['tb2'], [store['_nowMs'], 1 / 1000, burst, 1]
      );
      expect(allowed).toBe(0);
    });

    it('remaining never goes negative', async () => {
      for (let i = 0; i < 10; i++) {
        const [, remaining] = await store.evalsha<[number, number, number]>(
          'token-bucket', ['tb3'], [store['_nowMs'], 1 / 1000, 3, 1]
        );
        expect(remaining).toBeGreaterThanOrEqual(0);
      }
    });

    it('refills tokens over time', async () => {
      const rateMs = 1 / 100; // 10 tokens/second
      const burst = 5;
      // Exhaust all tokens
      for (let i = 0; i < burst; i++) {
        await store.evalsha('token-bucket', ['tb4'], [store['_nowMs'], rateMs, burst, 1]);
      }
      // Advance 2 seconds → should refill 20 tokens, capped at burst
      store.advanceMs(2000);
      const [allowed] = await store.evalsha<[number, number, number]>(
        'token-bucket', ['tb4'], [store['_nowMs'], rateMs, burst, 1]
      );
      expect(allowed).toBe(1);
    });
  });

  describe('sliding-log script', () => {
    it('allows exactly limit requests', async () => {
      const limit = 4;
      for (let i = 0; i < limit; i++) {
        store.advanceMs(1); // unique timestamps
        const [allowed] = await store.evalsha<[number, number, number]>(
          'sliding-log', ['sl1'], [store['_nowMs'], 60_000, limit]
        );
        expect(allowed).toBe(1);
      }
      store.advanceMs(1);
      const [denied] = await store.evalsha<[number, number, number]>(
        'sliding-log', ['sl1'], [store['_nowMs'], 60_000, limit]
      );
      expect(denied).toBe(0);
    });

    it('allows again after window slides', async () => {
      await store.evalsha('sliding-log', ['sl2'], [store['_nowMs'], 60_000, 1]);
      const [denied] = await store.evalsha<[number, number, number]>(
        'sliding-log', ['sl2'], [store['_nowMs'], 60_000, 1]
      );
      expect(denied).toBe(0);

      store.advanceMs(61_000);
      store.advanceMs(1);
      const [allowed] = await store.evalsha<[number, number, number]>(
        'sliding-log', ['sl2'], [store['_nowMs'], 60_000, 1]
      );
      expect(allowed).toBe(1);
    });
  });

  describe('sliding-counter script', () => {
    it('allows requests in current window', async () => {
      const windowMs = 60_000;
      const limit = 5;
      // Place nowMs at 50% into window
      store.setNowMs(windowMs * 1.5);
      for (let i = 0; i < limit; i++) {
        const [allowed] = await store.evalsha<[number, number, number]>(
          'sliding-counter',
          ['prev', 'cur'],
          [limit, windowMs, store['_nowMs']]
        );
        expect(allowed).toBe(1);
      }
    });

    it('weighs previous window correctly', async () => {
      const windowMs = 60_000;
      // 30 requests in previous window, limit=50, now at 50% into new window
      // weighted prev = 30 * 0.5 = 15, cur = 0 → estimated = 15 → allow
      const prevKey = 'sc:prev';
      const curKey = 'sc:cur';
      // Pre-populate prevKey with count 30 directly
      const store2 = new MockStore();
      store2.setNowMs(windowMs * 1.5); // 50% into window 2

      // Manually set prevKey by running 30 allowed calls at window start
      store2.setNowMs(0);
      for (let i = 0; i < 30; i++) {
        store2.advanceMs(1);
        await store2.evalsha('sliding-counter', [prevKey, curKey], [100, windowMs, store2['_nowMs']]);
      }
      // Move to new window
      store2.setNowMs(windowMs + windowMs / 2);

      const [allowed] = await store2.evalsha<[number, number, number]>(
        'sliding-counter',
        // now prev=curKey from last window, and new curKey
        ['sc:cur', 'sc:new'],
        [50, windowMs, store2['_nowMs']]
      );
      expect(allowed).toBe(1);
    });
  });
});
