# Performance review (feature/harden, 25 Oct 2026)

All figures are from synthetic data on the shared dev box (Node 22 + better-sqlite3 standing in for D1). They are relative
measurements, not production SLO evidence. D1 adds network round trips, which makes the batching and N+1 fixes matter
more in production than they do here.

## Findings and fixes

| #   | Finding (EXPLAIN QUERY PLAN / review)                                                                                   | Fix                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `select … from users where email = ?1` ran on **every authenticated request** as a full `SCAN users`                    | `idx_users_email` (migration 0010)                                                                |
| 2   | Receipt de-dupe `documents where tenant_id=? and sha256=?` was a scan                                                   | `idx_docs_sha`                                                                                    |
| 3   | `/v1/transactions`, `/v1/events`, `/v1/activity` used `USE TEMP B-TREE FOR ORDER BY`                                    | `idx_txn_list`, `idx_events_list`, `idx_audit_list` (keyset-order indexes)                        |
| 4   | Retention sweep, journals-by-source, exceptions-by-status, credit notes by invoice, schedules, notifications were scans | matching tenant-prefixed indexes in 0010                                                          |
| 5   | Bank sync inserted transactions one statement per row (N+1 round trips)                                                 | a single `TenantDb.batch` round trip; `batch` now returns rows changed per statement              |
| 6   | `/v1/export/transactions.csv` built the whole tenant in memory                                                          | streams with `ReadableStream` keyset pages (2,000 rows, `(txn_date,id)`); audit row written first |
| 7   | `/v1/export/ledger.json` grouping copied arrays on every row (O(n²))                                                    | O(n) push                                                                                         |
| 8   | No global request-body cap: handlers buffered the whole body before their own size checks                               | streaming `bodyLimit` (2 MB, receipts 10 MB) before any handler                                   |

All indexes are additive (`create index if not exists`) and have a down migration. The up/down/up round trip in
`reliability.test.ts` covers 0010 automatically.

## Before/after

**In-process benchmark at 100,000 transactions** (`npx tsx scripts/perf-bench.ts 100000 [--without-0010]`):

| Endpoint                                              | without 0010 p50 / p95 | with 0010 p50 / p95                 |
| ----------------------------------------------------- | ---------------------- | ----------------------------------- |
| GET /v1/transactions?limit=50                         | 46.5 / 58.9 ms         | **0.9 / 2.6 ms** (about 50× faster) |
| GET /v1/books/reports/pnl                             | 0.6 / 1.3 ms           | 0.6 / 1.6 ms                        |
| POST /v1/assistant/ask                                | 198 / 277 ms           | 200 / 256 ms                        |
| GET /v1/export/transactions.csv (100k rows, streamed) | 366 / 381 ms           | 362 / 376 ms                        |

**HTTP load test, A/B on a fresh database** (16 workers for 20 s, `scripts/load.ts`):

|                          | without 0010 | with 0010          |
| ------------------------ | ------------ | ------------------ |
| Throughput               | 468 rps      | **581 rps (+24%)** |
| Overall p95              | 65.4 ms      | **48.0 ms**        |
| Read p95                 | 47.8 ms      | **38.2 ms**        |
| GET /v1/transactions p99 | 103.7 ms     | **61.4 ms**        |
| 5xx                      | 0            | 0                  |

The 429s on `bank-csv` are the monthly plan quota (`quota_exceeded`). That is intended behaviour, not throttling.

## Budgets enforced in CI (`apps/api/test/perf-guards.test.ts`)

- **N+1 guard.** The number of `DB.prepare` calls must be identical at 20 and 400 transactions for:
  - transactions;
  - invoices;
  - aged debtors;
  - onboarding;
  - ops summary;
  - exceptions;
  - recurring.
- **10k-transaction tenant budgets** (×4 slack in the parallel suite, strict with `PERF=1`):
  - list < 250 ms;
  - P&L < 1.5 s;
  - assistant < 1.5 s;
  - export < 2.5 s, and the export must be complete (10,001 lines) and date-ordered.
- **100k-transaction budgets** (`PERF=1`): first page < 300 ms; export < 20 s.
- **Bundles:**
  - web bundle 61.1 KB gzip, against a budget of 80 KB;
  - Worker bundle 1.22 MB minified / 368 KB gzip, which is well under the Workers size limit;
  - module evaluation about 130 ms in Node. This is an indicative cold-start number only.

## Caching

ETag / `If-None-Match` already exists for invoice reads (version-based). KV caching of reports was considered and rejected for
now. Reports are sub-2 ms with the indexes, and a tenant-scoped KV key adds invalidation risk (stale figures in a tax
product) for no measurable gain. Revisit when the P&L p95 on D1 exceeds 100 ms.

## Practice perf budgets (M6, 2026-10-25)
`practice-ops.test.ts` seeds 25 clients through the API plus bulk transactions (2k by default; `PERF=1` gives 250k). The budgets are: client list < 1.5 s (5 s with PERF) and practice anomalies < 5 s (20 s with PERF), and EXPLAIN must show an index on every practice hot path. Both modes passed locally. These are in-process sqlite numbers, not D1 latencies.
