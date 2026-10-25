import type { TenantDb } from "./db.js";
import { newId } from "./db.js";

let last = 0;
/** Strictly increasing ISO timestamps (ms) so the activity feed has a total order even within one batch. */
export function monotonicIso(): string {
  last = Math.max(Date.now(), last + 1);
  return new Date(last).toISOString();
}

/** Append-only audit record. Returned as a statement so writes and their audit commit atomically in one batch. */
export function auditStmt(db: TenantDb, actor: string, action: string, subject: string, meta?: unknown): D1PreparedStatement {
  return db.stmt(
    "insert into audit_log (tenant_id, id, actor, action, subject, meta_json, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    newId(),
    actor,
    action,
    subject,
    meta === undefined ? null : JSON.stringify(meta),
    monotonicIso(),
  );
}
