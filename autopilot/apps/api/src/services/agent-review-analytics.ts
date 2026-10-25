/** D3/D4 data access: windowed history for reviewer analytics and auto-approve suggestions. Bounded by MAX_ROWS. */
import * as R from "@xevrion/agent-review";
import type { TenantDb } from "../lib/db.js";

export const MAX_ROWS = 20_000;
export const since = (days: number, now = Date.now()) => new Date(now - days * 86_400_000).toISOString();

export function decisionRows(db: TenantDb, from: string, projectId: string | null): Promise<R.DecisionRow[]> {
  return db.all<R.DecisionRow>(
    `select d.reviewer as reviewer, d.decision as decision, d.request_id as requestId, r.created_at as requestCreatedAt, d.created_at as decidedAt, r.risk as risk
       from review_decisions d join review_requests r on r.tenant_id = d.tenant_id and r.id = d.request_id
      where d.tenant_id = ?1 and d.created_at >= ?2 and d.reviewer not like 'system:%' and d.reviewer not like 'policy:%' and (?3 is null or r.project_id = ?3)
      order by d.created_at desc limit ${MAX_ROWS}`,
    from,
    projectId,
  );
}

/** Human-routed, finished requests only (auto-decided ones would make the evidence circular). */
export async function outcomeRows(db: TenantDb, from: string, projectId: string): Promise<R.OutcomeRow[]> {
  const rows = await db.all<{ action: string; risk: R.RiskLevel; confidence: number | null; status: R.OutcomeRow["status"]; edited: number }>(
    `select r.action, r.risk, r.confidence, r.status,
            exists (select 1 from review_decisions d where d.tenant_id = r.tenant_id and d.request_id = r.id and d.decision = 'edit') as edited
       from review_requests r
      where r.tenant_id = ?1 and r.project_id = ?2 and r.created_at >= ?3 and coalesce(r.route_outcome, 'human') = 'human'
        and r.status in ('approved', 'rejected', 'expired', 'cancelled')
      order by r.created_at desc limit ${MAX_ROWS}`,
    projectId,
    from,
  );
  return rows.map((r) => ({ ...r, edited: Boolean(r.edited) }));
}

/** D6: one fact row per request in the window (human decision counts exclude system:* actors). */
export function requestFacts(db: TenantDb, from: string, projectId: string | null): Promise<R.RequestFact[]> {
  return db
    .all<R.RequestFact>(
      `select r.action as action, r.status as status, r.route_outcome as routeOutcome, r.created_at as createdAt, r.decided_at as decidedAt,
            (select count(*) from review_decisions d where d.tenant_id = r.tenant_id and d.request_id = r.id and d.reviewer not like 'system:%' and d.reviewer not like 'policy:%') as humanDecisions,
            exists (select 1 from review_decisions d where d.tenant_id = r.tenant_id and d.request_id = r.id and d.decision = 'escalate') as escalated
       from review_requests r
      where r.tenant_id = ?1 and r.created_at >= ?2 and (?3 is null or r.project_id = ?3)
      order by r.created_at desc limit ${MAX_ROWS}`,
      from,
      projectId,
    )
    .then((rows) => rows.map((x) => ({ ...x, escalated: Boolean(x.escalated) })));
}
