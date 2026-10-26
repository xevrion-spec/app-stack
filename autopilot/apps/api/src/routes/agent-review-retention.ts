/**
 * Retention + legal hold routes (A9b), owner only. Retention is per project; holds and manual erasure are per request.
 * Every change is audited; redaction also appends a `redacted` entry to the request's hash chain.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { auditStmt } from "../lib/audit.js";
import { AppError, notFound } from "../lib/errors.js";
import * as S from "../services/agent-review.js";
import { redactStmts, attachmentKeys, purgeObjects } from "../services/agent-review-retention.js";
import { scope, ReviewOut as Review } from "./agent-reviews.js";

export const agentReviewRetention = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
const ownerHuman: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal").apiKey) throw new AppError(403, "forbidden", "API keys cannot change retention or holds");
  return requireRole("owner")(c, next);
};
for (const p of ["/review-projects/:id/retention", "/agent-reviews/:id/legal-hold", "/agent-reviews/:id/redact"]) agentReviewRetention.use(p, ownerHuman);
/** Run a batch whose first statement nulls a NOT NULL column when its guard fails; that rolls back everything. */
async function guarded(db: ReturnType<typeof scope>, conflict: string, stmts: D1PreparedStatement[]) {
  try {
    await db.batch(stmts);
  } catch (e) {
    if (/UNIQUE|NOT NULL/.test(String(e))) throw new AppError(409, "version_conflict", conflict);
    throw e;
  }
}
const actor = (c: { get: (k: "principal") => { email: string } }) => c.get("principal").email;

const Retention = z.object({ retentionDays: z.number().int().min(1).max(3650).nullable() }).openapi("ReviewRetention");
agentReviewRetention.openapi(
  def({
    method: "put",
    path: "/review-projects/{id}/retention",
    tag: "Agent review",
    summary: "Set how long final requests keep their content (null = forever). Held requests are never redacted.",
    params: IdParam,
    body: Retention,
    response: Retention,
  }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    if (!(await db.first("select 1 from review_projects where tenant_id = ?1 and id = ?2 and archived_at is null", id))) throw notFound("Project");
    await db.batch([
      db.stmt("update review_projects set retention_days = ?3 where tenant_id = ?1 and id = ?2", id, b.retentionDays),
      auditStmt(db, actor(c), "agent_review.retention_set", id, b),
    ]);
    return c.json(b, 200);
  },
);

const Hold = z.object({ reason: z.string().min(3).max(500) }).openapi("LegalHoldIn");
agentReviewRetention.openapi(
  def({
    method: "post",
    path: "/agent-reviews/{id}/legal-hold",
    tag: "Agent review",
    summary: "Place a legal hold",
    params: IdParam,
    body: Hold,
    response: Review,
  }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, null);
    const t = new Date().toISOString();
    await guarded(db, "Already held, redacted or modified concurrently", [
      db.stmt(
        "update review_requests set legal_hold_at = ?3, legal_hold_by = ?4, legal_hold_reason = ?5, version = case when version = ?6 and legal_hold_at is null and redacted_at is null then version + 1 end, updated_at = ?3 where tenant_id = ?1 and id = ?2",
        r.id,
        t,
        actor(c),
        c.req.valid("json").reason,
        r.version,
      ),
      auditStmt(db, actor(c), "agent_review.legal_hold_placed", r.id, { reason: c.req.valid("json").reason }),
    ]);
    return c.json(S.reviewOut(await S.loadReview(db, r.id, null)), 200);
  },
);
agentReviewRetention.openapi(
  def({ method: "delete", path: "/agent-reviews/{id}/legal-hold", tag: "Agent review", summary: "Release a legal hold", params: IdParam, response: Review }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, null);
    await guarded(db, "Not held or modified concurrently", [
      db.stmt(
        "update review_requests set legal_hold_at = null, legal_hold_by = null, legal_hold_reason = null, version = case when version = ?4 and legal_hold_at is not null then version + 1 end, updated_at = ?3 where tenant_id = ?1 and id = ?2",
        r.id,
        new Date().toISOString(),
        r.version,
      ),
      auditStmt(db, actor(c), "agent_review.legal_hold_released", r.id),
    ]);
    return c.json(S.reviewOut(await S.loadReview(db, r.id, null)), 200);
  },
);
agentReviewRetention.openapi(
  def({
    method: "post",
    path: "/agent-reviews/{id}/redact",
    tag: "Agent review",
    summary: "Erase a final request's content now (e.g. an erasure request). Refused under legal hold. The hash chain is kept.",
    params: IdParam,
    response: Review,
  }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, null);
    const keys = await attachmentKeys(db, r.id);
    await guarded(db, "Request changed concurrently; retry", await redactStmts(db, r, actor(c), "erasure"));
    await purgeObjects(c.env, keys);
    return c.json(S.reviewOut(await S.loadReview(db, r.id, null)), 200);
  },
);
