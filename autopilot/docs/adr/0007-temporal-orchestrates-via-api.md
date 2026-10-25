# ADR 0007: Temporal orchestrates the monthly close through the public API
Status: accepted (2026-10-25). Refines ADR 0001.

Stage execution stays in the Worker (Cloudflare Queue consumer with retries and a DLQ). Temporal (`packages/workflows`) owns the long-running, human-in-the-loop process: ingest, wait for the pipeline, wait for a reviewer (signal or polling, 72h default timeout), then draft VAT. Activities call the API through the generated SDK, authenticating with a Cloudflare Access service token in production.
Why: one implementation of the bookkeeping logic; Temporal adds durability and timers without duplicating it. Trade-off: an extra hop and the need for a service token (an operator must create it; not minted by automation).
