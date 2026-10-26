/**
 * Agent review layer: persistence and orchestration shared by the HTTP routes and the cron sweeper.
 * Pure rules (state machine, policy engine) live in @xevrion/agent-review; this module turns them into atomic D1 batches:
 * every transition updates the request (version-checked), records the decision, emits review.* events through the
 * existing outbox (and from there signed webhooks) and writes the audit log, all in one batch.
 */
import { enqueueStmts } from "./notify-enqueue.js";
import { wake } from "./review-feed.js";
import { checkTemplate } from "./review-templates.js";
import { clockFor, groupSizes, projectCalendar } from "./review-workflow.js";
import * as R from "@xevrion/agent-review";
import type { Env } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { appendStmts, payloadSha, type PendingEntry } from "./agent-review-ledger.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import { Outbox } from "./events.js";
import { sha256Hex } from "./csv.js";
import { validateWebhookUrl } from "@xevrion/platform";
import { devHttpHosts } from "./webhooks.js";
import { retryDueCallbacks } from "./agent-review-delivery.js";
import { enforceQuota, meterStmt } from "./usage.js";

const DEFAULT_TIMEOUT_S = 24 * 3600;
const now = () => new Date().toISOString();

export type RequestRow = {
  id: string;
  project_id: string;
  action: string;
  payload_json: string;
  current_payload_json: string;
  context_json: string | null;
  risk: R.RiskLevel;
  confidence: number | null;
  status: R.Status;
  required_approvals: number;
  snapshot_json: string;
  requester: string;
  external_id: string | null;
  tags_json: string;
  request_sha: string;
  deadline_at: string;
  decided_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  policy_version: number | null;
  policy_rule_id: string | null;
  route_outcome: R.Routing["outcome"] | null;
  review_group: string | null;
  escalate_at: string | null;
  escalate_to_group: string | null;
  min_approvals: number | null;
  guardrails_json: string | null;
  callback_url: string | null;
  chain_seq: number;
  chain_head: string | null;
  legal_hold_at: string | null;
  redacted_at: string | null;
};
export const COLS =
  "id, project_id, action, payload_json, current_payload_json, context_json, risk, confidence, status, required_approvals, snapshot_json, requester, external_id, tags_json, request_sha, deadline_at, decided_at, version, created_at, updated_at, policy_version, policy_rule_id, route_outcome, review_group, escalate_at, escalate_to_group, min_approvals, guardrails_json, callback_url, chain_seq, chain_head, legal_hold_at, redacted_at";
export type DecisionRow = { id: string; reviewer: string; decision: R.Decision; reason: string | null; payload_version: number; created_at: string };

/** The group that may decide right now: the escalation group once escalated, else the routed group (null = anyone with the role). */
export const decidingGroup = (r: RequestRow) => {
  if (r.status === "escalated" && r.escalate_to_group) return r.escalate_to_group;
  const step = R.currentStep(JSON.parse(r.snapshot_json) as R.Snapshot);
  return step ? step.group : r.review_group;
};
/** Chain progress for API output (null for single-step requests). */
function chainOut(snap: R.Snapshot) {
  if (!snap.steps) return null;
  const at = snap.stepIndex ?? 0;
  return {
    currentStep: at < snap.steps.length ? at : null,
    steps: snap.steps.map((st, i) => ({
      name: st.name,
      group: st.group,
      required: st.approvals,
      approvals: new Set(snap.approvals.filter((a) => a.version === snap.payloadVersion && a.step === i).map((a) => a.reviewer)).size,
      state: i < at ? ("done" as const) : i === at ? ("current" as const) : ("waiting" as const),
    })),
  };
}

