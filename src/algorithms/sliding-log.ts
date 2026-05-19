import type { RateLimiter, RateLimitRequest, RateLimitResult, Rule, Store } from '../types/index.js';

export class SlidingWindowLogLimiter implements RateLimiter {
  constructor(private store: Store) {}

  async check(req: RateLimitRequest, rule: Rule): Promise<RateLimitResult> {
    const nowMs = await this.store.nowMs();
    const windowMs = rule.windowSec * 1000;
    const key = `rl:swl:${req.tenantId}:${req.route}:${req.clientKey}`;

    const [allowed, remaining, resetInMs] = await this.store.evalsha<[number, number, number]>(
      'sliding-log',
      [key],
      [nowMs, windowMs, rule.limit]
    );

    return {
      allowed: allowed === 1,
      limit: rule.limit,
      remaining,
      resetAt: Math.floor((nowMs + resetInMs) / 1000),
      retryAfter: allowed === 1 ? 0 : Math.ceil(resetInMs / 1000),
      algorithm: 'sliding_window_log',
      ruleId: rule.ruleId,
    };
  }
}
