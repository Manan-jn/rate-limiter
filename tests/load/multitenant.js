import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

// 10 tenants × 50 VUs each — each tenant's 429 rate should match their own limit
export const options = {
  vus: 500, // 10 tenants × 50 VUs
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(99)<20'],
    http_req_failed: ['rate<0.001'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TENANTS = Array.from({ length: 10 }, (_, i) => `mt-tenant-${i}`);

export function setup() {
  for (const tenantId of TENANTS) {
    http.post(
      `${BASE_URL}/api/v1/tenants`,
      JSON.stringify({
        tenantId,
        defaultAlgorithm: 'sliding_window_counter',
        defaultLimit: 200,
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
}

export default function () {
  // Each VU picks a tenant deterministically
  const tenantId = TENANTS[(__VU - 1) % TENANTS.length];

  const res = http.post(
    `${BASE_URL}/api/v1/check`,
    JSON.stringify({
      tenantId,
      clientKey: `vu-${__VU}`,
      route: 'POST:/api/orders',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, { 'no 5xx': r => r.status < 500 });
}