export function reviewOut(r: RequestRow, decisions?: DecisionRow[]) {
  const snap = JSON.parse(r.snapshot_json) as R.Snapshot;
  return {
    id: r.id,
    projectId: r.project_id,
    action: r.action,
    status: r.status,
    risk: r.risk,
    confidence: r.confidence,
    payload: JSON.parse(r.current_payload_json) as Record<string, unknown>,
    originalPayload: JSON.parse(r.payload_json) as Record<string, unknown>,
    payloadVersion: snap.payloadVersion,
    payloadDiff: snap.payloadVersion > 1 && !r.redacted_at ? R.diffPayload(JSON.parse(r.payload_json), JSON.parse(r.current_payload_json)) : null,
    context: r.context_json ? (JSON.parse(r.context_json) as Record<string, unknown>) : null,
    requiredApprovals: r.required_approvals,
    approvals: R.currentApprovals(snap),
    requester: r.requester,
    externalId: r.external_id,
    tags: JSON.parse(r.tags_json) as string[],
    deadlineAt: r.deadline_at,
    decidedAt: r.decided_at,
    routing: {
      outcome: r.route_outcome ?? "human",
      policyVersion: r.policy_version ?? 0,
      ruleId: r.policy_rule_id,
      group: decidingGroup(r),
      escalateAt: r.escalate_at,
      guardrails: r.guardrails_json ? (JSON.parse(r.guardrails_json) as string[]) : [],
      chain: chainOut(snap),
    },
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    legalHold: !!r.legal_hold_at,
    redactedAt: r.redacted_at,
    ...(decisions
      ? {
          decisions: decisions.map((d) => ({
            id: d.id,
            reviewer: d.reviewer,
            decision: d.decision,
            reason: d.reason,
            payloadVersion: d.payload_version,
            createdAt: d.created_at,
          })),
        }
      : {}),
  };
}

// ---------------- policies ----------------
export type PolicyRow = {
  id: string;
  version: number;
  description: string | null;
  document_json: string;
  sha256: string;
  status: "draft" | "active" | "canary" | "retired";
  canary_percent: number | null;
  created_by: string;
  created_at: string;
  activated_at: string | null;
};
export const POLICY_COLS = "id, version, description, document_json, sha256, status, canary_percent, created_by, created_at, activated_at";
export interface ChosenPolicy {
  version: number;
  doc: R.PolicyDocument;
  arm: "active" | "canary" | "default";
}
export async function livePolicies(db: TenantDb, projectId: string): Promise<PolicyRow[]> {
  return db.all<PolicyRow>(`select ${POLICY_COLS} from review_policies where tenant_id = ?1 and project_id = ?2 and status in ('active', 'canary')`, projectId);
}
/** Picks the canary for its share of requests (stable per request id), else the active version, else the built-in default. */
export function choosePolicy(rows: PolicyRow[], requestId: string): ChosenPolicy {
  const active = rows.find((r) => r.status === "active");
  const canary = rows.find((r) => r.status === "canary");
  if (canary && R.bucket(requestId) < (canary.canary_percent ?? 0)) return { version: canary.version, doc: JSON.parse(canary.document_json), arm: "canary" };
  if (active) return { version: active.version, doc: JSON.parse(active.document_json), arm: "active" };
  return { version: 0, doc: R.DEFAULT_POLICY, arm: "default" };
}

// ---------------- create ----------------
interface RowInput {
  id: string;
  projectId: string;
  actor: string;
  body: CreateBody;
  snap: R.Snapshot;
  routing: R.Routing;
  policyVersion: number;
  deadline: string;
  sha: string;
  t: string;
  auto: boolean;
  at: (seconds: number) => string;
}
function buildRow({ id, projectId, actor, body, snap, routing, policyVersion, deadline, sha, t, auto, at }: RowInput): RequestRow {
  return {
    id,
    project_id: projectId,
    action: body.action,
    payload_json: JSON.stringify(body.payload),
    current_payload_json: JSON.stringify(body.payload),
    context_json: body.context ? JSON.stringify(body.context) : null,
    risk: body.risk,
    confidence: body.confidence ?? null,
    status: snap.status,
    required_approvals: snap.requiredApprovals,
    snapshot_json: JSON.stringify(snap),
    requester: actor,
    external_id: body.externalId ?? null,
    tags_json: JSON.stringify(body.tags),
    request_sha: sha,
    deadline_at: deadline,
    decided_at: auto ? t : null,
    version: 1,
    created_at: t,
    updated_at: t,
    policy_version: policyVersion,
    policy_rule_id: routing.ruleId,
    route_outcome: routing.outcome,
    review_group: R.currentStep(snap)?.group ?? routing.group,
    escalate_at: !auto && routing.escalateAfterSeconds ? at(routing.escalateAfterSeconds) : null,
    escalate_to_group: routing.escalateToGroup,
    min_approvals: body.minApprovals ?? null,
    guardrails_json: JSON.stringify(routing.guardrails),
    callback_url: body.callbackUrl ?? null,
    chain_seq: 0,
    chain_head: null,
    legal_hold_at: null,
    redacted_at: null,
  };
}

