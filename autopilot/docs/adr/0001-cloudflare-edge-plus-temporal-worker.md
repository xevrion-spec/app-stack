# ADR 0001: Cloudflare edge + Temporal worker
Status: accepted

Edge (Workers/D1/R2/Queues) for API, storage and state; long-running AI work in a Temporal worker (local now, Coolify-hosted later). Reason: cheap, global, secure edge; durable retries for multi-step jobs. Trade-off: two runtimes.
