import http from 'k6/http';
import { check, sleep } from 'k6';

// Token Bucket burst test: 150 VUs burst → settle to 50 VUs steady state
export const options = {
  stages: [
    { duration: '10s', target: 150 }, // ramp up to burst
    { duration: '20s', target: 150 }, // sustain burst
    { duration: '10s', target: 50 },  // settle to steady state
    { duration: '20s', target: 50 },  // verify steady state holds
  ],
  thresholds: {
    http_req_duration: ['p(99)<20'],
    http_req_failed: ['rate<0.001'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TENANT_ID = 'burst-tenant';

export function setup() {
  // Token bucket: 50 req/s steady, burst up to 200
  http.post(
    `${BASE_URL}/api/v1/tenants/${TENANT_ID}/rules`,
    JSON.stringify({
      route: 'POST:/api/upload',
      algorithm: 'token_bucket',
      limit: 50,
      windowSec: 1,
      burst: 200,
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
      route: 'POST:/api/upload',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(res, { 'no 5xx': r => r.status < 500 });
  sleep(0.01);
}