/** Statements recording a policy's own decision (auto-approve or reject) on a just-created request. */
function autoDecision(db: TenantDb, outbox: Outbox, row: RequestRow, payload: Record<string, unknown>, policyActor: string): D1PreparedStatement[] {
  const ruleId = row.policy_rule_id;
  const version = row.policy_version ?? 0;
  const approved = row.status === "approved";
  outbox.add(
    "review.completed",
    {
      requestId: row.id,
      projectId: row.project_id,
      status: approved ? "approved" : "rejected",
      payload: approved ? payload : null,
      payloadVersion: 1,
      externalId: row.external_id,
    },
    policyActor,
  );
  return [
    db.stmt(
      "insert into review_decisions (tenant_id, id, request_id, reviewer, decision, reason, payload_version, payload_json, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, 1, null, ?7)",
      newId(),
      row.id,
      policyActor,
      approved ? "approve" : "reject",
      `policy v${version} rule ${ruleId ?? "default"}`,
      row.created_at,
    ),
    auditStmt(db, policyActor, `review.${approved ? "auto_approved" : "auto_rejected"}`, row.id, { ruleId }),
  ];
}
export type CreateBody = R.CreateReviewRequest;
function assertCallbackUrl(env: Env, url: string | undefined): void {
  if (!url) return;
  const check = validateWebhookUrl(url, { allowHttpHosts: devHttpHosts(env) });
  if (!check.ok) throw badRequest(`callbackUrl rejected: ${check.reason}`);
}

/** Ledger entries for a new request: "requested" plus, when policy decided it, the policy's own decision. */
async function creationEntries(row: RequestRow, actor: string, policyVersion: number, routing: R.Routing, status: R.Status): Promise<PendingEntry[]> {
  const t = row.created_at;
  const entries: PendingEntry[] = [
    {
      kind: "requested",
      actor,
      at: t,
      data: {
        projectId: row.project_id,
        action: row.action,
        risk: row.risk,
        confidence: row.confidence,
        payloadSha256: await payloadSha(row.payload_json),
        contextSha256: row.context_json ? await payloadSha(row.context_json) : null,
        requiredApprovals: row.required_approvals,
        deadlineAt: row.deadline_at,
        policyVersion,
        ruleId: row.policy_rule_id,
        routing: row.route_outcome,
        guardrails: JSON.parse(row.guardrails_json ?? "[]") as unknown,
      },
    },
  ];
  if (routing.outcome !== "human")
    entries.push({
      kind: "decided",
      actor: `policy:v${policyVersion}:${routing.ruleId ?? "default"}`,
      at: t,
      data: { decision: status === "approved" ? "approve" : "reject", payloadVersion: 1, status },
    });
  return entries;
}

