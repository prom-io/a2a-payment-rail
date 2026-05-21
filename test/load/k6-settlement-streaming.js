import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 5 },
    { duration: '2m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<450'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3003';

export default function () {
  const health = http.get(`${BASE_URL}/health`);
  check(health, { 'health ok': (r) => r.status === 200 });

  const metrics = http.get(`${BASE_URL}/metrics`);
  check(metrics, { 'metrics ok': (r) => r.status === 200 });

  sleep(1);
}
