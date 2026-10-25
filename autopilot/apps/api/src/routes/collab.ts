/**
 * Accountant collaboration: comments on any record (with @mentions → notifications), period close with four-eyes sign-off
 * (approved periods lock manual re-categorisation), and the in-app notifications centre with per-kind preferences.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireRole } from "../lib/auth.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { def, IdParam, validationHook } from "../lib/route.js";

type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const me = (c: C) => c.get("principal").email;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const collab = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
const member = requireRole("owner", "reviewer");
for (const p of ["/comments", "/comments/*", "/periods/*", "/notifications", "/notifications/*"]) collab.use(p, member);

const NOTIFICATION_KINDS = ["mention", "close_requested", "close_decided", "comment_on_close"] as const;
type Kind = (typeof NOTIFICATION_KINDS)[number];
/** Notification rows for recipients who have not switched this kind off (author never notifies themself). */
async function notifyStmts(db: TenantDb, to: string[], n: { kind: Kind; title: string; body: string | null; link: string | null; author: string }) {
  const { kind, title, body, link, author } = n;
  const uniq = [...new Set(to.map((e) => e.toLowerCase()))].filter((e) => e !== author.toLowerCase());
  if (!uniq.length) return [];
  const off = new Set(
    (await db.all<{ user_email: string }>("select user_email from notification_prefs where tenant_id = ?1 and kind = ?2 and enabled = 0", kind)).map(
      (r) => r.user_email,
    ),
  );
  return uniq
    .filter((e) => !off.has(e))
    .map((e) =>
      db.stmt(
        "insert into notifications (tenant_id, id, user_email, kind, title, body, link) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        newId(),
        e,
        kind,
        title,
        body,
        link,
      ),
    );
}
const members = async (db: TenantDb, roles?: string[]) =>
  (await db.all<{ email: string; role: string }>("select email, role from users where tenant_id = ?1"))
    .filter((u) => !roles || roles.includes(u.role))
    .map((u) => u.email);
