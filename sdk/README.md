# @whomj/rate-limiter-sdk

[![npm](https://img.shields.io/npm/v/@whomj/rate-limiter-sdk)](https://www.npmjs.com/package/@whomj/rate-limiter-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

SDK for the [rate-limiter service](https://github.com/Manan-jn/rate-limiter) — plug distributed rate limiting into any **Fastify** or **Express** app in 3 lines.

## Install

```bash
npm install @whomj/rate-limiter-sdk
```

## Usage

### Fastify

```typescript
import { rateLimitPlugin } from '@whomj/rate-limiter-sdk';

await app.register(rateLimitPlugin, {
  serviceUrl: process.env.RATE_LIMITER_URL,  // e.g. http://rate-limiter:8080
  tenantId: 'my-service',
  keyExtractor: 'ip',  // or 'api-key-header' | 'jwt-sub' | 'composite'
});
```

### Express

```typescript
import { expressRateLimit } from '@whomj/rate-limiter-sdk';

app.use(expressRateLimit({
  serviceUrl: process.env.RATE_LIMITER_URL,
  tenantId: 'my-service',
  keyExtractor: 'api-key-header',
  keyHeader: 'x-api-key',  // which header holds the API key
}));
```

## Config

| Option | Type | Default | Description |
|---|---|---|---|
| `serviceUrl` | string | — | Rate limiter service base URL |
| `tenantId` | string | — | Your service's tenant identifier |
| `keyExtractor` | string | `'ip'` | `'ip'` `'api-key-header'` `'jwt-sub'` `'composite'` |
| `keyHeader` | string | `'x-api-key'` | Header name (when `keyExtractor='api-key-header'`) |
| `checkSecret` | string | — | HMAC-SHA256 shared secret (set on the service side too) |
| `failOpen` | boolean | `true` | Allow requests when the service is unreachable |

## Response Headers

The SDK sets standard headers on every response:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Configured limit |
| `X-RateLimit-Remaining` | Requests left in window |
| `X-RateLimit-Reset` | Unix timestamp of window reset |
| `Retry-After` | Seconds to wait (only on 429) |

## License

MIT
