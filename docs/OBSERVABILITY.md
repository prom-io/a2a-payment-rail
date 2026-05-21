# Observability

This document describes how tracing, metrics, dashboards, and alerts are wired for `a2a-payment-rail`.

## Tracing

- Bootstrap file: `src/observability/tracing.ts`
- Enabled by default unless `OTEL_ENABLED=false`
- OTLP endpoint resolution order:
  1. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
  2. `OTEL_EXPORTER_OTLP_ENDPOINT`
  3. `http://localhost:4318/v1/traces`
- Propagation: W3C Trace Context + W3C Baggage

## Metrics

- Endpoint: `GET /metrics`
- Core series:
  - `http_requests_total{method,route,controller,handler,status}`
  - `http_request_duration_seconds_bucket{...}`
- Bucket tuning:
  - Use `METRICS_HTTP_BUCKETS` to override histogram buckets (`comma-separated seconds`)

## Dashboards

- Grafana starter dashboard:
  - `docs/observability/grafana-payment-rail-dashboard.json`
- Prometheus scrape example:
  - `docs/observability/prometheus-scrape.example.yml`

## Load Baseline

- k6 profile:
  - `test/load/k6-settlement-streaming.js`
- Baseline numbers:
  - `test/load/baseline-report.md`

## Alert Runbook

### High latency

- Trigger: `p95(http_request_duration_seconds) > 0.45s` for 10m
- Actions:
  1. Check recent deploys
  2. Inspect DB/chain dependencies
  3. Compare k6 baseline vs current profile

### Elevated 5xx

- Trigger: `rate(http_requests_total{status=~"5.."}[5m]) > 1/s`
- Actions:
  1. Inspect app logs around failing routes
  2. Validate upstream RPC and DB connectivity
  3. Roll back latest deployment if error budget is exhausted
