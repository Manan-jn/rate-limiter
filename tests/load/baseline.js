import http from 'k6/http';
import { check, sleep } from 'k6';

// Baseline: 100 VUs, 60s, all requests within limit → P99 < 15ms
export const options = {
  vus: 100,
  duration: '60s',
  thresholds: {
    http_req_duration: ['p(99)<15'],     // P99 < 15ms
    http_req_failed: ['rate<0.001'],      // < 0.1% non-rate-limit errors
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TENANT_ID = 'baseline-tenant';

export function setup() {
  // Create a tenant with a high limit so requests are not rate-limited
  const res = http.post(
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
  console.log(`Setup tenant: ${res.status}`);
}

export default function () {
  const res = http.post(
    `${BASE_URL}/api/v1/check`,
    JSON.stringify({
      tenantId: TENANT_ID,
      clientKey: `vu-${__VU}`,
      route: 'POST:/api/orders',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, {
    'status is 200': r => r.status === 200,
    'allowed': r => JSON.parse(r.body).allowed === true,
  });
}
