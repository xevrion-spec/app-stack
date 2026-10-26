import * as R from "@xevrion/agent-review";
import type { TenantDb } from "../lib/db.js";

/**
 * Live delivery for review state (R2). Writers call `wake` after commit; `/wait`, `/stream` and the tenant feed sleep on
 * the bus with a poll fallback. Same-isolate wake-ups are immediate; cross-isolate ones fall back to the poll interval
 * (a Durable Object fan-out would make those immediate too, and it is not built).
 */
export const bus = R.createBus();
export const requestKey = (tenantId: string, id: string) => `${tenantId}:r:${id}`;
export const tenantKey = (tenantId: string) => `${tenantId}:*`;
export function wake(tenantId: string, id: string): void {
  bus.publish(requestKey(tenantId, id));
  bus.publish(tenantKey(tenantId));
}

export type FeedItem = { id: string; projectId: string; action: string; risk: string; status: string; version: number; updatedAt: string; cursor: string };
type FeedRow = { id: string; project_id: string; action: string; risk: string; status: string; version: number; updated_at: string };

/** Changes after `cursor`, oldest first. Payloads are never included (fetch the request; redaction applies there). */
export async function feedPage(db: TenantDb, scope: string | readonly string[] | null, cursor: string | null, limit: number): Promise<FeedItem[]> {
  const c = R.decodeCursor(cursor);
  const set = scope === null ? null : typeof scope === "string" ? [scope] : scope;
  const rows = await db.all<FeedRow>(
    `select id, project_id, action, risk, status, version, updated_at from review_requests where tenant_id = ?1
       and (updated_at > ?2 or (updated_at = ?2 and id > ?3))${set ? " and project_id in (select value from json_each(?5))" : ""}
       order by updated_at, id limit ?4`,
    c?.updatedAt ?? "",
    c?.id ?? "",
    limit,
    ...(set ? [JSON.stringify(set)] : []),
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    action: r.action,
    risk: r.risk,
    status: r.status,
    version: r.version,
    updatedAt: r.updated_at,
    cursor: R.encodeCursor(r.updated_at, r.id),
  }));
}

/** Cursor for "from now on": the newest change, so a fresh subscriber does not replay history. */
export async function headCursor(db: TenantDb): Promise<string | null> {
  const r = await db.first<{ id: string; updated_at: string }>(
    "select id, updated_at from review_requests where tenant_id = ?1 order by updated_at desc, id desc limit 1",
  );
  return r ? R.encodeCursor(r.updated_at, r.id) : null;
}
