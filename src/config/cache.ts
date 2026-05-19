import { LRUCache } from 'lru-cache';
import type { Rule } from '../types/index.js';

// In-process rule cache. Not shared across cluster workers — each worker maintains
// its own cache and invalidates via Redis pub/sub (see watcher.ts).
export class RuleCache {
  private cache: LRUCache<string, Rule>;

  constructor(maxSize = 10_000, ttlMs = 60_000) {
    this.cache = new LRUCache({ max: maxSize, ttl: ttlMs });
  }

  // Resolves the most-specific matching rule for a request.
  // Priority: exact route match > wildcard method > tenant default.
  resolve(tenantId: string, route: string): Rule | undefined {
    // 1. Exact match: 'POST:/api/orders'
    const exact = this.cache.get(`${tenantId}:${route}`);
    if (exact) return exact;

    // 2. Wildcard method: '*:/api/orders' (any method for this path)
    const [, path] = route.split(':');
    const wildcard = this.cache.get(`${tenantId}:*:${path}`);
    if (wildcard) return wildcard;

    // 3. Tenant default (no route specificity)
    return this.cache.get(`${tenantId}:*:/*`);
  }

  set(rule: Rule): void {
    this.cache.set(`${rule.tenantId}:${rule.route}`, rule);
  }

  invalidate(tenantId: string, route?: string): void {
    if (route) {
      this.cache.delete(`${tenantId}:${route}`);
    } else {
      // Evict all entries for this tenant
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${tenantId}:`)) this.cache.delete(key);
      }
    }
  }

  load(rules: Rule[]): void {
    for (const rule of rules) this.set(rule);
  }

  clear(): void {
    this.cache.clear();
  }
}
