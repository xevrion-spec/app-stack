/**
 * Retention + legal hold (A9b). Redaction removes content (payloads, context, decision reasons/edits, callback and
 * event bodies) but never the audit chain: a `redacted` ledger entry pins the hash of the placeholder, so integrity
 * checks still pass and earlier entries keep the original payload hashes as proof of what was approved.
 */
import { TenantDb } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import type { Env } from "../env.js";
import { appendStmts, payloadSha } from "./agent-review-ledger.js";
import { loadReview, type RequestRow } from "./agent-review.js";

export const REDACTED = '{"redacted":true}';
const FINAL = ["approved", "rejected", "expired", "cancelled"];

export async function redactStmts(db: TenantDb, r: RequestRow, actor: string, reason: "retention" | "erasure", at = new Date().toISOString()) {
  if (!FINAL.includes(r.status)) throw new AppError(409, "not_final", "Only final requests can be redacted");
  if (r.legal_hold_at) throw new AppError(409, "legal_hold", "Request is under legal hold");
  if (r.redacted_at) throw new AppError(409, "already_final", "Request is already redacted");
  const chain = await appendStmts(db, r.id, { seq: r.chain_seq, head: r.chain_head }, [
    { kind: "redacted", actor, at, data: { reason, payloadSha256: await payloadSha(REDACTED) } },
  ]);
  const body = JSON.stringify({ requestId: r.id, redacted: true });
  return [
    // Guard that aborts the whole batch: if the row moved on (a concurrent hold, decision or redaction bumped its
    // version or set a hold), chain_seq becomes NULL and the NOT NULL constraint rolls everything back.
    db.stmt(
      "update review_requests set payload_json = ?3, current_payload_json = ?3, context_json = null, redacted_at = ?4, chain_seq = case when version = ?7 and legal_hold_at is null and redacted_at is null then ?5 end, chain_head = ?6, version = version + 1, updated_at = ?4 where tenant_id = ?1 and id = ?2",
      r.id,
      REDACTED,
      at,
      chain.seq,
      chain.head,
      r.version,
    ),
    ...chain.stmts,
    db.stmt(
      "update review_decisions set reason = null, payload_json = case when payload_json is null then null else ?3 end where tenant_id = ?1 and request_id = ?2",
      r.id,
      REDACTED,
    ),
    db.stmt("update review_callbacks set body_json = ?3 where tenant_id = ?1 and request_id = ?2", r.id, body),
    db.stmt("update events set payload_json = ?3 where tenant_id = ?1 and type like 'review.%' and json_extract(payload_json, '$.requestId') = ?2", r.id, body),
    auditStmt(db, actor, `agent_review.redacted`, r.id, { reason }),
  ];
}

/** Daily: redact final, un-held requests older than their project's retention. Returns how many were redacted. */
export async function sweepRetention(env: Env, at = new Date(), limit = 500): Promise<{ redacted: number; skipped: number }> {
  const due =
    (
      await env.DB.prepare(
        `select r.tenant_id, r.id from review_requests r join review_projects p on p.tenant_id = r.tenant_id and p.id = r.project_id
         where p.retention_days is not null and r.redacted_at is null and r.legal_hold_at is null and r.decided_at is not null
           and r.decided_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '-' || p.retention_days || ' days')
         order by r.decided_at limit ?2`,
      )
        .bind(at.toISOString(), limit)
        .all<{ tenant_id: string; id: string }>()
    ).results ?? [];
  const out = { redacted: 0, skipped: 0 };
  for (const d of due) {
    const db = new TenantDb(env.DB, d.tenant_id);
    try {
      await db.batch(await redactStmts(db, await loadReview(db, d.id, null), "system:retention", "retention", at.toISOString()));
      out.redacted++;
    } catch (e) {
      if (!(e instanceof AppError) && !/UNIQUE|NOT NULL/.test(String(e))) throw e;
      out.skipped++;
    }
  }
  return out;
}
