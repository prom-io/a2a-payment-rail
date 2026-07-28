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

## Alert Rules

The rule file is `docs/observability/prometheus-alerts.yml`. Load it alongside the scrape config:

```yaml
rule_files:
  - /etc/prometheus/prometheus-alerts.yml
```

### Thresholds

| Alert | Expression summary | For | Severity |
|---|---|---|---|
| `PaymentRailDown` | no successful scrape | 2m | critical |
| `SettlementFailureRateHigh` | settlement 5xx share > 5% | 10m | critical |
| `SettlementLatencyDegraded` | settlement p95 > 2s | 15m | warning |
| `EscrowDriftDetected` | > 5 escrows entered dispute in 1h | 5m | warning |
| `EscrowStuckSettling` | any session in `settling` | 30m | critical |
| `EscrowDepositTotalDropped` | held value fell > 20% in 10m | 5m | critical |

Thresholds are deliberately not uniform. `SettlementFailureRateHigh` waits 10 minutes because a single bad RPC endpoint recovers on its own inside that window, while `EscrowStuckSettling` waits 30 because `settling` is transient by design and anything longer means a broadcast never confirmed.

The two escrow value rules read gauges collected on scrape from the database (`payment_rail_escrow_*`), not counters incremented at write time. A settlement applied out of band — a manual replay, a reorg — leaves write-time counters wrong forever; a gauge read from the source of truth self-corrects on the next scrape.

### On-call routing

| Severity | Route | Response |
|---|---|---|
| critical | page immediately, any hour | money movement is affected or funds are locked |
| warning | working-hours ticket | degradation, no funds at risk yet |

Alertmanager grouping:

```yaml
route:
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: [severity="critical"]
      receiver: payment-rail-page
      repeat_interval: 1h
    - matchers: [severity="warning"]
      receiver: payment-rail-tickets
```

`EscrowDepositTotalDropped` is the one critical alert that fires legitimately during a large batch settlement. Cross-check it against settlement throughput before escalating: if `http_requests_total{controller="SettlementController"}` rose in the same window, the drop is expected.

### Verifying a rule change

```bash
promtool check rules docs/observability/prometheus-alerts.yml
promtool test rules docs/observability/alert-tests.yml   # once unit tests exist
```
