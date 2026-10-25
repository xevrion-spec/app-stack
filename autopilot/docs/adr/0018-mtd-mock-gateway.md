# ADR 0018: MTD ITSA via a gateway interface; mock-only, confirm-gated, stored as sandbox

Status: Accepted (2026-10-25)

## Decision
`MtdGateway` (obligations, submitQuarterlyUpdate) has only `MockMtdGateway`. The API builds the quarterly update from the
ledger (SA103 mapping, UNVERIFIED), offers a preview, and submits only when an owner sends `confirm: true`. Every submission
is stored in `mtd_submissions` with `sandbox = 1` and a unique (tenant, period). Responses say "MOCK submission: nothing was
sent to HMRC". Connecting to HMRC (sandbox or live) needs HMRC developer registration, a fraud-prevention-headers implementation,
OAuth, and Henry's approval. None of that is done.
