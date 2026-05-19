import { LRUCache } from 'lru-cache';

// Short-lived in-process cache for rate-limited decisions.
// When a client is denied, subsequent requests within ttlMs don't hit Redis at all.
// This is safe: the underlying Redis counter is still the source of truth.
// We only cache DENIALS — allowing is always forwarded to Redis for accurate counting.
//
// Impact: A client hitting the rate limiter rapidly (e.g., a buggy client sending
// 1000 req/s) generates only ~1 Redis call per ttlMs instead of 1 per request.
export class DenyCache {
  private cache: LRUCache<string, { retryAfter: number; resetAt: number; ruleId: string; limit: number }>;

  constructor(maxSize = 50_000, ttlMs = 1_000) {
    this.cache = new LRUCache({ max: maxSize, ttl: ttlMs });
  }

  // Returns cached denial if present.
  get(tenantId: string, clientKey: string, route: string) {
    return this.cache.get(`${tenantId}:${clientKey}:${route}`);
  }

  // Cache a denial. Only call when Redis has confirmed the client is over-limit.
  set(tenantId: string, clientKey: string, route: string,
      retryAfter: number, resetAt: number, ruleId: string, limit: number): void {
    this.cache.set(`${tenantId}:${clientKey}:${route}`, { retryAfter, resetAt, ruleId, limit });
  }

  invalidate(tenantId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${tenantId}:`)) this.cache.delete(key);
    }
  }
}
