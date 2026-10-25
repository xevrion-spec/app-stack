# Backup, restore and disaster recovery

**Targets:** RPO ≤ 1 minute for D1 (via Time Travel) and RTO ≤ 1 hour. These are targets, not a tested production
guarantee. **No restore drill has been run against a live account yet.**

| Store                       | Protection                                                                                                                                                                              | Restore                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 (ledger, tenants, audit) | D1 Time Travel: point-in-time restore to any minute in the last 30 days (paid plan; 7 days on free). Plus a nightly `wrangler d1 export` SQL dump to a private R2 bucket (to configure) | `wrangler d1 time-travel info <db>`, then `wrangler d1 time-travel restore <db> --timestamp=<RFC3339>`; or import the dump into a fresh DB and repoint the binding |
| R2 (receipts, exports)      | Objects are content-addressed (sha256) and immutable; enable bucket versioning/lifecycle; optional replication to a second bucket                                                       | Copy back the object version                                                                                                                                       |
| Queues                      | At-least-once; the DLQ keeps failures; the outbox table is the source of truth for events                                                                                               | Replay from the outbox (`reliability.test.ts` covers DLQ + outbox)                                                                                                 |
| KV                          | Cache/config only; rebuildable                                                                                                                                                          | None needed                                                                                                                                                        |

## Runbook

1. **Declare the incident.**
   1. Freeze writes by setting `MAINTENANCE=1` (returns 503 on writes).
   2. Note the last-known-good time.
2. **Restore D1.** Run `wrangler d1 time-travel restore` to the timestamp _before_ the bad event. Time Travel restores
   are themselves undoable, because restoring returns a bookmark.
3. **Reconcile.**
   1. Re-run the outbox for events after the restore point.
   2. Webhooks are idempotent for receivers via event id.
4. **Verify.**
   1. Run the migrations status check.
   2. Run the smoke suite against the restored DB.
   3. Compare ledger trial balance totals with the pre-incident report.
5. **Post-mortem** within 5 working days, and update this document.

Schema safety: every migration has a down script, and up → down → up is tested in CI (`reliability.test.ts`).
Migrations are additive-first.

## Still to do before real customers

- Schedule the nightly export to R2.
- Run a timed restore drill on staging and record the actual RTO.
- Add an alert when the export job fails.

## Automated backup/restore drill (M6, 2026-10-25)
`apps/api/test/practice-ops.test.ts` runs on every CI build. It covers backup, read-only restore, integrity_check, per-table row counts plus sha256 equality, and audit-chain re-verification with tamper detection. Locally the restore took well under the 5 s budget. **Not yet done:** a D1 Time Travel restore rehearsal against a real Cloudflare database. That needs a deploy, which is out of scope.
