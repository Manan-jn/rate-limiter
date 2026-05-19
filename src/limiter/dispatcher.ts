import type { Algorithm, RateLimiter, RateLimitRequest, RateLimitResult } from '../types/index.js';
import type { RuleCache } from '../config/cache.js';
import type { RedisStore } from '../store/redis.js';
import type { DenyCache } from './deny-cache.js';
import type { Rule } from '../types/index.js';

// Master Lua scripts collapse deny + allow + TIME + algorithm into ONE Redis round-trip.
// Previously: 4 sequential round-trips (SISMEMBER × 2 + TIME + EVALSHA).
// Now: 1 round-trip for the entire decision.
const MASTER_SCRIPTS: Partial<Record<Algorithm, string>> = {
  sliding_window_counter: 'master-sliding-counter',
  fixed_window:           'master-fixed-window',
  token_bucket:           'master-token-bucket',
  sliding_window_log:     'master-sliding-log',
};

function defaultAllow(): RateLimitResult {
  return {
    allowed: true, limit: 0, remaining: 0,
    resetAt: 0, retryAfter: 0,
    algorithm: 'sliding_window_counter', ruleId: 'default',
  };
}

export class Dispatcher {
  constructor(
    private store: RedisStore,
    private cache: RuleCache,
    private algorithms: Map<Algorithm, RateLimiter>,
    private denyCache: DenyCache,
  ) {}

  async check(req: RateLimitRequest): Promise<RateLimitResult> {
    // Fast path 1: check in-process deny cache (no Redis)
    const cached = this.denyCache.get(req.tenantId, req.clientKey, req.route);
    if (cached) {
      return {
        allowed: false, limit: cached.limit, remaining: 0,
        resetAt: cached.resetAt, retryAfter: cached.retryAfter,
        algorithm: 'sliding_window_counter', ruleId: cached.ruleId,
      };
    }

    // Fast path 2: no rule configured → allow immediately (no Redis)
    const rule = this.cache.resolve(req.tenantId, req.route);
    if (!rule) return defaultAllow();

    // Check if a master script is available for this algorithm
    const masterScript = MASTER_SCRIPTS[rule.algorithm];
    if (masterScript) {
      return this.checkWithMasterScript(req, rule, masterScript);
    }

    // Fallback for leaky_bucket (in-process, no master script)
    const algorithm = this.algorithms.get(rule.algorithm);
    if (!algorithm) return defaultAllow();
    const result = await algorithm.check(req, rule);
    if (rule.dryRun) return { ...result, allowed: true };
    return result;
  }

  // Executes one Lua script that handles: deny-list, allow-list, TIME, and algorithm.
  // One Redis round-trip replaces the previous four.
  private async checkWithMasterScript(
    req: RateLimitRequest,
    rule: Rule,
    scriptName: string,
  ): Promise<RateLimitResult> {
    const denyKey  = `rl:deny:${req.tenantId}`;
    const allowKey = `rl:allow:${req.tenantId}`;

    const keys = this.buildKeys(req, rule, denyKey, allowKey);
    const args = this.buildArgs(req, rule);

    let rawResult: [string, number, number];
    try {
      rawResult = await this.store.evalsha<[string, number, number]>(scriptName, keys, args);
    } catch {
      // Redis down — apply fail-open (let request through)
      return defaultAllow();
    }

    const [status, remaining, resetOrRetry] = rawResult;

    if (status === 'denied') {
      return {
        allowed: false, limit: 0, remaining: 0,
        resetAt: 0, retryAfter: 3600,
        algorithm: rule.algorithm, ruleId: 'denylist',
      };
    }

    if (status === 'allowed') {
      return defaultAllow();
    }

    const nowSec = Math.floor(Date.now() / 1000);

    if (status === 'limited') {
      const retryAfter = Math.ceil(resetOrRetry / 1000);
      const result: RateLimitResult = {
        allowed: false, limit: rule.limit, remaining: 0,
        resetAt: nowSec + retryAfter, retryAfter,
        algorithm: rule.algorithm, ruleId: rule.ruleId,
      };
      if (!rule.dryRun) {
        this.denyCache.set(
          req.tenantId, req.clientKey, req.route,
          retryAfter, result.resetAt, rule.ruleId, rule.limit,
        );
      }
      return rule.dryRun ? { ...result, allowed: true } : result;
    }

    // status === 'ok'
    return {
      allowed: true, limit: rule.limit, remaining,
      resetAt: nowSec + Math.ceil(resetOrRetry / 1000),
      retryAfter: 0, algorithm: rule.algorithm, ruleId: rule.ruleId,
    };
  }

  private buildKeys(req: RateLimitRequest, rule: Rule, denyKey: string, allowKey: string): string[] {
    const base = `${req.tenantId}:${req.route}:${req.clientKey}`;
    const windowMs = rule.windowSec * 1000;

    switch (rule.algorithm) {
      case 'sliding_window_counter': {
        const nowApprox = Date.now(); // approximate — actual time comes from Redis inside Lua
        const curWindow  = Math.floor(nowApprox / windowMs);
        return [
          denyKey, allowKey,
          `rl:swc:${base}:${curWindow - 1}`,
          `rl:swc:${base}:${curWindow}`,
        ];
      }
      case 'fixed_window': {
        const nowApprox  = Date.now();
        const windowTs   = Math.floor(nowApprox / windowMs);
        return [denyKey, allowKey, `rl:fw:${base}:${windowTs}`];
      }
      case 'token_bucket':
        return [denyKey, allowKey, `rl:tb:${base}`];
      case 'sliding_window_log':
        return [denyKey, allowKey, `rl:swl:${base}`, `rl:swl:${base}:seq`];
      default:
        return [denyKey, allowKey];
    }
  }

  private buildArgs(req: RateLimitRequest, rule: Rule): (string | number)[] {
    const windowMs = rule.windowSec * 1000;

    switch (rule.algorithm) {
      case 'sliding_window_counter':
        return [req.clientKey, rule.limit, windowMs];
      case 'fixed_window':
        return [req.clientKey, rule.limit, rule.windowSec];
      case 'token_bucket': {
        const burst  = rule.burst ?? rule.limit;
        const rateMs = rule.limit / windowMs;
        return [req.clientKey, rateMs, burst, 1];
      }
      case 'sliding_window_log':
        return [req.clientKey, windowMs, rule.limit];
      default:
        return [req.clientKey];
    }
  }
}
