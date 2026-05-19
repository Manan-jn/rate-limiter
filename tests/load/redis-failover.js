import http from 'k6/http';
import { check } from 'k6';

// Redis failover test: verify fail-open behavior during Redis outage
// Run with: FAIL_STRATEGY=open (default) — expects 0 errors during outage
// Kill Redis manually mid-test, restart, verify recovery < 3s
export const options = {
  vus: 50,
  duration: '60s',
  thresholds: {
    http_req_failed: ['rate<0.001'],  // no 5xx errors (service should fail-open)
    http_req_duration: ['p(99)<100'], // relaxed during recovery
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TENANT_ID = 'failover-tenant';

export function setup() {
  http.post(
    `${BASE_URL}/api/v1/tenants`,
    JSON.stringify({
      tenantId: TENANT_ID,
      defaultAlgorithm: 'sliding_window_counter',
      defaultLimit: 100_000,
      windowSec: 60,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${__ENV.ADMIN_TOKEN || 'dev-token'}`,
      },
    }
  );
}

export default function () {
  const res = http.post(
    `${BASE_URL}/api/v1/check`,
    JSON.stringify({
      tenantId: TENANT_ID,
      clientKey: `vu-${__VU}`,
      route: 'POST:/api/orders',
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: '5s',
    }
  );
  // Fail-open: should return 200 even if Redis is down (circuit breaker opened)
  check(res, { 'no 5xx': r => r.status < 500 });
}
