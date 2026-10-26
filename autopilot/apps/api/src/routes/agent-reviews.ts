/**
 * Agent review layer HTTP API: an AI agent asks for a human decision; policy routes it (auto / human / four-eyes /
 * reject); reviewers approve, reject, edit or escalate. Persistence lives in services/agent-review.ts; pure rules in
 * @xevrion/agent-review. Built into the existing tenancy: a tenant (organisation) owns projects; API keys may be bound
 * to one project.
 */
import { bus, requestKey } from "../services/review-feed.js";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as R from "@xevrion/agent-review";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { TenantDb, newId, encodeCursor, decodeCursor } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { requireRole } from "../lib/auth.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import { sha256Hex } from "../services/csv.js";
import * as S from "../services/agent-review.js";
import { replay } from "../services/agent-review-replay.js";
import { attemptCallback, CALLBACK_COLS, type CallbackRow } from "../services/agent-review-delivery.js";
import { randomToken } from "@xevrion/platform";
import { roleOfUser, visibleProjects } from "../services/custom-roles.js";
import { decideAs } from "../services/agent-review-decide.js";

type C = Context<AppEnv>;
export const agentReviews = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
export const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const actor = (c: C) => c.get("principal").email;
const now = () => new Date().toISOString();
const ENVS = ["development", "staging", "production"] as const;

// ---------------- projects ----------------
const Project = z.object({ id: z.string(), name: z.string(), environment: z.enum(ENVS), createdAt: z.string() }).openapi("ReviewProject");
type ProjectRow = { id: string; name: string; environment: (typeof ENVS)[number]; created_at: string };
const projectOut = (r: ProjectRow) => ({ id: r.id, name: r.name, environment: r.environment, createdAt: r.created_at });
const ProjectParam = z.object({ id: z.string().min(1).max(64) });

