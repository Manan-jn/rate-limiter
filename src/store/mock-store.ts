import type { Store } from '../types/index.js';

type Entry =
  | { value: string; expiresAt: number }
  | { value: string; expiresAt?: never };

// In-memory simulation of Redis commands used by the Lua scripts.
// Only for unit tests — never used in production.
export class MockStore implements Store {
  private strings = new Map<string, Entry>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>(); // member → score
  private sets = new Map<string, Set<string>>();           // Redis SET (SADD/SISMEMBER)
  private _nowMs = Date.now();

  // Advance the mock clock (for testing TTL expiry and token bucket refill).
  advanceMs(ms: number): void {
    this._nowMs += ms;
  }

  setNowMs(ms: number): void {
    this._nowMs = ms;
  }

  async nowMs(): Promise<number> {
    return this._nowMs;
  }

  // MockStore.evalsha() runs the equivalent JavaScript logic for each Lua script.
  // This mirrors what the actual Lua scripts do on a real Redis instance.
  async evalsha<T>(name: string, keys: string[], args: (string | number)[]): Promise<T> {
    this.evictExpired();
    switch (name) {
      // Legacy scripts (used by unit tests directly)
      case 'fixed-window':    return this.fixedWindow(keys, args) as T;
      case 'sliding-counter': return this.slidingCounter(keys, args) as T;
      case 'token-bucket':    return this.tokenBucket(keys, args) as T;
      case 'sliding-log':     return this.slidingLog(keys, args) as T;
      // Master scripts — same logic but return string status
      case 'master-fixed-window':    return this.masterFixedWindow(keys, args) as T;
      case 'master-sliding-counter': return this.masterSlidingCounter(keys, args) as T;
      case 'master-token-bucket':    return this.masterTokenBucket(keys, args) as T;
      case 'master-sliding-log':     return this.masterSlidingLog(keys, args) as T;
      default:
        throw new Error(`MockStore: unknown script "${name}"`);
    }
  }

  // Master scripts: keys[0]=denylist, keys[1]=allowlist, keys[2..]=algo keys
  // args[0]=clientKey, args[1..]=algo args
  // Returns: [status, remaining, resetOrRetryMs]

  private masterFixedWindow(keys: string[], args: (string | number)[]): [string, number, number] {
    const clientKey = String(args[0]);
    const limit     = Number(args[1]);
    const windowSec = Number(args[2]);
    const deny  = this.sets.get(String(keys[0]));
    const allow = this.sets.get(String(keys[1]));
    if (deny?.has(clientKey))  return ['denied', 0, 0];
    if (allow?.has(clientKey)) return ['allowed', 0, 0];
    const [allowed, remaining, ttl] = this.fixedWindow([keys[2] ?? ''], [limit, windowSec]);
    return allowed === 1 ? ['ok', remaining, 0] : ['limited', 0, ttl * 1000];
  }

  private masterSlidingCounter(keys: string[], args: (string | number)[]): [string, number, number] {
    const clientKey = String(args[0]);
    const limit     = Number(args[1]);
    const windowMs  = Number(args[2]);
    const deny  = this.sets.get(String(keys[0]));
    const allow = this.sets.get(String(keys[1]));
    if (deny?.has(clientKey))  return ['denied', 0, 0];
    if (allow?.has(clientKey)) return ['allowed', 0, 0];
    const [allowed, remaining, resetInMs] = this.slidingCounter(
      [keys[2] ?? '', keys[3] ?? ''],
      [limit, windowMs, this._nowMs]
    );
    return allowed === 1 ? ['ok', remaining, 0] : ['limited', 0, resetInMs];
  }

  private masterTokenBucket(keys: string[], args: (string | number)[]): [string, number, number] {
    const clientKey = String(args[0]);
    const rateMs    = Number(args[1]);
    const burst     = Number(args[2]);
    const cost      = Number(args[3]);
    const deny  = this.sets.get(String(keys[0]));
    const allow = this.sets.get(String(keys[1]));
    if (deny?.has(clientKey))  return ['denied', 0, 0];
    if (allow?.has(clientKey)) return ['allowed', 0, 0];
    const [allowed, remaining, retryMs] = this.tokenBucket(
      [keys[2] ?? ''],
      [this._nowMs, rateMs, burst, cost]
    );
    return allowed === 1 ? ['ok', remaining, 0] : ['limited', 0, retryMs];
  }

  private masterSlidingLog(keys: string[], args: (string | number)[]): [string, number, number] {
    const clientKey = String(args[0]);
    const windowMs  = Number(args[1]);
    const limit     = Number(args[2]);
    const deny  = this.sets.get(String(keys[0]));
    const allow = this.sets.get(String(keys[1]));
    if (deny?.has(clientKey))  return ['denied', 0, 0];
    if (allow?.has(clientKey)) return ['allowed', 0, 0];
    const [allowed, remaining, resetInMs] = this.slidingLog(
      [keys[2] ?? '', keys[3] ?? ''],
      [this._nowMs, windowMs, limit]
    );
    return allowed === 1 ? ['ok', remaining, 0] : ['limited', 0, resetInMs];
  }

  // --- Fixed Window ---
  // Keys: [key], Args: [limit, windowSec]
  private fixedWindow(keys: string[], args: (string | number)[]): [number, number, number] {
    const key = keys[0];
    const limit = Number(args[0]);
    const windowSec = Number(args[1]);

    const entry = this.getStr(key);
    const count = entry ? Number(entry) + 1 : 1;
    const ttlSec = this.setStr(key, String(count), entry ? undefined : windowSec * 1000);
    const ttl = ttlSec ?? windowSec;

    if (count > limit) return [0, 0, ttl];
    return [1, limit - count, ttl];
  }

