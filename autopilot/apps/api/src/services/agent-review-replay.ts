/**
 * Decision replay (differentiator D1): re-evaluates past review requests against a candidate policy and diffs the
 * routing against what actually happened. The key safety number is how many requests the candidate would have
 * AUTO-APPROVED that a human in fact rejected or had to edit. Activation refuses a policy with any such case unless forced.
 */
import * as R from "@xevrion/agent-review";
import type { TenantDb } from "../lib/db.js";

type Row = {
  id: string;
  action: string;
  payload_json: string;
  risk: R.RiskLevel;
  confidence: number | null;
  tags_json: string;
  min_approvals: number | null;
  status: R.Status;
  snapshot_json: string;
  route_outcome: R.Routing["outcome"] | null;
  required_approvals: number;
  review_group: string | null;
  policy_rule_id: string | null;
  policy_version: number | null;
  created_at: string;
};
export interface ReplayReport {
  evaluated: number;
  changed: number;
  transitions: Record<string, number>;
  wouldAutoApproveRejected: number;
  wouldAutoApproveEdited: number;
  reviewsSaved: number;
  humanLoadDelta: number;
  safe: boolean;
  samples: {
    requestId: string;
    finalStatus: R.Status;
    before: { outcome: string; approvals: number; group: string | null; ruleId: string | null; policyVersion: number };
    after: { outcome: string; approvals: number; group: string | null; ruleId: string | null };
    flag: "risky_auto_approve" | "review_saved" | null;
  }[];
}

/** Compares one historical request's recorded routing with the candidate's and classifies the difference. */
function classify(r: Row, candidate: R.PolicyDocument) {
  const before = {
    outcome: r.route_outcome ?? "human",
    approvals: r.required_approvals,
    group: r.review_group,
    ruleId: r.policy_rule_id,
    policyVersion: r.policy_version ?? 0,
  };
  const a = R.evaluate(candidate, {
    action: r.action,
    risk: r.risk,
    confidence: r.confidence,
    tags: JSON.parse(r.tags_json) as string[],
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    ...(r.min_approvals ? { minApprovals: r.min_approvals } : {}),
  });
  const after = { outcome: a.outcome, approvals: a.outcome === "human" ? a.approvals : 1, group: a.group, ruleId: a.ruleId };
  const humanDecided = before.outcome === "human";
  const newAuto = after.outcome === "auto_approve" && humanDecided;
  const edited = (JSON.parse(r.snapshot_json) as R.Snapshot).payloadVersion > 1;
  const flag: "auto_rejected" | "auto_edited" | "review_saved" | null = !newAuto
    ? null
    : r.status === "rejected"
      ? "auto_rejected"
      : edited
        ? "auto_edited"
        : r.status === "approved"
          ? "review_saved"
          : null;
  const changed = before.outcome !== after.outcome || (after.outcome === "human" && (before.approvals !== after.approvals || before.group !== after.group));
  return { before, after, flag, changed, humanDelta: (after.outcome === "human" ? 1 : 0) - (humanDecided ? 1 : 0) };
}

export async function replay(
  db: TenantDb,
  projectId: string,
  candidate: R.PolicyDocument,
  opts: { since?: string | undefined; limit: number },
): Promise<ReplayReport> {
  const rows = await db.all<Row>(
    `select id, action, payload_json, risk, confidence, tags_json, min_approvals, status, snapshot_json, route_outcome, required_approvals, review_group, policy_rule_id, policy_version, created_at
       from review_requests where tenant_id = ?1 and project_id = ?2${opts.since ? " and created_at >= ?3" : ""} order by created_at desc limit ${Math.min(opts.limit, 5000)}`,
    projectId,
    ...(opts.since ? [opts.since] : []),
  );
  const rep: ReplayReport = {
    evaluated: rows.length,
    changed: 0,
    transitions: {},
    wouldAutoApproveRejected: 0,
    wouldAutoApproveEdited: 0,
    reviewsSaved: 0,
    humanLoadDelta: 0,
    safe: true,
    samples: [],
  };
  for (const r of rows) {
    const x = classify(r, candidate);
    if (x.flag === "auto_rejected") rep.wouldAutoApproveRejected++;
    if (x.flag === "auto_edited") rep.wouldAutoApproveEdited++;
    if (x.flag === "review_saved") rep.reviewsSaved++;
    rep.humanLoadDelta += x.humanDelta;
    if (!x.changed) continue;
    rep.changed++;
    const k = `${x.before.outcome}->${x.after.outcome}`;
    rep.transitions[k] = (rep.transitions[k] ?? 0) + 1;
    const flag = x.flag === "auto_rejected" || x.flag === "auto_edited" ? "risky_auto_approve" : x.flag;
    if (rep.samples.length < 50 || flag === "risky_auto_approve")
      rep.samples.push({ requestId: r.id, finalStatus: r.status, before: x.before, after: x.after, flag });
  }
  rep.safe = rep.wouldAutoApproveRejected + rep.wouldAutoApproveEdited === 0;
  rep.samples = rep.samples.sort((x, y) => (y.flag === "risky_auto_approve" ? 1 : 0) - (x.flag === "risky_auto_approve" ? 1 : 0)).slice(0, 100);
  return rep;
}