export const mentionsIn = (body: string) => [...body.matchAll(/@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[1]!.toLowerCase());

// ---------- comments ----------
const SUBJECTS = ["transaction", "invoice", "exception", "journal", "period_close", "document", "vat_return"] as const;
const Comment = z
  .object({
    id: z.string(),
    subject_type: z.string(),
    subject_id: z.string(),
    body: z.string(),
    author: z.string(),
    resolved_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Comment");
collab.openapi(
  def({
    method: "get",
    path: "/comments",
    tag: "Collaboration",
    summary: "Comments on a record",
    query: z.object({ subjectType: z.enum(SUBJECTS), subjectId: z.string().max(64) }),
    response: z.array(Comment),
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(
      await scope(c).all<z.infer<typeof Comment>>(
        "select id, subject_type, subject_id, body, author, resolved_at, created_at from comments where tenant_id = ?1 and subject_type = ?2 and subject_id = ?3 order by created_at",
        q.subjectType,
        q.subjectId,
      ),
      200,
    );
  },
);
collab.openapi(
  def({
    method: "post",
    path: "/comments",
    tag: "Collaboration",
    summary: "Comment on any record; @email mentions notify tenant members",
    body: z.object({ subjectType: z.enum(SUBJECTS), subjectId: z.string().min(1).max(64), body: z.string().min(1).max(4000) }),
    response: Comment,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    const id = newId();
    const team = new Set((await members(db)).map((e) => e.toLowerCase()));
    const mentioned = mentionsIn(b.body).filter((e) => team.has(e)); // never notify outsiders
    await db.batch([
      db.stmt(
        "insert into comments (tenant_id, id, subject_type, subject_id, body, author) values (?1, ?2, ?3, ?4, ?5, ?6)",
        id,
        b.subjectType,
        b.subjectId,
        b.body,
        me(c),
      ),
      auditStmt(db, me(c), "comment.created", id, { subjectType: b.subjectType, subjectId: b.subjectId, mentions: mentioned.length }),
      ...(await notifyStmts(db, mentioned, {
        kind: "mention",
        title: `${me(c)} mentioned you`,
        body: b.body.slice(0, 200),
        link: `/${b.subjectType}/${b.subjectId}`,
        author: me(c),
      })),
    ]);
    return c.json(
      (await db.first<z.infer<typeof Comment>>(
        "select id, subject_type, subject_id, body, author, resolved_at, created_at from comments where tenant_id = ?1 and id = ?2",
        id,
      ))!,
      201,
    );
  },
);
collab.openapi(
  def({ method: "post", path: "/comments/{id}/resolve", tag: "Collaboration", summary: "Resolve a comment thread item", params: IdParam, response: Comment }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    if (
      !(await db.run(
        "update comments set resolved_at = ?3, resolved_by = ?4 where tenant_id = ?1 and id = ?2 and resolved_at is null",
        id,
        new Date().toISOString(),
        me(c),
      ))
    ) {
      if (!(await db.first("select id from comments where tenant_id = ?1 and id = ?2", id))) throw notFound("Comment");
      throw conflict("Already resolved");
    }
    return c.json(
      (await db.first<z.infer<typeof Comment>>(
        "select id, subject_type, subject_id, body, author, resolved_at, created_at from comments where tenant_id = ?1 and id = ?2",
        id,
      ))!,
      200,
    );
  },
);

// ---------- period close (four-eyes) ----------
const Close = z
  .object({
    id: z.string(),
    period_start: z.string(),
    period_end: z.string(),
    status: z.string(),
    requested_by: z.string(),
    decided_by: z.string().nullable(),
    note: z.string().nullable(),
  })
  .openapi("PeriodClose");
const closeById = (db: TenantDb, id: string) =>
  db.first<z.infer<typeof Close>>(
    "select id, period_start, period_end, status, requested_by, decided_by, note from period_closes where tenant_id = ?1 and id = ?2",
    id,
  );

/** Throws 409 when the transaction's date is inside an approved (locked) period. */
export async function assertPeriodOpen(db: TenantDb, transactionId: string): Promise<void> {
  const locked = await db.first<{ id: string }>(
    "select p.id from period_closes p join transactions t on t.tenant_id = p.tenant_id and t.id = ?2 where p.tenant_id = ?1 and p.status = 'approved' and t.txn_date between p.period_start and p.period_end",
    transactionId,
  );
  if (locked) throw conflict("This period is closed and signed off; reopen it before changing transactions");
}
collab.openapi(
  def({ method: "get", path: "/periods/closes", tag: "Collaboration", summary: "Period close requests and sign-offs", response: z.array(Close) }),
  async (c) =>
    c.json(
      await scope(c).all<z.infer<typeof Close>>(
        "select id, period_start, period_end, status, requested_by, decided_by, note from period_closes where tenant_id = ?1 order by period_start desc",
      ),
      200,
    ),
);
collab.openapi(
  def({
    method: "post",
    path: "/periods/closes",
    tag: "Collaboration",
    summary: "Request sign-off to close a period (notifies accountants and owners)",
    body: z.object({ periodStart: Day, periodEnd: Day, note: z.string().max(500).optional() }),
    response: Close,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    if (b.periodEnd < b.periodStart) throw badRequest("periodEnd must be on or after periodStart");
    const db = scope(c);
    const overlap = await db.first(
      "select id from period_closes where tenant_id = ?1 and status in ('requested','approved') and period_start <= ?3 and period_end >= ?2",
      b.periodStart,
      b.periodEnd,
    );
    if (overlap) throw conflict("An open request or approved close overlaps this period");
    const id = newId();
    await db.batch([
      db.stmt(
        "insert into period_closes (tenant_id, id, period_start, period_end, requested_by, note) values (?1, ?2, ?3, ?4, ?5, ?6)",
        id,
        b.periodStart,
        b.periodEnd,
        me(c),
        b.note ?? null,
      ),
      auditStmt(db, me(c), "period.close_requested", id, { from: b.periodStart, to: b.periodEnd }),
      ...(await notifyStmts(db, await members(db, ["accountant", "owner"]), {
        kind: "close_requested",
        title: `Sign-off requested: ${b.periodStart} to ${b.periodEnd}`,
        body: b.note ?? null,
        link: `/periods/${id}`,
        author: me(c),
      })),
    ]);
    return c.json((await closeById(db, id))!, 201);
  },
);
collab.openapi(
  def({
    method: "post",
    path: "/periods/closes/{id}/decision",
    tag: "Collaboration",
    summary: "Approve or reject a close (accountant or owner; never the requester)",
    params: IdParam,
    body: z.object({ decision: z.enum(["approve", "reject", "reopen"]), note: z.string().max(500).optional() }),
    response: Close,
  }),
  async (c) => {
    const role = c.get("principal").role;
    if (role !== "accountant" && role !== "owner") throw forbidden("Only an accountant or owner can sign off a period");
    const db = scope(c);
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const cur = await closeById(db, id);
    if (!cur) throw notFound("Period close");
    const to = b.decision === "approve" ? "approved" : b.decision === "reject" ? "rejected" : "reopened";
    const allowed = b.decision === "reopen" ? cur.status === "approved" : cur.status === "requested";
    if (!allowed) throw conflict(`Cannot ${b.decision} a ${cur.status} close`);
    if (b.decision !== "reopen" && cur.requested_by.toLowerCase() === me(c).toLowerCase())
      throw forbidden("Four-eyes: the requester cannot sign off their own close");
    await db.batch([
      db.stmt(
        "update period_closes set status = ?3, decided_by = ?4, decided_at = ?5, note = coalesce(?6, note) where tenant_id = ?1 and id = ?2",
        id,
        to,
        me(c),
        new Date().toISOString(),
        b.note ?? null,
      ),
      auditStmt(db, me(c), `period.${to}`, id, { from: cur.status, note: b.note ?? null }),
      ...(await notifyStmts(db, [cur.requested_by], {
        kind: "close_decided",
        title: `Period ${cur.period_start} to ${cur.period_end} ${to}`,
        body: b.note ?? null,
        link: `/periods/${id}`,
        author: me(c),
      })),
    ]);
    return c.json((await closeById(db, id))!, 200);
  },
);

// ---------- notifications ----------
const Note = z
  .object({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    link: z.string().nullable(),
    read_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Notification");
collab.openapi(
  def({
    method: "get",
    path: "/notifications",
    tag: "Notifications",
    summary: "My notifications (newest first)",
    query: z.object({ unread: z.enum(["true", "false"]).default("false") }),
    response: z.object({ unreadCount: z.number(), items: z.array(Note) }),
  }),
  async (c) => {
    const db = scope(c);
    const unreadOnly = c.req.valid("query").unread === "true";
    const items = await db.all<z.infer<typeof Note>>(
      `select id, kind, title, body, link, read_at, created_at from notifications where tenant_id = ?1 and user_email = ?2${unreadOnly ? " and read_at is null" : ""} order by created_at desc limit 200`,
      me(c).toLowerCase(),
    );
    const n =
      (await db.first<{ n: number }>("select count(*) n from notifications where tenant_id = ?1 and user_email = ?2 and read_at is null", me(c).toLowerCase()))
        ?.n ?? 0;
    return c.json({ unreadCount: n, items }, 200);
  },
);
collab.openapi(
  def({
    method: "post",
    path: "/notifications/{id}/read",
    tag: "Notifications",
    summary: "Mark one read",
    params: IdParam,
    response: z.object({ ok: z.boolean() }),
  }),
  async (c) => {
    const n = await scope(c).run(
      "update notifications set read_at = coalesce(read_at, ?4) where tenant_id = ?1 and id = ?2 and user_email = ?3",
      c.req.valid("param").id,
      me(c).toLowerCase(),
      new Date().toISOString(),
    );
    if (!n) throw notFound("Notification");
    return c.json({ ok: true }, 200);
  },
);
collab.openapi(
  def({ method: "post", path: "/notifications/read-all", tag: "Notifications", summary: "Mark all read", response: z.object({ updated: z.number() }) }),
  async (c) =>
    c.json(
      {
        updated: await scope(c).run(
          "update notifications set read_at = ?3 where tenant_id = ?1 and user_email = ?2 and read_at is null",
          me(c).toLowerCase(),
          new Date().toISOString(),
        ),
      },
      200,
    ),
);
const Prefs = z.partialRecord(z.enum(NOTIFICATION_KINDS), z.boolean()); // zod 4: z.record(enum) would require every key
collab.openapi(
  def({
    method: "get",
    path: "/notifications/preferences",
    tag: "Notifications",
    summary: "My notification preferences (default on)",
    response: z.record(z.string(), z.boolean()),
  }),
  async (c) => {
    const rows = await scope(c).all<{ kind: string; enabled: number }>(
      "select kind, enabled from notification_prefs where tenant_id = ?1 and user_email = ?2",
      me(c).toLowerCase(),
    );
    const m = new Map(rows.map((r) => [r.kind, !!r.enabled]));
    return c.json(Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, m.get(k) ?? true])), 200);
  },
);
collab.openapi(
  def({
    method: "put",
    path: "/notifications/preferences",
    tag: "Notifications",
    summary: "Update my preferences",
    body: Prefs,
    response: z.record(z.string(), z.boolean()),
  }),
  async (c) => {
    const db = scope(c);
    const b = c.req.valid("json");
    const stmts = Object.entries(b).map(([k, v]) =>
      db.stmt(
        "insert into notification_prefs (tenant_id, user_email, kind, enabled) values (?1, ?2, ?3, ?4) on conflict (tenant_id, user_email, kind) do update set enabled = excluded.enabled",
        me(c).toLowerCase(),
        k,
        v ? 1 : 0,
      ),
    );
    if (stmts.length) await db.batch(stmts);
    const rows = await db.all<{ kind: string; enabled: number }>(
      "select kind, enabled from notification_prefs where tenant_id = ?1 and user_email = ?2",
      me(c).toLowerCase(),
    );
    const m = new Map(rows.map((r) => [r.kind, !!r.enabled]));
    return c.json(Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, m.get(k) ?? true])), 200);
  },
);

// ---------- multi-business ----------
collab.openapi(
  def({
    method: "get",
    path: "/me/memberships",
    tag: "Account",
    summary: "Businesses I belong to (switch with the x-tenant-id header)",
    response: z.array(z.object({ tenantId: z.string(), name: z.string(), role: z.string(), current: z.boolean() })),
  }),
  async (c) => {
    // Like the membership lookup in auth, this is keyed by the caller's own verified email, not by tenant.
    const rows =
      (
        await c.env.DB.prepare("select t.id, t.name, u.role from users u join tenants t on t.id = u.tenant_id where u.email = ?1 order by t.name")
          .bind(me(c))
          .all<{ id: string; name: string; role: string }>()
      ).results ?? [];
    return c.json(
      rows.map((r) => ({ tenantId: r.id, name: r.name, role: r.role, current: r.id === c.get("principal").tenantId })),
      200,
    );
  },
);