  // --- Sliding Window Counter ---
  // Keys: [prevKey, curKey], Args: [limit, windowMs, nowMs]
  private slidingCounter(keys: string[], args: (string | number)[]): [number, number, number] {
    const [prevKey, curKey] = keys;
    const limit = Number(args[0]);
    const windowMs = Number(args[1]);
    const nowMs = Number(args[2]);

    const prevCount = Number(this.getStr(prevKey) ?? 0);
    const curCount = Number(this.getStr(curKey) ?? 0);
    const elapsed = nowMs % windowMs;
    const weight = (windowMs - elapsed) / windowMs;
    const estimated = prevCount * weight + curCount;

    if (estimated >= limit) {
      const resetInMs = windowMs - elapsed;
      return [0, 0, resetInMs];
    }

    // Increment cur window, PEXPIRE 2×windowMs
    this.setStr(curKey, String(curCount + 1), windowMs * 2);
    return [1, Math.floor(limit - estimated - 1), 0];
  }

  // --- Token Bucket ---
  // Keys: [key], Args: [nowMs, rateMs, burst, cost]
  private tokenBucket(keys: string[], args: (string | number)[]): [number, number, number] {
    const key = keys[0];
    const nowMs = Number(args[0]);
    const rateMs = Number(args[1]);
    const burst = Number(args[2]);
    const cost = Number(args[3]);

    const hash = this.hashes.get(key);
    let tokens = hash ? Number(hash.get('tokens') ?? burst) : burst;
    const last = hash ? Number(hash.get('last') ?? nowMs) : nowMs;

    tokens = Math.min(burst, tokens + (nowMs - last) * rateMs);

    if (tokens >= cost) {
      tokens -= cost;
      this.setHash(key, { tokens: String(tokens), last: String(nowMs) }, Math.ceil(burst / rateMs * 2));
      return [1, Math.floor(tokens), 0];
    }

    const retryMs = Math.ceil((cost - tokens) / rateMs);
    this.setHash(key, { tokens: String(tokens), last: String(nowMs) }, Math.ceil(burst / rateMs * 2));
    return [0, 0, retryMs];
  }

  // --- Sliding Window Log ---
  // Keys: [key], Args: [nowMs, windowMs, limit]
  private slidingLog(keys: string[], args: (string | number)[]): [number, number, number] {
    const key = keys[0];
    const nowMs = Number(args[0]);
    const windowMs = Number(args[1]);
    const limit = Number(args[2]);
    const cutoff = nowMs - windowMs;

    const zset = this.zsets.get(key) ?? new Map<string, number>();
    // ZREMRANGEBYSCORE 0 cutoff
    for (const [member, score] of zset) {
      if (score <= cutoff) zset.delete(member);
    }
    const count = zset.size;

    if (count >= limit) {
      const oldest = Math.min(...zset.values());
      const resetInMs = oldest + windowMs - nowMs;
      this.zsets.set(key, zset);
      return [0, 0, Math.max(0, resetInMs)];
    }

    // Use a sequence counter to keep members unique at the same timestamp
    const seqKey = `${key}:seq`;
    const seq = (this.strings.get(seqKey)?.value ?? '0');
    const nextSeq = String(Number(seq) + 1);
    this.setStr(seqKey, nextSeq, windowMs * 2);
    zset.set(`${nowMs}:${nextSeq}`, nowMs);
    this.zsets.set(key, zset);
    return [1, limit - count - 1, 0];
  }

  // --- Helpers ---

  private getStr(key: string): string | undefined {
    const entry = this.strings.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && this._nowMs >= entry.expiresAt) {
      this.strings.delete(key);
      return undefined;
    }
    return entry.value;
  }

  // Returns remaining TTL in seconds (for fixed-window TTL return value).
  private setStr(key: string, value: string, ttlMs?: number): number | undefined {
    const existing = this.strings.get(key);
    const expiresAt = ttlMs !== undefined
      ? this._nowMs + ttlMs
      : existing?.expiresAt;
    if (expiresAt !== undefined) {
      this.strings.set(key, { value, expiresAt });
      return Math.ceil((expiresAt - this._nowMs) / 1000);
    }
    this.strings.set(key, { value });
    return undefined;
  }

  private setHash(key: string, fields: Record<string, string>, ttlMs?: number): void {
    const existing = this.hashes.get(key) ?? new Map<string, string>();
    for (const [k, v] of Object.entries(fields)) existing.set(k, v);
    this.hashes.set(key, existing);
    // Store TTL alongside hash in a separate expiry tracker
    if (ttlMs !== undefined) {
      this.strings.set(`__ttl__${key}`, {
        value: '1',
        expiresAt: this._nowMs + ttlMs,
      });
    }
  }

  private evictExpired(): void {
    for (const [key, entry] of this.strings) {
      if (entry.expiresAt !== undefined && this._nowMs >= entry.expiresAt) {
        this.strings.delete(key);
        // If a hash TTL expired, evict the hash too
        if (key.startsWith('__ttl__')) {
          this.hashes.delete(key.slice(7));
        }
      }
    }
  }

  // Add a member to a Redis Set (for testing denylist/allowlist in master scripts).
  sadd(key: string, member: string): void {
    const s = this.sets.get(key) ?? new Set<string>();
    s.add(member);
    this.sets.set(key, s);
  }

  // Reset all state between tests.
  flush(): void {
    this.strings.clear();
    this.hashes.clear();
    this.zsets.clear();
    this.sets.clear();
  }
}
