# Cost model (estimate, not verified)

All prices are **assumptions to check** on the providers' pricing pages before any decision; they were not verified when this was written (2026-10-25). Figures are per month.

## Platform (Cloudflare Workers Paid, ~$5/month base)
| Resource | Assumed included | Assumed overage | Autopilot driver |
| --- | --- | --- | --- |
| Workers requests | 10M | ~$0.30 / M | API calls, cron (43,200/month for the every-minute cron) |
| Workers CPU | 30M CPU-ms | ~$0.02 / M CPU-ms | pipeline categorisation, PDF, reports |
| D1 | 25B rows read, 50M rows written, 5 GB | per-row / per-GB | ledger, transactions, audit |
| R2 | 10 GB-month, 1M class A, 10M class B | ~$0.015 / GB-month | receipts, statements |
| Queues | 1M ops | ~$0.40 / M ops | pipeline + events dispatch |
| KV | generous free tier | small | config, daily gate |

## Per-customer usage (synthetic assumptions)
A typical sole trader: 150 bank transactions, 20 receipts (≈ 0.5 MB each), 6 invoices, ~2,000 API requests a month.

- Requests: 2,000 → 1,000 customers = 2M (inside the included 10M).
- D1 writes: ~150 transactions × (row + journal + 2 lines + audit + event) ≈ 1,000 rows → 1M rows for 1,000 customers (inside 50M).
- R2: 10 MB/customer/month, accumulating; 1,000 customers × 12 months ≈ 120 GB ≈ $1.65/month in year one.
- Queues: ~5 ops per transaction → 0.75M for 1,000 customers.

**Platform cost for 1,000 customers is roughly the $5 base plus a few dollars.** Infrastructure is not the main cost.

## Variable costs that DO matter (not yet chosen)
| Item | Driver | Formula |
| --- | --- | --- |
| LLM categorisation | only rows the rules miss (target < 20%) | rows × miss-rate × tokens/row × price/token |
| OCR / vision | receipts | receipts × price/page |
| Open Banking feed | connected accounts | accounts × provider fee |
| Payment links | paid invoices | provider % + fixed fee (usually passed through) |
| Email delivery | reminders, notifications | messages × price |
| Accountant review | escalations | humans: the real unit cost |

Example: with 1,000 customers, 30 LLM-categorised rows each at ~500 tokens and a $0.50 / M-token model ≈ $7.50/month; 20 receipts each at $0.002/page OCR ≈ $40/month. **Open Banking and human review dominate.** Pick providers, then fill in this sheet with real prices.

## Pricing implication (for Henry to decide)
Plans in `PLAN_FEATURES` (free / starter / pro / trial) are placeholders. Gross margin is high on software alone; the price floor is set by bank-feed fees and any human review included in a plan.
