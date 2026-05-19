import PQueue from 'p-queue';
import type { RateLimiter, RateLimitRequest, RateLimitResult, Rule } from '../types/index.js';

// Leaky Bucket — in-process egress throttle using p-queue.
// State is NOT shared across cluster workers; use token_bucket for ingress rate limiting.
// Best use case: controlling outbound call rate from a single worker to a downstream API.
export class LeakyBucketLimiter implements RateLimiter {
  private queues = new Map<string, PQueue>();

  check(req: RateLimitRequest, rule: Rule): Promise<RateLimitResult> {
    const key = `${req.tenantId}:${req.route}:${req.clientKey}`;
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new PQueue({
        concurrency: 1,
        intervalCap: rule.limit,
        interval: rule.windowSec * 1000,
      });
      this.queues.set(key, queue);
    }

    const pending = queue.size;
    const burst = rule.burst ?? rule.limit;

    if (pending >= burst) {
      return Promise.resolve({
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        resetAt: Math.floor(Date.now() / 1000) + rule.windowSec,
        retryAfter: rule.windowSec,
        algorithm: 'leaky_bucket' as const,
        ruleId: rule.ruleId,
      });
    }

    return Promise.resolve({
      allowed: true,
      limit: rule.limit,
      remaining: burst - pending - 1,
      resetAt: Math.floor(Date.now() / 1000) + rule.windowSec,
      retryAfter: 0,
      algorithm: 'leaky_bucket' as const,
      ruleId: rule.ruleId,
    });
  }
}
