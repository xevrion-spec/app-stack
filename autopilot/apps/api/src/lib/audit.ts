import type { TenantDb } from "./db.js";
import { newId } from "./db.js";

/** Append-only audit record. Returned as a statement so writes and their audit commit atomically in one batch. */
export function auditStmt(db: TenantDb, actor: string, action: string, subject: string, meta?: unknown): D1PreparedStatement {
  return db.stmt(
    "insert into audit_log (tenant_id, id, actor, action, subject, meta_json) values (?1, ?2, ?3, ?4, ?5, ?6)",
    newId(),
    actor,
    action,
    subject,
    meta === undefined ? null : JSON.stringify(meta),
  );
}