agentReviews.post("/review-projects", requireRole("owner"));
agentReviews.openapi(
  def({
    method: "post",
    path: "/review-projects",
    tag: "Agent review",
    summary: "Create a review project in one environment (owner only; API keys cannot create projects)",
    body: z.object({ name: z.string().min(1).max(80), environment: z.enum(ENVS).default("production") }),
    response: Project.extend({ callbackSecret: z.string().openapi({ description: "Signs per-request callbacks. Shown once; rotate to replace." }) }),
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    if (await db.first("select 1 from review_projects where tenant_id = ?1 and name = ?2 and environment = ?3", b.name, b.environment))
      throw conflict("A project with this name already exists in that environment");
    const row: ProjectRow = { id: newId(), name: b.name, environment: b.environment, created_at: now() };
    const secret = `whsec_${randomToken(24)}`;
    await db.batch([
      db.stmt(
        "insert into review_projects (tenant_id, id, name, environment, created_by, created_at, callback_secret) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        row.id,
        row.name,
        row.environment,
        actor(c),
        row.created_at,
        secret,
      ),
      auditStmt(db, actor(c), "review_project.created", row.id, { name: row.name, environment: row.environment }),
    ]);
    return c.json({ ...projectOut(row), callbackSecret: secret }, 201);
  },
);
agentReviews.post("/review-projects/:id/rotate-callback-secret", requireRole("owner"));
agentReviews.openapi(
  def({
    method: "post",
    path: "/review-projects/{id}/rotate-callback-secret",
    tag: "Agent review",
    summary: "Replace the project's callback signing secret (owner only; shown once). Callbacks sent after this use the new secret.",
    params: z.object({ id: z.string().min(1).max(64) }),
    response: z.object({ callbackSecret: z.string() }),
  }),
  async (c) => {
    const projectId = await resolveProject(c, c.req.valid("param").id);
    const db = scope(c);
    const secret = `whsec_${randomToken(24)}`;
    await db.batch([
      db.stmt("update review_projects set callback_secret = ?3 where tenant_id = ?1 and id = ?2", projectId, secret),
      auditStmt(db, actor(c), "review_project.callback_secret_rotated", projectId),
    ]);
    return c.json({ callbackSecret: secret }, 200);
  },
);
agentReviews.openapi(
  def({ method: "get", path: "/review-projects", tag: "Agent review", summary: "List review projects", response: z.object({ items: z.array(Project) }) }),
  async (c) => {
    const bound = await boundProject(c);
    const rows = await scope(c).all<ProjectRow>(
      `select id, name, environment, created_at from review_projects where tenant_id = ?1 and archived_at is null${bound ? " and id = ?2" : ""} order by created_at, id`,
      ...(bound ? [bound] : []),
    );
    return c.json({ items: rows.map(projectOut) }, 200);
  },
);

/** The project an API key is bound to (null = tenant-wide key or a human). */
async function boundProject(c: C): Promise<string | null> {
  const k = c.get("principal").apiKey;
  if (!k) return null;
  return (await scope(c).first<{ project_id: string | null }>("select project_id from api_keys where tenant_id = ?1 and id = ?2", k.id))?.project_id ?? null;
}
/** What the caller may see: API-key project binding, else a custom role's project/environment conditions, else all. */
export async function accessScope(c: C): Promise<string | string[] | null> {
  const bound = await boundProject(c);
  if (bound) return bound;
  const p = c.get("principal");
  if (p.apiKey || p.role === "owner") return null;
  const role = await roleOfUser(scope(c), p.userId);
  return role ? visibleProjects(scope(c), role) : null;
}
async function resolveProject(c: C, requested: string | undefined): Promise<string> {
  const bound = await boundProject(c);
  if (bound && requested && requested !== bound) throw new AppError(403, "insufficient_scope", "This API key is bound to another project");
  const id = requested ?? bound;
  if (!id) throw badRequest("projectId is required");
  if (!(await scope(c).first("select 1 from review_projects where tenant_id = ?1 and id = ?2 and archived_at is null", id))) throw notFound("Project");
  return id;
}

// ---------------- policies (versioned policy-as-code, canary, replay) ----------------
const PolicyOut = z
  .object({
    id: z.string(),
    version: z.number(),
    description: z.string().nullable(),
    status: z.enum(["draft", "active", "canary", "retired"]),
    canaryPercent: z.number().nullable(),
    sha256: z.string(),
    document: z.unknown(),
    createdBy: z.string(),
    createdAt: z.string(),
    activatedAt: z.string().nullable(),
  })
  .openapi("ReviewPolicy");
const policyOut = (r: S.PolicyRow) => ({
  id: r.id,
  version: r.version,
  description: r.description,
  status: r.status,
  canaryPercent: r.canary_percent,
  sha256: r.sha256,
  document: JSON.parse(r.document_json) as unknown,
  createdBy: r.created_by,
  createdAt: r.created_at,
  activatedAt: r.activated_at,
});
const ReplayOut = z
  .object({
    evaluated: z.number(),
    changed: z.number(),
    transitions: z.record(z.string(), z.number()),
    wouldAutoApproveRejected: z.number(),
    wouldAutoApproveEdited: z.number(),
    reviewsSaved: z.number(),
    humanLoadDelta: z.number(),
    safe: z.boolean(),
    samples: z.array(z.unknown()),
  })
  .openapi("PolicyReplayReport");
agentReviews.post("/review-projects/:id/policies", requireRole("owner"));
agentReviews.post("/review-projects/:id/policies/*", requireRole("owner"));
agentReviews.openapi(
  def({
    method: "post",
    path: "/review-projects/{id}/policies",
    tag: "Agent review",
    summary: "Save a new immutable policy version (draft). Unsafe rules (auto-approve without confidence, critical auto-approve) are refused.",
    params: ProjectParam,
    body: z.object({ document: R.PolicyDocument, description: z.string().max(300).optional() }),
    response: PolicyOut,
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const projectId = await resolveProject(c, id);
    const db = scope(c);
    const v =
      ((await db.first<{ v: number | null }>("select max(version) v from review_policies where tenant_id = ?1 and project_id = ?2", projectId))?.v ?? 0) + 1;
    const doc = R.canonicalJson(b.document);
    const row: S.PolicyRow = {
      id: newId(),
      version: v,
      description: b.description ?? null,
      document_json: doc,
      sha256: await sha256Hex(doc),
      status: "draft",
      canary_percent: null,
      created_by: actor(c),
      created_at: now(),
      activated_at: null,
    };
    await db.batch([
      db.stmt(
        "insert into review_policies (tenant_id, id, project_id, version, description, document_json, sha256, status, created_by, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9)",
        row.id,
        projectId,
        v,
        row.description,
        doc,
        row.sha256,
        row.created_by,
        row.created_at,
      ),
      auditStmt(db, actor(c), "review_policy.saved", row.id, { projectId, version: v, sha256: row.sha256 }),
    ]);
    return c.json(policyOut(row), 201);
  },
);
agentReviews.openapi(
  def({
    method: "get",
    path: "/review-projects/{id}/policies",
    tag: "Agent review",
    summary: "List policy versions (newest first)",
    params: ProjectParam,
    response: z.object({ items: z.array(PolicyOut) }),
  }),
  async (c) => {
    const projectId = await resolveProject(c, c.req.valid("param").id);
    const rows = await scope(c).all<S.PolicyRow>(
      `select ${S.POLICY_COLS} from review_policies where tenant_id = ?1 and project_id = ?2 order by version desc`,
      projectId,
    );
    return c.json({ items: rows.map(policyOut) }, 200);
  },
);
async function policyDoc(c: C, projectId: string, version: number): Promise<S.PolicyRow> {
  const p = await scope(c).first<S.PolicyRow>(
    `select ${S.POLICY_COLS} from review_policies where tenant_id = ?1 and project_id = ?2 and version = ?3`,
    projectId,
    version,
  );
  if (!p) throw notFound("Policy version");
  return p;
}
agentReviews.openapi(
  def({
    method: "post",
    path: "/review-projects/{id}/policies/replay",
    tag: "Agent review",
    summary: "Time-travel replay: re-run past requests against a candidate policy (a document or a saved version) and diff the outcomes",
    params: ProjectParam,
    body: z
      .object({
        document: R.PolicyDocument.optional(),
        version: z.number().int().min(1).optional(),
        since: z.iso.datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(5000).default(1000),
      })
      .refine((b) => (b.document === undefined) !== (b.version === undefined), { message: "give exactly one of document or version" }),
    response: ReplayOut,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const projectId = await resolveProject(c, c.req.valid("param").id);
    const doc = b.document ?? (JSON.parse((await policyDoc(c, projectId, b.version!)).document_json) as R.PolicyDocument);
    return c.json(await replay(scope(c), projectId, doc, { since: b.since, limit: b.limit }), 200);
  },
);
agentReviews.openapi(
  def({
    method: "post",
    path: "/review-projects/{id}/policies/{version}/activate",
    tag: "Agent review",
    summary:
      "Activate a version for all traffic, or as a canary for canaryPercent of new requests. Refused (409 unsafe_policy) if replaying recent history shows it would auto-approve anything a human rejected or edited, unless force is set.",
    params: z.object({ id: z.string().min(1).max(64), version: z.coerce.number().int().min(1) }),
    body: z.object({ canaryPercent: z.number().int().min(1).max(99).optional(), force: z.boolean().default(false) }),
    response: z.object({ policy: PolicyOut, replay: ReplayOut }),
  }),
  async (c) => {
    const { id, version } = c.req.valid("param");
    const b = c.req.valid("json");
    const projectId = await resolveProject(c, id);
    const db = scope(c);
    const p = await policyDoc(c, projectId, version);
    const report = await replay(db, projectId, JSON.parse(p.document_json) as R.PolicyDocument, { limit: 1000 });
    if (!report.safe && !b.force)
      throw new AppError(409, "unsafe_policy", "Replaying recent requests shows this policy would auto-approve requests that humans rejected or edited", {
        wouldAutoApproveRejected: report.wouldAutoApproveRejected,
        wouldAutoApproveEdited: report.wouldAutoApproveEdited,
      });
    const t = now();
    const canary = b.canaryPercent !== undefined;
    await db.batch([
      // a new canary replaces any previous canary; a full activation retires the old active and any canary
      db.stmt(
        `update review_policies set status = 'retired' where tenant_id = ?1 and project_id = ?2 and version != ?3 and status in (${canary ? "'canary'" : "'active', 'canary'"})`,
        projectId,
        version,
      ),
      db.stmt(
        "update review_policies set status = ?4, canary_percent = ?5, activated_at = ?6 where tenant_id = ?1 and project_id = ?2 and version = ?3",
        projectId,
        version,
        canary ? "canary" : "active",
        canary ? b.canaryPercent : null,
        t,
      ),
      auditStmt(db, actor(c), canary ? "review_policy.canary" : "review_policy.activated", p.id, {
        projectId,
        version,
        canaryPercent: b.canaryPercent ?? 100,
        forced: b.force && !report.safe,
        replay: { evaluated: report.evaluated, changed: report.changed, safe: report.safe },
      }),
    ]);
    return c.json({ policy: policyOut((await policyDoc(c, projectId, version))!), replay: report }, 200);
  },
);

// ---------------- reviewer groups ----------------
agentReviews.put("/review-groups/:name", requireRole("owner"));
agentReviews.openapi(
  def({
    method: "put",
    path: "/review-groups/{name}",
    tag: "Agent review",
    summary: "Set the members of a reviewer group (owner only). Requests routed to a group can only be decided by its members or an owner.",
    params: z.object({ name: z.string().min(1).max(60) }),
    body: z.object({ members: z.array(z.email().max(200)).max(500) }),
    response: z.object({ name: z.string(), members: z.array(z.string()) }),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const members = [...new Set(c.req.valid("json").members.map((m) => m.toLowerCase()))].sort();
    const db = scope(c);
    const t = now();
    await db.batch([
      db.stmt("delete from review_group_members where tenant_id = ?1 and group_name = ?2", name),
      ...members.map((m) =>
        db.stmt("insert into review_group_members (tenant_id, group_name, email, added_by, added_at) values (?1, ?2, ?3, ?4, ?5)", name, m, actor(c), t),
      ),
      auditStmt(db, actor(c), "review_group.set", name, { members: members.length }),
    ]);
    return c.json({ name, members }, 200);
  },
);
agentReviews.openapi(
  def({
    method: "get",
    path: "/review-groups",
    tag: "Agent review",
    summary: "List reviewer groups and members",
    response: z.object({ items: z.array(z.object({ name: z.string(), members: z.array(z.string()) })) }),
  }),
  async (c) => {
    const rows = await scope(c).all<{ group_name: string; email: string }>(
      "select group_name, email from review_group_members where tenant_id = ?1 order by group_name, email",
    );
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.group_name, [...(m.get(r.group_name) ?? []), r.email]);
    return c.json({ items: [...m].map(([name, members]) => ({ name, members })) }, 200);
  },
);

// ---------------- review requests ----------------
const Decision = z.object({
  id: z.string(),
  reviewer: z.string(),
  decision: z.enum(R.DECISIONS),
  reason: z.string().nullable(),
  payloadVersion: z.number(),
  createdAt: z.string(),
});
export const ReviewOut = z
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
    routing: z.object({
      outcome: z.enum(["auto_approve", "human", "reject"]),
      policyVersion: z.number(),
      ruleId: z.string().nullable(),
      group: z.string().nullable(),
      escalateAt: z.string().nullable(),
      guardrails: z.array(z.string()),
    }),
    version: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    legalHold: z.boolean().openapi({ description: "Under legal hold: retention will not redact it" }),
    redactedAt: z.string().nullable().openapi({ description: "When retention or erasure removed payload/context (hashes stay in the audit chain)" }),
    decisions: z.array(Decision).optional(),
  })
  .openapi("ReviewRequest");
const RoutingOut = z
  .object({
    outcome: z.enum(["auto_approve", "human", "reject"]),
    approvals: z.number(),
    group: z.string().nullable(),
    ruleId: z.string().nullable(),
    timeoutSeconds: z.number().nullable(),
    escalateAfterSeconds: z.number().nullable(),
    escalateToGroup: z.string().nullable(),
    guardrails: z.array(z.string()),
    trace: z.array(z.object({ ruleId: z.string(), matched: z.boolean(), failed: z.array(z.string()) })),
    policyVersion: z.number(),
  })
  .openapi("ReviewRoutingSimulation");
const CreateBody = R.CreateReviewRequest.extend({ projectId: z.string().max(64).optional() });

agentReviews.openapi(
  def({
    method: "post",
    path: "/agent-reviews",
    tag: "Agent review",
    summary:
      "Ask for a human decision. The project's policy routes it (auto-approve, human, four-eyes or reject). Send Idempotency-Key: a retry with the same key and body returns the original request (200); the same key with a different body is 409.",
    body: CreateBody,
    response: ReviewOut,
    status: 201,
  }),
  async (c) => {
    const { projectId: requested, ...body } = c.req.valid("json");
    const projectId = await resolveProject(c, requested);
    const { row, created } = await S.createReview(c.env, scope(c), actor(c), projectId, body, c.req.header("idempotency-key") ?? null);
    return c.json(S.reviewOut(row), created ? 201 : (200 as never));
  },
);
agentReviews.openapi(
  def({
    method: "post",
    path: "/agent-reviews/simulate",
    tag: "Agent review",
    summary: "Dry run: how would this request be routed by the live policy (or a draft document)? Nothing is stored.",
    body: z.object({ request: CreateBody, document: R.PolicyDocument.optional() }),
    response: RoutingOut,
  }),
  async (c) => {
    const { request, document } = c.req.valid("json");
    const projectId = await resolveProject(c, request.projectId);
    const chosen = document
      ? { version: -1, doc: document }
      : S.choosePolicy(
          (await S.livePolicies(scope(c), projectId)).filter((p) => p.status === "active"),
          "simulate",
        );
    const r = R.evaluate(chosen.doc, {
      action: request.action,
      risk: request.risk,
      confidence: request.confidence ?? null,
      tags: request.tags,
      payload: request.payload,
      ...(request.minApprovals ? { minApprovals: request.minApprovals } : {}),
    });
    return c.json({ ...r, policyVersion: chosen.version }, 200);
  },
);

agentReviews.openapi(
  def({
    method: "get",
    path: "/agent-reviews",
    tag: "Agent review",
    summary: "List review requests (newest first), filterable by project, status, risk, group and externalId",
    query: z.object({
      projectId: z.string().max(64).optional(),
      status: R.ReviewStatus.optional(),
      risk: z.enum(R.RISK_LEVELS).optional(),
      group: z.string().max(60).optional(),
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
    const access = bound ? null : await accessScope(c);
    if (Array.isArray(access)) conds.push(`project_id in (select value from json_each(${arg(JSON.stringify(access))}))`);
    if (q.status) conds.push(`status = ${arg(q.status)}`);
    if (q.risk) conds.push(`risk = ${arg(q.risk)}`);
    if (q.group)
      conds.push(`(case when status = 'escalated' and escalate_to_group is not null then escalate_to_group else review_group end) = ${arg(q.group)}`);
    if (q.externalId) conds.push(`external_id = ${arg(q.externalId)}`);
    const cur = decodeCursor(q.cursor);
    if (cur) conds.push(`(created_at, id) < (${arg(cur[0])}, ${arg(cur[1])})`);
    const rows = await scope(c).all<S.RequestRow>(
      `select ${S.COLS} from review_requests where tenant_id = ?1${conds.map((x) => ` and ${x}`).join("")} order by created_at desc, id desc limit ${q.limit + 1}`,
      ...args,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map((r) => S.reviewOut(r)), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }, 200);
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
    const db = scope(c);
    const r = await S.expireIfDue(c.env, db, await S.loadReview(db, c.req.valid("param").id, await accessScope(c)));
    const ds = await db.all<S.DecisionRow>(
      "select id, reviewer, decision, reason, payload_version, created_at from review_decisions where tenant_id = ?1 and request_id = ?2 order by created_at, id",
      r.id,
    );
    return c.json(S.reviewOut(r, ds), 200);
  },
);

agentReviews.post("/agent-reviews/:id/decisions", async (c, next) => (c.get("principal").apiKey ? next() : requireRole("owner", "reviewer")(c, next)));
agentReviews.openapi(
  def({
    method: "post",
    path: "/agent-reviews/{id}/decisions",
    tag: "Agent review",
    summary:
      "Record a decision: approve, reject (veto), edit (replaces the payload; earlier approvals stop counting) or escalate. Routed requests need a member of the group (or an owner).",
    params: IdParam,
    body: R.DecideReviewRequest,
    response: ReviewOut,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    const r = await S.expireIfDue(c.env, db, await S.loadReview(db, c.req.valid("param").id, await accessScope(c)));
    const p = c.get("principal");
    const next = await decideAs(c.env, db, r, { userId: p.userId, email: actor(c), role: p.role, apiKey: !!p.apiKey }, b);
    return c.json(S.reviewOut(next), 200);
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
    const db = scope(c);
    const r = await S.expireIfDue(c.env, db, await S.loadReview(db, c.req.valid("param").id, await accessScope(c)));
    return c.json(S.reviewOut(await S.transition(c.env, db, r, { type: "cancel", by: actor(c) }, { actor: actor(c) })), 200);
  },
);

// ---------------- delivery: callbacks, long-poll wait, server-sent events ----------------
let pollMs = 500;
/** Test hook: shortens the wait/stream polling interval. */
export const pollInterval = () => pollMs;
export const __setAgentReviewPollMs = (ms: number | null) => {
  pollMs = ms ?? 500;
};
const CallbackOut = z
  .object({
    id: z.string(),
    url: z.string(),
    eventType: z.string(),
    status: z.enum(["pending", "failed", "succeeded", "dead"]),
    attempt: z.number(),
    responseStatus: z.number().nullable(),
    error: z.string().nullable(),
    durationMs: z.number().nullable(),
    nextAttemptAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
  })
  .openapi("ReviewCallbackDelivery");
const cbOut = (r: CallbackRow) => ({
  id: r.id,
  url: r.url,
  eventType: r.event_type,
  status: r.status,
  attempt: r.attempt,
  responseStatus: r.response_status,
  error: r.error,
  durationMs: r.duration_ms,
  nextAttemptAt: r.next_attempt_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
agentReviews.openapi(
  def({
    method: "get",
    path: "/agent-reviews/{id}/callbacks",
    tag: "Agent review",
    summary: "Callback delivery log for a request",
    params: IdParam,
    response: z.object({ items: z.array(CallbackOut) }),
  }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, await accessScope(c));
    const rows = await db.all<CallbackRow>(`select ${CALLBACK_COLS} from review_callbacks where tenant_id = ?1 and request_id = ?2 order by created_at`, r.id);
    return c.json({ items: rows.map(cbOut) }, 200);
  },
);
agentReviews.openapi(
  def({
    method: "post",
    path: "/agent-reviews/{id}/callbacks/redeliver",
    tag: "Agent review",
    summary: "Redeliver the request's callbacks now (including dead or already-succeeded ones). Receivers dedupe by callback id.",
    params: IdParam,
    response: z.object({ items: z.array(CallbackOut) }),
  }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, await accessScope(c));
    const ids = (await db.all<{ id: string }>("select id from review_callbacks where tenant_id = ?1 and request_id = ?2", r.id)).map((x) => x.id);
    if (!ids.length) throw notFound("Callback");
    for (const id of ids) {
      await db.run("update review_callbacks set status = 'pending', attempt = 0, next_attempt_at = ?3 where tenant_id = ?1 and id = ?2", id, now());
      await attemptCallback(c.env, db, id);
    }
    await db.run(
      "insert into audit_log (tenant_id, id, actor, action, subject) values (?1, ?2, ?3, 'review.callbacks_redelivered', ?4)",
      newId(),
      actor(c),
      r.id,
    );
    const rows = await db.all<CallbackRow>(`select ${CALLBACK_COLS} from review_callbacks where tenant_id = ?1 and request_id = ?2 order by created_at`, r.id);
    return c.json({ items: rows.map(cbOut) }, 200);
  },
);

agentReviews.openapi(
  def({
    method: "get",
    path: "/agent-reviews/{id}/wait",
    tag: "Agent review",
    summary: "Long-poll: returns as soon as the request is final, or after timeoutSeconds with its current state (check status; call again to keep waiting).",
    params: IdParam,
    query: z.object({ timeoutSeconds: z.coerce.number().int().min(0).max(25).default(20) }),
    response: ReviewOut,
  }),
  async (c) => {
    const db = scope(c);
    const bound = await accessScope(c);
    const id = c.req.valid("param").id;
    const until = Date.now() + c.req.valid("query").timeoutSeconds * 1000;
    let r = await S.expireIfDue(c.env, db, await S.loadReview(db, id, bound));
    while (!R.FINAL.has(r.status) && Date.now() < until) {
      await bus.wait(requestKey(db.tenantId, id), Math.min(pollMs, Math.max(0, until - Date.now())));
      r = await S.expireIfDue(c.env, db, await S.loadReview(db, id, bound));
    }
    c.header("x-review-final", String(R.FINAL.has(r.status)));
    return c.json(S.reviewOut(r), 200);
  },
);

// Plain Hono handler (streaming body), documented in the OpenAPI registry so SDKs and contract tests see it.
agentReviews.openAPIRegistry.registerPath(
  def({
    method: "get",
    path: "/agent-reviews/{id}/stream",
    tag: "Agent review",
    summary: "Server-sent events: `review` on every state change, then `end` (reason final | timeout). maxSeconds 1..55 (default 55); reconnect to continue.",
    params: IdParam,
    query: z.object({ maxSeconds: z.coerce.number().int().min(1).max(55).optional() }),
    response: z.string(),
    raw: { contentType: "text/event-stream" },
  }),
);
agentReviews.get("/agent-reviews/:id/stream", async (c) => {
  const db = scope(c);
  const bound = await accessScope(c);
  const id = c.req.param("id");
  const maxSeconds = Math.min(Math.max(Number(c.req.query("maxSeconds") ?? 55) || 55, 1), 55);
  let r = await S.loadReview(db, id, bound);
  const env = c.env;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const send = (ev: string, data: unknown) => ctl.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
      ctl.enqueue(enc.encode("retry: 2000\n\n"));
      const until = Date.now() + maxSeconds * 1000;
      let lastVersion = -1;
      try {
        for (;;) {
          r = await S.expireIfDue(env, db, r.version === lastVersion ? await S.loadReview(db, id, bound) : r);
          if (r.version !== lastVersion) {
            lastVersion = r.version;
            send("review", S.reviewOut(r));
          }
          if (R.FINAL.has(r.status)) {
            send("end", { reason: "final", status: r.status });
            break;
          }
          if (Date.now() >= until) {
            send("end", { reason: "timeout", status: r.status });
            break;
          }
          await bus.wait(requestKey(db.tenantId, id), Math.min(pollMs, Math.max(0, until - Date.now())));
        }
      } finally {
        ctl.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
});
