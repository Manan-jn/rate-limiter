# @whomj/rate-limiter-sdk

[![npm](https://img.shields.io/npm/v/@whomj/rate-limiter-sdk)](https://www.npmjs.com/package/@whomj/rate-limiter-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue)](https://www.typescriptlang.org)

Client SDK for the [rate-limiter service](https://github.com/Manan-jn/rate-limiter) — add distributed rate limiting to any **Fastify** or **Express** app in 3 lines. Backed by atomic Redis Lua scripts, supports 5 algorithms, 107k req/s verified on GCP.

---

## Install

```bash
npm install @whomj/rate-limiter-sdk
```

---

## Usage

### Fastify

```typescript
import { rateLimitPlugin } from '@whomj/rate-limiter-sdk';

await app.register(rateLimitPlugin, {
  serviceUrl: process.env.RATE_LIMITER_URL,   // e.g. http://rate-limiter:8080
  tenantId: 'my-service',
  keyExtractor: 'ip',                          // or 'api-key-header' | 'jwt-sub' | 'composite'
});
```

### Express

```typescript
import { expressRateLimit } from '@whomj/rate-limiter-sdk';

app.use(expressRateLimit({
  serviceUrl: process.env.RATE_LIMITER_URL,
  tenantId: 'my-service',
  keyExtractor: 'api-key-header',
  keyHeader: 'x-api-key',
}));
```

---

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `serviceUrl` | `string` | required | Rate limiter service base URL |
| `tenantId` | `string` | required | Your service's tenant identifier |
| `keyExtractor` | `string` | `'ip'` | How to identify the client — see below |
| `keyHeader` | `string` | `'x-api-key'` | Header name when `keyExtractor = 'api-key-header'` |
| `checkSecret` | `string` | — | HMAC-SHA256 shared secret for request signing |
| `failOpen` | `boolean` | `true` | Allow requests if rate limiter is unreachable |

### Key Extractors

| Value | Identifies client by |
|---|---|
| `'ip'` | Remote IP address (`req.ip`) |
| `'api-key-header'` | Value of a header (e.g. `x-api-key`) |
| `'jwt-sub'` | `sub` claim from the Bearer JWT |
| `'composite'` | `ip + api-key` combined |

---

## Response Headers

Set on every response (allowed or denied):

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Configured limit for this client |
| `X-RateLimit-Remaining` | Requests left in the current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |
| `Retry-After` | Seconds to wait — **only present on 429** |

On a `429 Too Many Requests`:

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1716134460
Retry-After: 42
```

---

## Algorithms

The rate limiter service supports 5 algorithms, configurable per tenant and per route. The SDK works with all of them transparently — the algorithm decision is made server-side.

| Algorithm | Space | Accuracy | Best for |
|---|---|---|---|
| `sliding_window_counter` | O(1) | ~99% | Default — most API rate limiting |
| `token_bucket` | O(1) | High | APIs with legitimate burst traffic |
| `sliding_window_log` | O(N) | Exact | Billing, compliance limits |
| `fixed_window` | O(1) | Medium | Simple quotas, low traffic |
| `leaky_bucket` | O(queue) | Exact | Egress throttle (per-worker) |

**Sliding Window Counter** is the default and recommended for most use cases — O(1) Redis space, no boundary burst problem, ~99% accurate using a weighted two-window estimate.

**Token Bucket** is best when clients need to absorb short traffic spikes. The `burst` parameter lets clients build up credit above the steady-state rate.

---

## Performance

The backing service is benchmarked on GCP bare-metal Linux with a dedicated load-test VM in the same zone (0.3ms RTT). All results at zero failures.

| Machine | vCPU | Sustained req/s | P50 | P99 |
|---|---|---|---|---|
| e2-standard-2 | 2 | 8,364 | 34ms | 71ms |
| n2-standard-4 | 4 | 23,135 | 12ms | 26ms |
| n2-standard-8 | 8 | 46,876 | 5.9ms | 13.5ms |
| c2d-standard-8 (AMD) | 8 | 59,760 | 4.6ms | 10.5ms |
| **c3-standard-8 (Sapphire Rapids)** | **8** | **107,967** | **2.3ms** | **9.7ms** |

120s stress test on c3-standard-8: **12,966,538 requests served, 0 failures**.

The throughput ceiling is Redis single-threaded Lua execution. CPU IPC (instructions per clock) is the primary lever — newer CPU generations raise the ceiling without adding cores.

---

## Scaling

### Vertical (single instance)

| Config | req/s | Notes |
|---|---|---|
| 2 vCPU, 2 workers | ~8k | Dev / small workloads |
| 4 vCPU, 4 workers | ~23k | Production baseline |
| 8 vCPU, 8 workers (n2) | ~47k | Standard production |
| 8 vCPU, 8 workers (c3 Sapphire) | **~108k** | High-performance production |

> **CPU generation matters more than core count.** A c3-standard-8 (Sapphire Rapids 2023) delivers 2.3× more throughput than an n2-standard-8 (Cascade Lake 2019) at the same 8 vCPU count. Redis is single-threaded — faster IPC means faster Lua execution means higher throughput.

### Horizontal (beyond one instance)

| Strategy | Ceiling | Trade-off |
|---|---|---|
| Redis Cluster (3 shards) | ~320k req/s | Lua scripts must use hash tags `{key}` for slot routing |
| 2 replicas × own Redis | ~216k req/s | Limits approximate (per-replica, not global) |
| 4 replicas × Redis Cluster | ~640k req/s | Most complex; use only at very high scale |

### Worker Count

Adding Node.js workers past **2 per Redis instance** creates diminishing returns — all workers contend for the same Redis single thread. The right lever is **CPU generation** (machine type), not worker count.

| Workers | req/s (n2-std-8) | Notes |
|---|---|---|
| 1 | 8,366 | Baseline |
| **2** | **11,320** | **+35% — optimal per Redis instance** |
| 8 | 9,179 | Worse than 2 — Redis queue contention |

---

## Load Testing

The service ships with [k6](https://k6.io) load test scripts at `tests/load/` in the repository.

### Scripts

| Script | Scenario | Pass Criteria |
|---|---|---|
| `baseline.js` | 100 VUs, 60s, within limit | P99 < 15ms, error rate < 0.1% |
| `overload.js` | 500 VUs, 5× the limit | 429 rate > 70%, no 5xx |
| `burst.js` | Token bucket: 150 → 50 VUs | Burst absorbed, steady-state respected |
| `multitenant.js` | 10 tenants × 50 VUs | Each tenant's quota isolated |
| `hot-reload.js` | Rule change mid-load | New limit enforced within 500ms |
| `redis-failover.js` | Kill Redis, restart | Fail-open: 0 errors during outage |

### Running

```bash
# Against local Docker stack
k6 run --env BASE_URL=http://localhost:8080 tests/load/baseline.js

# Overload test
k6 run --env BASE_URL=http://localhost:8080 tests/load/overload.js
```

### Observed Results (c3-standard-8)

```
wrk -t12 -c200 -d120s http://rate-limiter:8080/api/v1/check

Running 2m test @ http://rate-limiter:8080/api/v1/check
  12 threads and 200 connections
  Thread Stats   Avg      Stdev     Max
    Latency     1.52ms    1.8ms   28ms
    Req/Sec     9.00k     1.2k    11.2k
  12,966,538 requests in 2m0s
  Requests/sec: 107,967
  Transfer/sec: 42MB
```

---

## How It Works

The SDK calls `POST /api/v1/check` on the rate limiter service for every incoming request. The service runs a **master Lua script** inside Redis that performs all checks in a **single atomic round-trip**:

```
① SISMEMBER denylist        — is this client banned?
② SISMEMBER allowlist       — is this client whitelisted?
③ redis.call('TIME')        — authoritative server time (no clock skew)
④ algorithm counter logic   — INCR / HMGET / ZADD depending on algorithm
```

Previously this was 4 sequential Redis round-trips per request. Collapsing to 1 RTT unlocked the throughput from ~12k to ~108k req/s on the same hardware.

The SDK respects the service's **fail-open** default — if the rate limiter is unreachable, requests pass through rather than blocking your users.

---

## License

MIT — [Manan Jain](https://github.com/Manan-jn)
