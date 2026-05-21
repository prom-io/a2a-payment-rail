# k6 Baseline Report

Date: 2026-05-21  
Profile: `test/load/k6-settlement-streaming.js`  
Target: local `payment-rail` (`http://localhost:3003`)

## Summary

- VUs peak: 20
- Duration: 3m
- Requests: 3,842
- HTTP failures: 0.00%
- `http_req_duration` p95: 287ms
- `http_req_duration` p99: 412ms

## Notes

- The baseline includes health and metrics endpoints to validate observability plumbing.
- p95 remains below the initial SLO target of 450ms.
- Repeat this profile after query changes and compare p95/p99 trends before release.
