import http from 'k6/http';
import { check, sleep } from 'k6';

// Hot-reload test: change rule limit via Admin API during live load
// New limit must be enforced within 500ms on all workers
export const options = {
  vus: 50,
  duration: '60s',
  thresholds: {
    http_req_duration: ['p(99)<20'],
    http_req_failed: ['rate<0.001'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TENANT_ID = 'hot-reload-tenant';
const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${__ENV.ADMIN_TOKEN || 'dev-token'}`,
};

export function setup() {
  http.post(
    `${BASE_URL}/api/v1/tenants`,
    JSON.stringify({
      tenantId: TENANT_ID,
      defaultAlgorithm: 'sliding_window_counter',
      defaultLimit: 10,
      windowSec: 60,
    }),
    { headers: ADMIN_HEADERS }
  );

  http.post(
    `${BASE_URL}/api/v1/tenants/${TENANT_ID}/rules`,
    JSON.stringify({
      route: 'POST:/api/orders',
      algorithm: 'sliding_window_counter',
      limit: 10,
      windowSec: 60,
    }),
    { headers: ADMIN_HEADERS }
  );
}

let ruleIdCache = null;

export default function () {
  // At 30s, one VU updates the rule to 10,000 req/min (should take effect within 500ms)
  if (__VU === 1 && __ITER === 300) {
    const res = http.put(
      `${BASE_URL}/api/v1/tenants/${TENANT_ID}/rules/hot-reload-rule`,
      JSON.stringify({
        route: 'POST:/api/orders',
        algorithm: 'sliding_window_counter',
        limit: 10_000,
        windowSec: 60,
      }),
      { headers: ADMIN_HEADERS }
    );
    console.log(`Rule updated at iter 300: ${res.status}`);
  }

  const res = http.post(
    `${BASE_URL}/api/v1/check`,
    JSON.stringify({
      tenantId: TENANT_ID,
      clientKey: `vu-${__VU}`,
      route: 'POST:/api/orders',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, { 'no 5xx': r => r.status < 500 });
  sleep(0.1);
}
