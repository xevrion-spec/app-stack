/**
 * Agent review layer (A1): an AI agent asks for a human decision; reviewers approve, reject, edit or escalate.
 * Lifecycle rules live in @xevrion/agent-review (pure, property-tested); this module persists snapshots with optimistic
 * concurrency, emits review.* events (delivered through the existing webhook outbox) and writes the audit log.
 * Built into the existing tenancy: a tenant (organisation) owns projects; API keys may be bound to one project.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as R from "@xevrion/agent-review";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { TenantDb, newId, encodeCursor, decodeCursor } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { requireRole } from "../lib/auth.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import { Outbox } from "../services/events.js";
import { sha256Hex } from "../services/csv.js";

type C = Context<AppEnv>;
export const agentReviews = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const actor = (c: C) => c.get("principal").email;
const now = () => new Date().toISOString();
const DEFAULT_TIMEOUT_S = 24 * 3600;

// ---------------- projects ----------------
const Project = z
  .object({ id: z.string(), name: z.string(), environment: z.enum(["development", "staging", "production"]), createdAt: z.string() })
  .openapi("ReviewProject");
type ProjectRow = { id: string; name: string; environment: "development" | "staging" | "production"; created_at: string; archived_at: string | null };
const projectOut = (r: ProjectRow) => ({ id: r.id, name: r.name, environment: r.environment, createdAt: r.created_at });

agentReviews.post("/review-projects", requireRole("owner"));
agentReviews.openapi(
  def({
    method: "post",
    path: "/review-projects",
    tag: "Agent review",
    summary: "Create a review project in one environment (owner only; API keys cannot create projects)",
    body: z.object({ name: z.string().min(1).max(80), environment: z.enum(["development", "staging", "production"]).default("production") }),
    response: Project,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    if (await db.first("select 1 from review_projects where tenant_id = ?1 and name = ?2 and environment = ?3", b.name, b.environment))
      throw conflict("A project with this name already exists in that environment");
    const row: ProjectRow = { id: newId(), name: b.name, environment: b.environment, created_at: now(), archived_at: null };
    await db.batch([
      db.stmt(
        "insert into review_projects (tenant_id, id, name, environment, created_by, created_at) values (?1, ?2, ?3, ?4, ?5, ?6)",
        row.id,
        row.name,
        row.environment,
        actor(c),
        row.created_at,
      ),
      auditStmt(db, actor(c), "review_project.created", row.id, { name: row.name, environment: row.environment }),
    ]);
    return c.json(projectOut(row), 201);
  },
);
agentReviews.openapi(
  def({ method: "get", path: "/review-projects", tag: "Agent review", summary: "List review projects", response: z.object({ items: z.array(Project) }) }),
  async (c) => {
    const k = c.get("principal").apiKey;
    const bound = k ? await boundProject(c) : null;
    const rows = await scope(c).all<ProjectRow>(
      `select id, name, environment, created_at, archived_at from review_projects where tenant_id = ?1 and archived_at is null${bound ? " and id = ?2" : ""} order by created_at, id`,
      ...(bound ? [bound] : []),
    );
    return c.json({ items: rows.map(projectOut) }, 200);
  },
);

/** The project an API key is bound to (null = tenant-wide key). Humans are never bound. */
async function boundProject(c: C): Promise<string | null> {
  const k = c.get("principal").apiKey;
  if (!k) return null;
  return (await scope(c).first<{ project_id: string | null }>("select project_id from api_keys where tenant_id = ?1 and id = ?2", k.id))?.project_id ?? null;
}
async function resolveProject(c: C, requested: string | undefined): Promise<string> {
  const bound = await boundProject(c);
  if (bound && requested && requested !== bound) throw new AppError(403, "insufficient_scope", "This API key is bound to another project");
  const id = requested ?? bound;
  if (!id) throw badRequest("projectId is required");
  const p = await scope(c).first<{ id: string }>("select id from review_projects where tenant_id = ?1 and id = ?2 and archived_at is null", id);
  if (!p) throw notFound("Project");
  return p.id;
}

// ---------------- review requests ----------------
type RequestRow = {
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
};
const COLS =
  "id, project_id, action, payload_json, current_payload_json, context_json, risk, confidence, status, required_approvals, snapshot_json, requester, external_id, tags_json, request_sha, deadline_at, decided_at, version, created_at, updated_at";
