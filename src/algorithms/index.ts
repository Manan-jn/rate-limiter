import type { Algorithm, RateLimiter, Store } from '../types/index.js';
import { FixedWindowLimiter } from './fixed-window.js';
import { SlidingWindowCounterLimiter } from './sliding-counter.js';
import { TokenBucketLimiter } from './token-bucket.js';
import { SlidingWindowLogLimiter } from './sliding-log.js';
import { LeakyBucketLimiter } from './leaky-bucket.js';

export function buildAlgorithmRegistry(store: Store): Map<Algorithm, RateLimiter> {
  const registry = new Map<Algorithm, RateLimiter>();
  registry.set('fixed_window',           new FixedWindowLimiter(store));
  registry.set('sliding_window_counter', new SlidingWindowCounterLimiter(store));
  registry.set('token_bucket',           new TokenBucketLimiter(store));
  registry.set('sliding_window_log',     new SlidingWindowLogLimiter(store));
  registry.set('leaky_bucket',           new LeakyBucketLimiter());
  return registry;
}

export {
  FixedWindowLimiter,
  SlidingWindowCounterLimiter,
  TokenBucketLimiter,
  SlidingWindowLogLimiter,
  LeakyBucketLimiter,
};
