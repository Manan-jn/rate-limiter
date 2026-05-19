import type { RateLimiter, RateLimitRequest, RateLimitResult, Rule, Store } from '../types/index.js';

export class SlidingWindowCounterLimiter implements RateLimiter {
  constructor(private store: Store) {}

  async check(req: RateLimitRequest, rule: Rule): Promise<RateLimitResult> {
    const nowMs = await this.store.nowMs();
    const windowMs = rule.windowSec * 1000;
    const curWindow = Math.floor(nowMs / windowMs);
    const prevWindow = curWindow - 1;

    const base = `rl:swc:${req.tenantId}:${req.route}:${req.clientKey}`;
    const prevKey = `${base}:${prevWindow}`;
    const curKey = `${base}:${curWindow}`;

    const [allowed, remaining, resetInMs] = await this.store.evalsha<[number, number, number]>(
      'sliding-counter',
      [prevKey, curKey],
      [rule.limit, windowMs, nowMs]
    );

    const resetAt = Math.floor((nowMs + resetInMs) / 1000);
    const retryAfter = allowed === 1 ? 0 : Math.ceil(resetInMs / 1000);

    return {
      allowed: allowed === 1,
      limit: rule.limit,
      remaining,
      resetAt,
      retryAfter,
      algorithm: 'sliding_window_counter',
      ruleId: rule.ruleId,
    };
  }
}