const Decision = z.object({
  id: z.string(),
  reviewer: z.string(),
  decision: z.enum(R.DECISIONS),
  reason: z.string().nullable(),
  payloadVersion: z.number(),
  createdAt: z.string(),
});
const ReviewOut = z
  .object({
    id: z.string(),
    projectId: z.string(),
    action: z.string(),
    status: R.ReviewStatus,
    risk: z.enum(R.RISK_LEVELS),
    confidence: z.number().nullable(),
    payload: z.record(z.string(), z.unknown()).openapi({ description: "Current payload (after any edits): what runs if approved" }),
    originalPayload: z.record(z.string(), z.unknown()),
    payloadVersion: z.number(),
    context: z.record(z.string(), z.unknown()).nullable(),
    requiredApprovals: z.number(),
    approvals: z.number(),
    requester: z.string(),
    externalId: z.string().nullable(),
    tags: z.array(z.string()),
    deadlineAt: z.string(),
    decidedAt: z.string().nullable(),
    version: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    decisions: z.array(Decision).optional(),
  })
  .openapi("ReviewRequest");
type DecisionRow = { id: string; reviewer: string; decision: R.Decision; reason: string | null; payload_version: number; created_at: string };
function out(r: RequestRow, decisions?: DecisionRow[]): z.infer<typeof ReviewOut> {
  const snap = JSON.parse(r.snapshot_json) as R.Snapshot;
  return {
    id: r.id,
    projectId: r.project_id,
    action: r.action,
    status: r.status,
    risk: r.risk,
    confidence: r.confidence,
    payload: JSON.parse(r.current_payload_json),
    originalPayload: JSON.parse(r.payload_json),
    payloadVersion: snap.payloadVersion,
    context: r.context_json ? JSON.parse(r.context_json) : null,
    requiredApprovals: r.required_approvals,
    approvals: R.currentApprovals(snap),
    requester: r.requester,
    externalId: r.external_id,
    tags: JSON.parse(r.tags_json),
    deadlineAt: r.deadline_at,
    decidedAt: r.decided_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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

/** Interim approver rule until the policy engine (A2): critical risk needs four-eyes; callers may only raise it. */
const requiredApprovalsFor = (risk: R.RiskLevel, min?: number) => Math.max(min ?? 1, risk === "critical" ? 2 : 1);

agentReviews.openapi(
  def({
    method: "post",
    path: "/agent-reviews",
    tag: "Agent review",
    summary:
      "Ask for a human decision. Send Idempotency-Key: a retry with the same key and body returns the original request (200); the same key with a different body is 409.",
    body: R.CreateReviewRequest.extend({ projectId: z.string().max(64).optional() }),
    response: ReviewOut,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    const projectId = await resolveProject(c, b.projectId);
    const key = c.req.header("idempotency-key") ?? null;
    const { projectId: _p, ...body } = b;
    const sha = await sha256Hex(R.canonicalJson(body));
    if (key) {
      const prior = await db.first<RequestRow>(
        `select ${COLS} from review_requests where tenant_id = ?1 and project_id = ?2 and idempotency_key = ?3`,
        projectId,
        key,
      );
      if (prior) {
        if (prior.request_sha !== sha) throw conflict("Idempotency-Key was already used with a different request body");
        return c.json(out(prior), 200) as never;
      }
    }
    const t = now();
    const deadline = b.deadlineAt ? new Date(b.deadlineAt).toISOString() : new Date(Date.now() + (b.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000).toISOString();
    if (deadline <= t) throw badRequest("deadlineAt must be in the future");
    const required = requiredApprovalsFor(b.risk, b.minApprovals);
    const snap = R.initial(actor(c), required);
    const row: RequestRow = {
      id: newId(),
      project_id: projectId,
      action: b.action,
      payload_json: JSON.stringify(b.payload),
      current_payload_json: JSON.stringify(b.payload),
      context_json: b.context ? JSON.stringify(b.context) : null,
      risk: b.risk,
      confidence: b.confidence ?? null,
      status: "pending",
      required_approvals: required,
      snapshot_json: JSON.stringify(snap),
      requester: actor(c),
      external_id: b.externalId ?? null,
      tags_json: JSON.stringify(b.tags),
      request_sha: sha,
      deadline_at: deadline,
      decided_at: null,
      version: 1,
      created_at: t,
      updated_at: t,
    };
    const outbox = new Outbox(db);
    outbox.add(
      "review.requested",
      { requestId: row.id, projectId, action: row.action, risk: row.risk, requiredApprovals: required, deadlineAt: deadline, externalId: row.external_id },
      actor(c),
    );
    try {
      await db.batch([
        db.stmt(
          `insert into review_requests (tenant_id, id, project_id, action, payload_json, current_payload_json, context_json, risk, confidence, status, required_approvals,
             snapshot_json, requester, external_id, tags_json, idempotency_key, request_sha, deadline_at, version, created_at, updated_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 1, ?18, ?18)`,
          row.id,
          projectId,
          row.action,
          row.payload_json,
          row.current_payload_json,
          row.context_json,
          row.risk,
          row.confidence,
          required,
          row.snapshot_json,
          row.requester,
          row.external_id,
          row.tags_json,
          key,
          sha,
          deadline,
          t,
        ),
        ...outbox.stmts.splice(0),
        auditStmt(db, actor(c), "review.requested", row.id, { projectId, action: row.action, risk: row.risk, requiredApprovals: required }),
      ]);
    } catch (e) {
      // Two concurrent creates with the same key: the unique index lets one win; the loser returns the winner.
      if (key && /UNIQUE/i.test(String(e))) {
        const won = await db.first<RequestRow>(
          `select ${COLS} from review_requests where tenant_id = ?1 and project_id = ?2 and idempotency_key = ?3`,
          projectId,
          key,
        );
        if (won && won.request_sha === sha) return c.json(out(won), 200) as never;
        throw conflict("Idempotency-Key was already used with a different request body");
      }
      throw e;
    }
    await outbox.publish(c.env);
    return c.json(out(row), 201);
  },
);

async function load(c: C, id: string): Promise<RequestRow> {
  const db = scope(c);
  const bound = await boundProject(c);
  const r = await db.first<RequestRow>(
    `select ${COLS} from review_requests where tenant_id = ?1 and id = ?2${bound ? " and project_id = ?3" : ""}`,
    id,
    ...(bound ? [bound] : []),
  );
  if (!r) throw notFound("Review request");
  return r;
}

/** Applies one state-machine event and persists it atomically. Version-checked: a lost race is a 409 the client can retry. */
async function transition(c: C, r: RequestRow, ev: R.ReviewEvent, extra: { decision?: R.DecideReviewRequest; system?: boolean } = {}): Promise<RequestRow> {
  const db = scope(c);
  const before = JSON.parse(r.snapshot_json) as R.Snapshot;
  let snap: R.Snapshot;
  try {
    snap = R.apply(before, ev);
  } catch (e) {
    if (e instanceof R.TransitionError)
      throw new AppError(e.code === "already_final" ? 409 : e.code === "self_approval" || e.code === "not_requester" ? 403 : 409, e.code, e.message);
    throw e;
  }
  const t = now();
  const final = R.FINAL.has(snap.status);
  const payload = ev.type === "decide" && ev.decision === "edit" ? JSON.stringify(extra.decision!.payload) : r.current_payload_json;
  const next: RequestRow = {
    ...r,
    status: snap.status,
    snapshot_json: JSON.stringify(snap),
    current_payload_json: payload,
    decided_at: final ? t : null,
    version: r.version + 1,
    updated_at: t,
  };
  const who = extra.system ? "system" : actor(c);
  const outbox = new Outbox(db);
  const stmts: D1PreparedStatement[] = [
    db.stmt(
      "update review_requests set status = ?3, snapshot_json = ?4, current_payload_json = ?5, decided_at = ?6, version = version + 1, updated_at = ?7 where tenant_id = ?1 and id = ?2 and version = ?8",
      r.id,
      next.status,
      next.snapshot_json,
      next.current_payload_json,
      next.decided_at,
      t,
      r.version,
    ),
  ];
  if (ev.type === "decide") {
    stmts.push(
      db.stmt(
        "insert into review_decisions (tenant_id, id, request_id, reviewer, decision, reason, payload_version, payload_json, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        newId(),
        r.id,
        ev.reviewer,
        ev.decision,
        extra.decision?.reason ?? null,
        snap.payloadVersion,
        ev.decision === "edit" ? payload : null,
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
      who,
    );
  }
  if (final)
    outbox.add(
      "review.completed",
      {
        requestId: r.id,
        projectId: r.project_id,
        status: snap.status as "approved" | "rejected" | "expired" | "cancelled",
        payload: snap.status === "approved" ? JSON.parse(payload) : null,
        payloadVersion: snap.payloadVersion,
        externalId: r.external_id,
      },
      who,
    );
  stmts.push(
    ...outbox.stmts.splice(0),
    auditStmt(db, who, `review.${ev.type === "decide" ? ev.decision : ev.type}`, r.id, { status: snap.status, payloadVersion: snap.payloadVersion }),
  );
  const res = await db.batch(stmts);
  if (!res[0]) throw new AppError(409, "version_conflict", "The request changed concurrently; reload and retry");
  await outbox.publish(c.env);
  return next;
}

/** Deadlines are enforced lazily on every read/decision (and by the A2 sweeper), so an expired request never accepts a decision. */
async function expireIfDue(c: C, r: RequestRow): Promise<RequestRow> {
  if (R.FINAL.has(r.status) || r.deadline_at > now()) return r;
  try {
    return await transition(c, r, { type: "expire" }, { system: true });
  } catch (e) {
    if (e instanceof AppError && e.status === 409) return load(c, r.id);
    throw e;
  }
}

agentReviews.openapi(
  def({
    method: "get",
    path: "/agent-reviews",
    tag: "Agent review",
    summary: "List review requests (newest first), filterable by project, status, risk and externalId",
    query: z.object({
      projectId: z.string().max(64).optional(),
      status: R.ReviewStatus.optional(),
      risk: z.enum(R.RISK_LEVELS).optional(),
      externalId: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().max(400).optional(),
    }),
    response: z.object({ items: z.array(ReviewOut), nextCursor: z.string().nullable() }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const bound = await boundProject(c);
    if (bound && q.projectId && q.projectId !== bound) throw new AppError(403, "insufficient_scope", "This API key is bound to another project");
    const conds: string[] = [];
    const args: unknown[] = [];
    const arg = (v: unknown) => (args.push(v), `?${args.length + 1}`);
    const project = bound ?? q.projectId;
    if (project) conds.push(`project_id = ${arg(project)}`);
    if (q.status) conds.push(`status = ${arg(q.status)}`);
    if (q.risk) conds.push(`risk = ${arg(q.risk)}`);
    if (q.externalId) conds.push(`external_id = ${arg(q.externalId)}`);
    const cur = decodeCursor(q.cursor);
    if (cur) conds.push(`(created_at, id) < (${arg(cur[0])}, ${arg(cur[1])})`);
    const rows = await scope(c).all<RequestRow>(
      `select ${COLS} from review_requests where tenant_id = ?1${conds.map((x) => ` and ${x}`).join("")} order by created_at desc, id desc limit ${q.limit + 1}`,
      ...args,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map((r) => out(r)), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }, 200);
  },
);

agentReviews.openapi(
  def({
    method: "get",
    path: "/agent-reviews/{id}",
    tag: "Agent review",
    summary: "Get a review request with its decisions",
    params: IdParam,
    response: ReviewOut,
  }),
  async (c) => {
    const r = await expireIfDue(c, await load(c, c.req.valid("param").id));
    const ds = await scope(c).all<DecisionRow>(
      "select id, reviewer, decision, reason, payload_version, created_at from review_decisions where tenant_id = ?1 and request_id = ?2 order by created_at, id",
      r.id,
    );
    return c.json(out(r, ds), 200);
  },
);

agentReviews.post("/agent-reviews/:id/decisions", async (c, next) => (c.get("principal").apiKey ? next() : requireRole("owner", "reviewer")(c, next)));
agentReviews.openapi(
  def({
    method: "post",
    path: "/agent-reviews/{id}/decisions",
    tag: "Agent review",
    summary: "Record a decision: approve, reject (veto), edit (replaces the payload; earlier approvals stop counting) or escalate",
    params: IdParam,
    body: R.DecideReviewRequest,
    response: ReviewOut,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const r = await expireIfDue(c, await load(c, c.req.valid("param").id));
    const next = await transition(c, r, { type: "decide", decision: b.decision, reviewer: actor(c) }, { decision: b });
    return c.json(out(next), 200);
  },
);

agentReviews.openapi(
  def({
    method: "post",
    path: "/agent-reviews/{id}/cancel",
    tag: "Agent review",
    summary: "Cancel a pending request (requester only)",
    params: IdParam,
    response: ReviewOut,
  }),
  async (c) => {
    const r = await expireIfDue(c, await load(c, c.req.valid("param").id));
    return c.json(out(await transition(c, r, { type: "cancel", by: actor(c) })), 200);
  },
);
