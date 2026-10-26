/**
 * D7 regulator-style evidence pack for one project and period: controls evaluated from facts, policy versions,
 * outcome + reviewer analytics, per-request trail verification (capped), holds/redactions; sealed and signed.
 */
import * as R from "@xevrion/agent-review";
import type { Env } from "../env.js";
import type { TenantDb } from "../lib/db.js";
import { COLS, type RequestRow } from "./agent-review.js";
import { integrityOf, publicKeys, signingKey } from "./agent-review-evidence.js";
import { MAX_ROWS } from "./agent-review-analytics.js";

const PACK_MAX_REQUESTS = 1000;
type Project = { id: string; name: string; environment: string; retention_days: number | null };

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function policiesInForce(db: TenantDb, projectId: string, to: string) {
  return db.all<{ version: number; sha256: string; status: string; activated_at: string | null; created_by: string }>(
    "select version, sha256, status, activated_at, created_by from review_policies where tenant_id = ?1 and project_id = ?2 and activated_at is not null and activated_at <= ?3 order by version",
    projectId,
    to,
  );
}

async function verifyAll(db: TenantDb, rows: RequestRow[]) {
  const failed: string[] = [];
  for (const r of rows.slice(0, PACK_MAX_REQUESTS)) if (!(await integrityOf(db, r)).integrity.ok) failed.push(r.id);
  return { checked: Math.min(rows.length, PACK_MAX_REQUESTS), failed, truncated: rows.length > PACK_MAX_REQUESTS };
}

function decisionRows(db: TenantDb, projectId: string, from: string, to: string) {
  return db.all<R.DecisionRow>(
    `select d.reviewer as reviewer, d.decision as decision, d.request_id as requestId, r.created_at as requestCreatedAt, d.created_at as decidedAt, r.risk as risk
       from review_decisions d join review_requests r on r.tenant_id = d.tenant_id and r.id = d.request_id
      where d.tenant_id = ?1 and r.project_id = ?2 and r.created_at >= ?3 and r.created_at < ?4 and d.reviewer not like 'system:%' and d.reviewer not like 'policy:%'
      limit ${MAX_ROWS}`,
    projectId,
    from,
    to,
  );
}

export async function regulatorPack(env: Env, db: TenantDb, p: Project, from: string, to: string, pseudonymise: boolean) {
  const rows = await db.all<RequestRow>(
    `select ${COLS} from review_requests where tenant_id = ?1 and project_id = ?2 and created_at >= ?3 and created_at < ?4 order by created_at, id limit ${MAX_ROWS}`,
    p.id,
    from,
    to,
  );
  const [policies, decisions, integrity] = await Promise.all([policiesInForce(db, p.id, to), decisionRows(db, p.id, from, to), verifyAll(db, rows)]);
  const auto = rows.filter((r) => r.route_outcome === "auto_approve" || r.route_outcome === "reject");
  const facts: R.PackFacts = {
    requests: rows.length,
    humanRouted: rows.length - auto.length,
    humanDecisions: decisions.length,
    autoDecided: auto.length,
    integrityChecked: integrity.checked,
    integrityFailed: integrity.failed.length,
    integrityTruncated: integrity.truncated,
    retentionDays: p.retention_days,
    policyVersions: policies.length,
    criticalAutoApproved: auto.filter((r) => r.risk === "critical" && r.status === "approved").length,
    legalHolds: rows.filter((r) => r.legal_hold_at).length,
    redactions: rows.filter((r) => r.redacted_at).length,
  };
  const name = async (who: string) => (pseudonymise ? `reviewer-${await sha(`${db.tenantId}:${who}`)}` : who);
  const reviewers = await Promise.all(R.reviewerStats(decisions).map(async (s) => ({ ...s, reviewer: await name(s.reviewer) })));
  const pack = {
    format: "xevrion.regulator-evidence/1" as const,
    scope: { tenantId: db.tenantId, projectId: p.id, project: p.name, environment: p.environment, from, to },
    generatedAt: new Date().toISOString(),
    disclaimer: "Framework references are a mapping aid for your compliance team; this is not legal advice or a certification.",
    controls: R.evaluateControls(facts),
    facts,
    policies: policies.map((x) => ({ version: x.version, sha256: x.sha256, status: x.status, activatedAt: x.activated_at, createdBy: x.created_by })),
    outcomes: R.outcomeSummary(
      rows.map((r) => ({
        action: r.action,
        status: r.status,
        routeOutcome: r.route_outcome,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
        humanDecisions: decisions.filter((d) => d.requestId === r.id).length,
        escalated: decisions.some((d) => d.requestId === r.id && d.decision === "escalate"),
      })),
    ).total,
    reviewers,
    integrity: { checked: integrity.checked, failedRequestIds: integrity.failed, truncated: integrity.truncated },
    requests: rows.slice(0, PACK_MAX_REQUESTS).map((r) => ({
      id: r.id,
      action: r.action,
      risk: r.risk,
      status: r.status,
      route: r.route_outcome,
      policyVersion: r.policy_version,
      chainHead: r.chain_head,
      legalHold: Boolean(r.legal_hold_at),
      redacted: Boolean(r.redacted_at),
    })),
    pseudonymised: pseudonymise,
  };
  const key = env.RECEIPT_SIGNING_JWK ? await signingKey(env) : null;
  return { ...(await R.sealPack(pack, key)), publicKeys: await publicKeys(env) };
}