export async function createReview(
  env: Env,
  db: TenantDb,
  actor: string,
  projectId: string,
  body: CreateBody,
  idemKey: string | null,
): Promise<{ row: RequestRow; created: boolean }> {
  const sha = await sha256Hex(R.canonicalJson(body));
  const byKey = () =>
    db.first<RequestRow>(`select ${COLS} from review_requests where tenant_id = ?1 and project_id = ?2 and idempotency_key = ?3`, projectId, idemKey);
  if (idemKey) {
    const prior = await byKey();
    if (prior) {
      if (prior.request_sha !== sha) throw conflict("Idempotency-Key was already used with a different request body");
      return { row: prior, created: false };
    }
  }
  assertCallbackUrl(env, body.callbackUrl);
  // metering (A10a): idempotent replays above are free; a new request counts against the monthly plan quota
  await checkTemplate(db, projectId, body.action, body.payload);
  await enforceQuota(db, "agent_reviews", 1);
  const t = now();
  const id = newId();
  const policy = choosePolicy(await livePolicies(db, projectId), id);
  const routing = R.evaluate(policy.doc, {
    action: body.action,
    risk: body.risk,
    confidence: body.confidence ?? null,
    tags: body.tags,
    payload: body.payload,
    ...(body.minApprovals ? { minApprovals: body.minApprovals } : {}),
  });
  const { clock, deadline } = await timing(db, projectId, routing, body, t);
  const auto = routing.outcome !== "human";
  let snap = auto || !routing.steps ? R.initial(actor, auto ? 1 : routing.approvals) : await chainSnapshot(db, actor, routing, body);
  const policyActor = `policy:v${policy.version}:${routing.ruleId ?? "default"}`;
  if (auto) snap = R.apply(snap, { type: "decide", decision: routing.outcome === "auto_approve" ? "approve" : "reject", reviewer: policyActor });
  const row = buildRow({ id, projectId, actor, body, snap, routing, policyVersion: policy.version, deadline, sha, t, auto, at: clock.at });
  const entries = await creationEntries(row, actor, policy.version, routing, snap.status);
  const chain = await appendStmts(db, id, { seq: 0, head: null }, entries);
  row.chain_seq = chain.seq;
  row.chain_head = chain.head;
  const outbox = new Outbox(db);
  outbox.add(
    "review.requested",
    {
      requestId: id,
      projectId,
      action: row.action,
      risk: row.risk,
      requiredApprovals: row.required_approvals,
      deadlineAt: deadline,
      externalId: row.external_id,
    },
    actor,
  );
  const stmts: D1PreparedStatement[] = [
    db.stmt(
      `insert into review_requests (tenant_id, id, project_id, action, payload_json, current_payload_json, context_json, risk, confidence, status, required_approvals,
         snapshot_json, requester, external_id, tags_json, idempotency_key, request_sha, deadline_at, decided_at, version, created_at, updated_at,
         policy_version, policy_rule_id, route_outcome, review_group, escalate_at, escalate_to_group, min_approvals, guardrails_json, callback_url, chain_seq, chain_head)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 1, ?20, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31)`,
      id,
      projectId,
      row.action,
      row.payload_json,
      row.current_payload_json,
      row.context_json,
      row.risk,
      row.confidence,
      row.status,
      row.required_approvals,
      row.snapshot_json,
      actor,
      row.external_id,
      row.tags_json,
      idemKey,
      sha,
      deadline,
      row.decided_at,
      t,
      row.policy_version,
      row.policy_rule_id,
      row.route_outcome,
      row.review_group,
      row.escalate_at,
      row.escalate_to_group,
      row.min_approvals,
      row.guardrails_json,
      row.callback_url,
      row.chain_seq,
      row.chain_head,
    ),
    ...chain.stmts,
    auditStmt(db, actor, "review.requested", id, {
      projectId,
      action: row.action,
      risk: row.risk,
      policyVersion: policy.version,
      arm: policy.arm,
      routing: routing.outcome,
      ruleId: routing.ruleId,
    }),
  ];
  stmts.push(meterStmt(db, "agent_reviews"));
  if (auto) stmts.push(...autoDecision(db, outbox, row, body.payload, policyActor), meterStmt(db, "agent_reviews_auto"));
  else stmts.push(...(await enqueueStmts(db, { id, project_id: projectId, risk: row.risk }, t)));
  try {
    await db.batch([...stmts, ...outbox.stmts.splice(0)]);
  } catch (e) {
    // Two concurrent creates with the same key: the unique index lets one win; the loser returns the winner.
    if (idemKey && /UNIQUE/i.test(String(e))) {
      const won = await byKey();
      if (won && won.request_sha === sha) return { row: won, created: false };
      throw conflict("Idempotency-Key was already used with a different request body");
    }
    throw e;
  }
  wake(db.tenantId, row.id);
  await outbox.publish(env);
  return { row, created: true };
}

/** Deadline on the routing's clock (business hours when the rule asks and the project has a calendar). */
async function timing(
  db: TenantDb,
  projectId: string,
  routing: R.Routing,
  body: { deadlineAt?: string | undefined; timeoutSeconds?: number | undefined },
  t: string,
) {
  const clock = clockFor(routing.clock === "business" ? await projectCalendar(db, projectId) : null, routing.clock);
  if (clock.guardrail) routing.guardrails.push(clock.guardrail);
  const deadline = body.deadlineAt ? new Date(body.deadlineAt).toISOString() : clock.at(body.timeoutSeconds ?? routing.timeoutSeconds ?? DEFAULT_TIMEOUT_S);
  if (deadline <= t) throw badRequest("deadlineAt must be in the future");
  return { clock, deadline };
}

