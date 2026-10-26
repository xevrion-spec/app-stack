/**
 * R3 workflow admin: project business-hours calendars (for `clock: "business"` SLAs) and reviewer delegation
 * (out of office). Delegation is one hop and time-boxed: the delegate may decide requests routed to the delegator's
 * groups, as themselves (their own role still applies), and each such decision is audited with the delegator.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import * as R from "@xevrion/agent-review";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { AppError, badRequest, notFound } from "../lib/errors.js";
import { newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { scope } from "./agent-reviews.js";

export const reviewWorkflow = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
const humans: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal").apiKey) throw new AppError(403, "forbidden", "API keys cannot manage reviewer workflow settings");
  return next();
};
reviewWorkflow.put("/review-projects/:id/business-hours", humans, requireRole("owner"));
reviewWorkflow.use("/review-delegations", humans, requireRole("owner", "reviewer"));
reviewWorkflow.use("/review-delegations/*", humans, requireRole("owner", "reviewer"));

const CalendarOut = z
  .object({ timeZone: z.string(), days: z.array(z.number().int()), start: z.string(), end: z.string(), holidays: z.array(z.string()) })
  .openapi("BusinessHours");
const CalendarIn = z
  .object({
    timeZone: z.string().openapi({ example: "Europe/London" }),
    days: z.array(z.number().int().min(1).max(7)).openapi({ description: "ISO weekdays, 1 = Monday", example: [1, 2, 3, 4, 5] }),
    start: z.string().openapi({ example: "09:00" }),
    end: z.string().openapi({ example: "17:30" }),
    holidays: z.array(z.string()).max(366).optional(),
  })
  .nullable();

async function projectOr404(c: Parameters<typeof scope>[0], id: string) {
  const p = await scope(c).first<{ business_hours_json: string | null }>(
    "select business_hours_json from review_projects where tenant_id = ?1 and id = ?2",
    id,
  );
  if (!p) throw notFound("Review project");
  return p;
}

reviewWorkflow.openapi(
  def({
    method: "get",
    path: "/review-projects/{id}/business-hours",
    tag: "Agent review",
    summary: "The project's business-hours calendar (null = none; business-clock rules then fall back to wall time, flagged)",
    params: IdParam,
    response: z.object({ businessHours: CalendarOut.nullable() }),
  }),
  async (c) => {
    const p = await projectOr404(c, c.req.valid("param").id);
    return c.json({ businessHours: p.business_hours_json ? (JSON.parse(p.business_hours_json) as z.infer<typeof CalendarOut>) : null }, 200);
  },
);
reviewWorkflow.openapi(
  def({
    method: "put",
    path: "/review-projects/{id}/business-hours",
    tag: "Agent review",
    summary: "Set or clear (null) the business-hours calendar. Applies to requests created afterwards.",
    params: IdParam,
    body: z.object({ businessHours: CalendarIn }),
    response: z.object({ businessHours: CalendarOut.nullable() }),
  }),
  async (c) => {
    const id = c.req.valid("param").id;
    await projectOr404(c, id);
    const raw = c.req.valid("json").businessHours;
    const parsed = raw === null ? null : R.Calendar.safeParse(raw);
    if (parsed && !parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "businessHours"}: ${i.message}`).join("; "));
    const cal = parsed ? { ...parsed.data, days: [...new Set(parsed.data.days)].sort(), holidays: [...new Set(parsed.data.holidays)].sort() } : null;
    const db = scope(c);
    await db.batch([
      db.stmt("update review_projects set business_hours_json = ?3 where tenant_id = ?1 and id = ?2", id, cal ? JSON.stringify(cal) : null),
      auditStmt(db, c.get("principal").email, "review.business_hours_set", id, cal),
    ]);
    return c.json({ businessHours: cal }, 200);
  },
);

// ---------------- delegation ----------------
const MAX_DAYS = 90;
const DelegationOut = z
  .object({
    id: z.string(),
    fromEmail: z.string(),
    toEmail: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    reason: z.string().nullable(),
    active: z.boolean(),
    revokedAt: z.string().nullable(),
    createdBy: z.string(),
    createdAt: z.string(),
  })
  .openapi("ReviewDelegation");
type DelRow = {
  id: string;
  from_email: string;
  to_email: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
};
const COLS = "id, from_email, to_email, starts_at, ends_at, reason, created_by, created_at, revoked_at";
const delOut = (d: DelRow, at = new Date().toISOString()) => ({
  id: d.id,
  fromEmail: d.from_email,
  toEmail: d.to_email,
  startsAt: d.starts_at,
  endsAt: d.ends_at,
  reason: d.reason,
  active: !d.revoked_at && d.starts_at <= at && d.ends_at > at,
  revokedAt: d.revoked_at,
  createdBy: d.created_by,
  createdAt: d.created_at,
});

async function reviewerOr400(db: ReturnType<typeof scope>, email: string, label: string) {
  const u = await db.first<{ role: string; deactivated_at: string | null }>(
    "select role, deactivated_at from users where tenant_id = ?1 and lower(email) = ?2",
    email,
  );
  if (!u || u.deactivated_at || (u.role !== "owner" && u.role !== "reviewer"))
    throw badRequest(`${label} must be an active owner or reviewer in this workspace`);
}

reviewWorkflow.openapi(
  def({
    method: "post",
    path: "/review-delegations",
    tag: "Agent review",
    summary: `Delegate your review duties (owners may delegate for anyone) to another reviewer for up to ${MAX_DAYS} days. Replaces your current delegation.`,
    body: z.object({
      toEmail: z.string().email(),
      fromEmail: z.string().email().optional().openapi({ description: "Owners only: delegate on behalf of this reviewer" }),
      startsAt: z.string().datetime().optional(),
      endsAt: z.string().datetime(),
      reason: z.string().max(200).optional(),
    }),
    response: DelegationOut,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const me = c.get("principal");
    const from = (b.fromEmail ?? me.email).toLowerCase();
    const to = b.toEmail.toLowerCase();
    if (from !== me.email.toLowerCase() && me.role !== "owner") throw new AppError(403, "forbidden", "Only owners can delegate for someone else");
    if (from === to) throw badRequest("You cannot delegate to yourself");
    const now = new Date();
    const starts = b.startsAt ? new Date(b.startsAt) : now;
    const ends = new Date(b.endsAt);
    if (ends <= starts || ends <= now) throw badRequest("endsAt must be after startsAt and in the future");
    if (ends.getTime() - Math.max(starts.getTime(), now.getTime()) > MAX_DAYS * 86_400_000) throw badRequest(`Delegations last at most ${MAX_DAYS} days`);
    const db = scope(c);
    await reviewerOr400(db, from, "fromEmail");
    await reviewerOr400(db, to, "toEmail");
    const id = newId();
    const at = now.toISOString();
    await db.batch([
      db.stmt("update review_delegations set revoked_at = ?3 where tenant_id = ?1 and from_email = ?2 and revoked_at is null", from, at),
      db.stmt(
        `insert into review_delegations (tenant_id, ${COLS}) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, null)`,
        id,
        from,
        to,
        starts.toISOString(),
        ends.toISOString(),
        b.reason ?? null,
        me.email,
        at,
      ),
      auditStmt(db, me.email, "review.delegation_set", id, { from, to, endsAt: ends.toISOString() }),
    ]);
    const row = await db.first<DelRow>(`select ${COLS} from review_delegations where tenant_id = ?1 and id = ?2`, id);
    return c.json(delOut(row!), 201);
  },
);
reviewWorkflow.openapi(
  def({
    method: "get",
    path: "/review-delegations",
    tag: "Agent review",
    summary: "Delegations: owners see all; reviewers see the ones from or to them",
    response: z.object({ items: z.array(DelegationOut) }),
  }),
  async (c) => {
    const me = c.get("principal");
    const db = scope(c);
    const rows =
      me.role === "owner"
        ? await db.all<DelRow>(`select ${COLS} from review_delegations where tenant_id = ?1 order by created_at desc limit 200`)
        : await db.all<DelRow>(
            `select ${COLS} from review_delegations where tenant_id = ?1 and (from_email = ?2 or to_email = ?2) order by created_at desc limit 200`,
            me.email.toLowerCase(),
          );
    return c.json({ items: rows.map((r) => delOut(r)) }, 200);
  },
);
reviewWorkflow.openapi(
  def({
    method: "delete",
    path: "/review-delegations/{id}",
    tag: "Agent review",
    summary: "End a delegation now (the delegator or an owner)",
    params: IdParam,
    response: DelegationOut,
  }),
  async (c) => {
    const me = c.get("principal");
    const db = scope(c);
    const id = c.req.valid("param").id;
    const row = await db.first<DelRow>(`select ${COLS} from review_delegations where tenant_id = ?1 and id = ?2`, id);
    if (!row || (me.role !== "owner" && row.from_email !== me.email.toLowerCase())) throw notFound("Delegation");
    if (!row.revoked_at) {
      const at = new Date().toISOString();
      await db.batch([
        db.stmt("update review_delegations set revoked_at = ?3 where tenant_id = ?1 and id = ?2", id, at),
        auditStmt(db, me.email, "review.delegation_revoked", id, { from: row.from_email, to: row.to_email }),
      ]);
      row.revoked_at = at;
    }
    return c.json(delOut(row), 200);
  },
);
