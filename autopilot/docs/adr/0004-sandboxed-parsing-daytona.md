# ADR 0004: Parse untrusted documents in Daytona sandboxes
Status: accepted

All customer file parsing runs in an ephemeral, no-network Daytona sandbox behind hard cost guardrails (concurrency 1, daily cap, auto-delete, janitor), with a local parser fallback. Trade-off: per-job cost and latency (~seconds) in exchange for isolation from untrusted input.