/** Resolves a routed chain against live group sizes (quorum) and records any guardrails it applied. */
async function chainSnapshot(db: TenantDb, actor: string, routing: R.Routing, body: { risk: R.RiskLevel; minApprovals?: number | undefined }) {
  const groups = [...new Set(routing.steps!.flatMap((st) => (st.group ? [st.group] : [])))];
  const sizes = await groupSizes(db, groups);
  const res = R.resolveSteps(routing.steps!, (g) => sizes.get(g) ?? 0, { risk: body.risk, ...(body.minApprovals ? { minApprovals: body.minApprovals } : {}) });
  routing.guardrails.push(...res.guardrails.filter((g) => !routing.guardrails.includes(g)));
  return R.initialChain(actor, res.steps);
}

// ---------------- transitions ----------------
const KIND: Record<R.ReviewEvent["type"], R.LedgerKind> = { decide: "decided", expire: "expired", cancel: "cancelled" };
function ledgerEntry(
  ev: R.ReviewEvent,
  opts: { actor: string; reason?: string | undefined },
  snap: R.Snapshot,
  at: string,
  editedSha: string | null,
): PendingEntry {
  const data: Record<string, unknown> = { status: snap.status, payloadVersion: snap.payloadVersion };
  if (ev.type === "decide") data.decision = ev.decision;
  if (opts.reason) data.reasonLength = opts.reason.length; // reason text stays in review_decisions (it may hold personal data); the chain stays content-free
  if (editedSha) data.payloadSha256 = editedSha;
  return { kind: KIND[ev.type], actor: ev.type === "decide" ? ev.reviewer : opts.actor, at, data };
}
const STATUS_FOR: Record<R.TransitionErrorCode, number> = {
  already_final: 409,
  duplicate_decision: 409,
  already_escalated: 409,
  self_approval: 403,
  not_requester: 403,
};

/** `scope`: null = unrestricted; a project id (API key binding) or a set of ids (custom role ABAC; empty = nothing). */
export async function loadReview(db: TenantDb, id: string, scope: string | readonly string[] | null): Promise<RequestRow> {
  const set = scope === null ? null : typeof scope === "string" ? [scope] : scope;
  const r = await db.first<RequestRow>(
    `select ${COLS} from review_requests where tenant_id = ?1 and id = ?2${set ? " and project_id in (select value from json_each(?3))" : ""}`,
    id,
    ...(set ? [JSON.stringify(set)] : []),
  );
  if (!r) throw notFound("Review request");
  return r;
}

