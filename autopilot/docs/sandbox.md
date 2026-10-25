# Sandboxed document parsing (Daytona)
**Why:** customer documents (CSV, PDF, images) are untrusted input. Parsing runs in a throwaway Daytona sandbox so a malicious
file can't reach our machine, secrets or network.

## Guardrails (`packages/sandbox/sandbox.config.json`, enforced in `guard.py`)
| Control | Setting |
|---|---|
| Max concurrent sandboxes | 1 |
| Daily create cap (budget) | 20/day; beyond that it refuses and falls back to the local parser |
| Exec timeout | 60 s per command |
| Auto-stop / auto-delete | stop after 5 min idle, delete immediately on stop; `ephemeral=true` |
| Network | `network_block_all=true` (no egress) |
| Resources | default snapshot (smallest class); no custom resources requested |
| Secrets | `env_vars={}`; only the input file is uploaded; no API keys inside |
| Labels | `app=xevrion-autopilot, tenant=<slug>, purpose=<job>` |
| Cleanup | sandbox deleted in a `finally` block; `janitor.py` deletes our sandboxes older than 15 min |

## Threat model
- **Malicious documents** (parser exploits, zip bombs, formula injection): isolated in a sandbox with no network and a timeout. Output is
  treated as untrusted JSON and validated before use; never `eval`.
- **Data retention**: tenant data exists only inside the ephemeral sandbox for one job; deleted straight after. Daytona is a
  sub-processor and must be listed in the privacy notice/DPA. Check their data location and retention terms.
- **Cost controls**: daily cap, concurrency 1, auto-stop/delete, janitor, usage counter shown in the console Foundations panel.
- **Failure**: any sandbox error/budget/limit leads to the local parser (synthetic data only until production hardening) with the reason recorded.

## Snapshot
`packages/sandbox/image/` defines a pinned parser image for PDF/XLSX. It isn't registered yet (snapshot storage may cost credit).
Before building, pin the base image digest.

## Commands
```
python packages/sandbox/tests/test_guard.py      # mocked, free
python packages/sandbox/janitor.py --dry-run     # list stale
python packages/sandbox/smoke_live.py            # LIVE: 1 sandbox, then deleted
```
