export type Algorithm =
  | 'fixed_window'
  | 'sliding_window_counter'
  | 'token_bucket'
  | 'sliding_window_log'
  | 'leaky_bucket';

export type KeyExtractor = 'ip' | 'api_key_header' | 'jwt_sub' | 'composite';

export interface Rule {
  ruleId: string;
  tenantId: string;
  route: string;        // e.g. 'POST:/api/orders' or '*:/api/public'
  algorithm: Algorithm;
  limit: number;
  windowSec: number;
  burst?: number;       // token bucket only
  failOpen: boolean;
  dryRun: boolean;
  keyExtractor: KeyExtractor;
  keyHeader?: string;   // header name when keyExtractor = 'api_key_header'
}

export interface Tenant {
  tenantId: string;
  defaultAlgorithm: Algorithm;
  defaultLimit: number;
  windowSec: number;
  createdAt: number;
}

export interface RateLimitRequest {
  tenantId: string;
  route: string;
  clientKey: string;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;      // unix timestamp in seconds
  retryAfter: number;   // seconds; 0 when allowed
  algorithm: Algorithm;
  ruleId: string;
}

export interface RateLimiter {
  check(req: RateLimitRequest, rule: Rule): Promise<RateLimitResult>;
}

export interface Store {
  evalsha<T>(name: string, keys: string[], args: (string | number)[]): Promise<T>;
  nowMs(): Promise<number>;
}