/** Applies one state-machine event atomically. Version-checked: a lost race is a 409 the client can retry. */
export async function transition(
  env: Env,
  db: TenantDb,
  r: RequestRow,
  ev: R.ReviewEvent,
  opts: { actor: string; reason?: string | undefined; payload?: Record<string, unknown> | undefined },
): Promise<RequestRow> {
  let snap: R.Snapshot;
  try {
    snap = R.apply(JSON.parse(r.snapshot_json) as R.Snapshot, ev);
  } catch (e) {
    if (e instanceof R.TransitionError) throw new AppError(STATUS_FOR[e.code], e.code, e.message);
    throw e;
  }
  const t = now();
  const final = R.FINAL.has(snap.status);
  const isEdit = ev.type === "decide" && ev.decision === "edit";
  const payload = isEdit ? JSON.stringify(opts.payload) : r.current_payload_json;
  const next: RequestRow = {
    ...r,
    status: snap.status,
    snapshot_json: JSON.stringify(snap),
    current_payload_json: payload,
    decided_at: final ? t : null,
    version: r.version + 1,
    updated_at: t,
  };
  const chain = await appendStmts(db, r.id, { seq: r.chain_seq, head: r.chain_head }, [
    ledgerEntry(ev, opts, snap, t, isEdit ? await payloadSha(payload) : null),
  ]);
  next.chain_seq = chain.seq;
  next.chain_head = chain.head;
  const outbox = new Outbox(db);
  const stmts: D1PreparedStatement[] = [
    db.stmt(
      "update review_requests set status = ?3, snapshot_json = ?4, current_payload_json = ?5, decided_at = ?6, version = version + 1, updated_at = ?7, chain_seq = ?9, chain_head = ?10 where tenant_id = ?1 and id = ?2 and version = ?8",
      r.id,
      next.status,
      next.snapshot_json,
      payload,
      next.decided_at,
      t,
      r.version,
      chain.seq,
      chain.head,
    ),
    ...chain.stmts,
  ];
  if (ev.type === "decide") {
    stmts.push(
      meterStmt(db, ev.reviewer.startsWith("system:") ? "agent_review_system_decisions" : "agent_review_decisions"),
      db.stmt(
        "insert into review_decisions (tenant_id, id, request_id, reviewer, decision, reason, payload_version, payload_json, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        newId(),
        r.id,
        ev.reviewer,
        ev.decision,
        opts.reason ?? null,
        snap.payloadVersion,
        isEdit ? payload : null,
        t,
      ),
    );
    outbox.add(
      "review.decision_recorded",
      {
        requestId: r.id,
        projectId: r.project_id,
        decision: ev.decision,
        reviewer: ev.reviewer,
        status: snap.status,
        payloadVersion: snap.payloadVersion,
        externalId: r.external_id,
      },
      opts.actor,
    );
  }
  if (final)
    outbox.add(
      "review.completed",
      {
        requestId: r.id,
        projectId: r.project_id,
        status: snap.status as "approved" | "rejected" | "expired" | "cancelled",
        payload: snap.status === "approved" ? (JSON.parse(payload) as Record<string, unknown>) : null,
        payloadVersion: snap.payloadVersion,
        externalId: r.external_id,
      },
      opts.actor,
    );
  stmts.push(
    ...outbox.stmts.splice(0),
    auditStmt(db, opts.actor, `review.${ev.type === "decide" ? ev.decision : ev.type}`, r.id, { status: snap.status, payloadVersion: snap.payloadVersion }),
  );
  // The ledger's unique (request, seq) makes a racing loser's whole batch roll back, so no orphan decision/event/audit rows commit.
  const res = await db.batch(stmts).catch((e: unknown) => {
    if (/UNIQUE|constraint/i.test(String(e))) throw new AppError(409, "version_conflict", "The request changed concurrently; reload and retry");
    throw e;
  });
  if (!res[0]) throw new AppError(409, "version_conflict", "The request changed concurrently; reload and retry");
  wake(db.tenantId, r.id);
  await outbox.publish(env);
  return next;
}

/** Deadlines are enforced lazily on every read/decision (and by the sweeper), so an expired request never accepts a decision. */
export async function expireIfDue(env: Env, db: TenantDb, r: RequestRow): Promise<RequestRow> {
  if (R.FINAL.has(r.status) || r.deadline_at > now()) return r;
  try {
    return await transition(env, db, r, { type: "expire" }, { actor: "system:deadline" });
  } catch (e) {
    if (e instanceof AppError && e.status === 409) return loadReview(db, r.id, null);
    throw e;
  }
}

/**
 * Cron sweep: expires overdue requests and escalates pending ones past their SLA. The cross-tenant discovery query returns
 * only ids; each transition then runs tenant-scoped. Bounded per run (limit) so a backlog drains over several minutes.
 */
export async function sweepAgentReviews(
  env: Env,
  at = new Date(),
  limit = 200,
): Promise<{ expired: number; escalated: number; conflicts: number; callbacks: number }> {
  const ts = at.toISOString();
  const due =
    (
      await env.DB.prepare(
        "select tenant_id, id from review_requests where status in ('pending', 'escalated') and (deadline_at <= ?1 or (status = 'pending' and escalate_at <= ?1)) order by deadline_at limit ?2",
      )
        .bind(ts, limit)
        .all<{ tenant_id: string; id: string }>()
    ).results ?? [];
  const out = { expired: 0, escalated: 0, conflicts: 0, callbacks: 0 };
  for (const d of due) {
    const db = new TenantDb(env.DB, d.tenant_id);
    const r = await loadReview(db, d.id, null);
    try {
      if (r.deadline_at <= ts) {
        await transition(env, db, r, { type: "expire" }, { actor: "system:deadline" });
        out.expired++;
      } else {
        await transition(env, db, r, { type: "decide", decision: "escalate", reviewer: "system:sla" }, { actor: "system:sla", reason: "SLA elapsed" });
        out.escalated++;
      }
    } catch (e) {
      if (!(e instanceof AppError && e.status === 409)) throw e;
      out.conflicts++;
    }
  }
  out.callbacks = await retryDueCallbacks(env, at);
  return out;
}
