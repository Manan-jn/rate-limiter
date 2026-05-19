import type { RateLimiter, RateLimitRequest, RateLimitResult, Rule, Store } from '../types/index.js';

export class TokenBucketLimiter implements RateLimiter {
  constructor(private store: Store) {}

  async check(req: RateLimitRequest, rule: Rule): Promise<RateLimitResult> {
    const nowMs = await this.store.nowMs();
    const windowMs = rule.windowSec * 1000;
    const burst = rule.burst ?? rule.limit;
    // Tokens refill at limit tokens per windowMs
    const rateMs = rule.limit / windowMs;
    const key = `rl:tb:${req.tenantId}:${req.route}:${req.clientKey}`;

    const [allowed, remainingTokens, retryAfterMs] = await this.store.evalsha<[number, number, number]>(
      'token-bucket',
      [key],
      [nowMs, rateMs, burst, 1]
    );

    return {
      allowed: allowed === 1,
      limit: burst,
      remaining: remainingTokens,
      resetAt: Math.floor(nowMs / 1000) + Math.ceil(retryAfterMs / 1000),
      retryAfter: allowed === 1 ? 0 : Math.ceil(retryAfterMs / 1000),
      algorithm: 'token_bucket',
      ruleId: rule.ruleId,
    };
  }
}
