# Service level objectives (targets, pre-launch)

These are **internal targets** to operate against once deployed. Nothing is promised to customers yet, and none have been measured in production (the system is not deployed).

| SLI | Measurement | SLO (28-day) | Error budget |
| --- | --- | --- | --- |
| API availability | non-5xx / all requests, excluding 4xx | 99.9% | ~40 min |
| API latency | p95 of `/v1/*` GET (Workers analytics) | < 300 ms | 5% of requests may exceed |
| Import freshness | CSV upload → job `done` | 95% within 2 min | — |
| Event delivery | event created → webhook delivered (2xx) | 99% within 5 min (excluding receiver failures) | — |
| Daily scheduler | `scheduler_runs` rows `ok` for each tenant and job per day | 99.5% | failures visible in `/v1/ops/summary` and `/v1/admin/overview` |
| Data durability | D1 Time Travel + R2 | RPO ≤ 24 h, RTO ≤ 4 h | restore drill quarterly (docs/runbook) |
| Correctness | ledger balanced (trial balance debits = credits) | 100% | any breach is a P1 |

## Alerting (to set up at deploy)
- Page: availability burn rate > 14.4× over 1 h; trial balance imbalance; DLQ depth > 0 for 15 min.
- Ticket: scheduler failures on two consecutive days; webhook auto-disable; p95 latency over target for 1 day.

## Dashboards
- Tenant view: Ops page in the web app (`/v1/ops/summary`).
- Operator view: Admin page (`/v1/admin/overview`, `ADMIN_EMAILS` only, counts only).
