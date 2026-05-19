import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const rate429 = new Rate('rate_429');

// Overload: 500 VUs, 30s — 5× configured limit → verify 429 > 70%, no 5xx
export const options = {
  vus: 500,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(99)<25'],   // P99 < 25ms even under overload
    rate_429: ['rate>0.7'],            // at least 70% should be 429
    http_req_failed: ['rate<0.001'],   // no 5xx errors
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TENANT_ID = 'overload-tenant';

export function setup() {
  http.post(
    `${BASE_URL}/api/v1/tenants`,
    JSON.stringify({
      tenantId: TENANT_ID,
      defaultAlgorithm: 'sliding_window_counter',
      defaultLimit: 100,
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
      clientKey: 'overload-client',
      route: 'POST:/api/orders',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const is429 = res.status === 429;
  rate429.add(is429);

  check(res, { 'no 5xx': r => r.status < 500 });
  sleep(0.002);
}
