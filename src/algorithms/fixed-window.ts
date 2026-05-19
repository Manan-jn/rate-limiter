import type { RateLimiter, RateLimitRequest, RateLimitResult, Rule, Store } from '../types/index.js';

export class FixedWindowLimiter implements RateLimiter {
  constructor(private store: Store) {}

  async check(req: RateLimitRequest, rule: Rule): Promise<RateLimitResult> {
    const nowMs = await this.store.nowMs();
    const windowTs = Math.floor(nowMs / (rule.windowSec * 1000));
    const key = `rl:fw:${req.tenantId}:${req.route}:${req.clientKey}:${windowTs}`;

    const [allowed, remaining, ttlSec] = await this.store.evalsha<[number, number, number]>(
      'fixed-window',
      [key],
      [rule.limit, rule.windowSec]
    );

    return {
      allowed: allowed === 1,
      limit: rule.limit,
      remaining,
      resetAt: Math.floor(nowMs / 1000) + ttlSec,
      retryAfter: allowed === 1 ? 0 : ttlSec,
      algorithm: 'fixed_window',
      ruleId: rule.ruleId,
    };
  }
}
