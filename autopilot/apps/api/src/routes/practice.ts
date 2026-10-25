/**
 * Practice co-pilot API, part 1: the firm model (ADR 0024).
 * practice -> clients (each client is a business/tenant), staff roles (partner, manager, preparer, reviewer, readonly),
 * per-client assignment, practice dashboards and guarded cross-client bulk actions.
 * Isolation: every query goes through PracticeDb (practice_id = ?1) and the staff member's client scope
 * (clientScopeSql); a client tenant belongs to at most one practice (unique index). Staff never get tenant memberships.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import * as B from "@xevrion/books";
import type { AppEnv, PracticeRole } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import { CLIENT_COLS, PracticeAudit, accessibleClient, clientScopeSql, practiceDb, requirePracticeRole, PracticeDb, type ClientRow } from "../lib/practice.js";
import { defaultSetupStatements } from "../services/defaults.js";
import { Outbox } from "../services/events.js";
import { DEFAULT_CLOSE_TEMPLATES, practiceQuota } from "../services/practice.js";

export const practice = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });

const Role = z.enum(["partner", "manager", "preparer", "reviewer", "readonly"]);
const ClientId = z.object({ id: z.string().min(1).max(64) });
const today = () => new Date().toISOString().slice(0, 10);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const daysBetween = (a: string, b: string) => Math.floor((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);
export const MANAGERS: PracticeRole[] = ["partner", "manager"];
export const SIGNERS: PracticeRole[] = ["partner", "manager", "reviewer"];

// ---------------- create a practice (any signed-in identity; caller becomes partner) ----------------
practice.openapi(
  def({
    method: "post",
    path: "/practices",
    tag: "Practice",
    summary: "Create an accountancy practice (caller becomes partner); seeds default close templates",
    body: z.object({ name: z.string().min(1).max(120) }),
    response: z.object({ id: z.string(), name: z.string(), role: Role }),
    status: 201,
  }),
  async (c) => {
    const email = c.get("identityEmail");
    if (!email || email.startsWith("api_key:")) throw new AppError(403, "insufficient_scope", "API keys cannot create practices");
    const { name } = c.req.valid("json");
    const id = newId();
    const raw = c.env.DB;
    const owned = await raw.prepare("select count(*) n from practice_staff where email = ?1 and role = 'partner'").bind(email).first<{ n: number }>();
    if ((owned?.n ?? 0) >= 5) throw conflict("This user already partners 5 practices");
    const pdb = new PracticeDb(raw, id, email);
    const audit = new PracticeAudit(pdb);
    await pdb.batch([
      raw.prepare("insert into practices (id, name) values (?1, ?2)").bind(id, name),
      pdb.stmt("insert into practice_staff (practice_id, email, role) values (?1, ?3, 'partner')", email),
      ...DEFAULT_CLOSE_TEMPLATES.map((t) =>
        pdb.stmt(
          "insert into close_templates (practice_id, id, name, kind, items_json) values (?1, ?3, ?4, ?5, ?6)",
          newId(),
          t.name,
          t.kind,
          JSON.stringify(t.items),
        ),
      ),
      await audit.stmt("practice.created", id, null, { name }),
    ]);
    return c.json({ id, name, role: "partner" as const }, 201);
  },
);

practice.openapi(
  def({
    method: "get",
    path: "/practice",
    tag: "Practice",
    summary: "The signed-in staff member's practice, role and plan quota",
    response: z.object({
      id: z.string(),
      name: z.string(),
      plan: z.string(),
      role: Role,
      email: z.string(),
      clients: z.number(),
      staff: z.number(),
      quota: z.object({ maxClients: z.number(), maxStaff: z.number(), aiReviewsPerMonth: z.number() }),
    }),
  }),
  async (c) => {
    const p = c.get("practice");
    const pdb = practiceDb(c);
    const row = await pdb.first<{ name: string; plan: string }>("select name, plan from practices where id = ?1");
    const n = async (sql: string) => (await pdb.first<{ n: number }>(sql))?.n ?? 0;
    return c.json(
      {
        id: p.practiceId,
        name: row?.name ?? "",
        plan: row?.plan ?? "trial",
        role: p.role,
        email: p.email,
        clients: await n("select count(*) n from practice_clients where practice_id = ?1 and status != 'archived'"),
        staff: await n("select count(*) n from practice_staff where practice_id = ?1"),
        quota: practiceQuota(row?.plan ?? "trial"),
      },
      200,
    );
  },
);

// ---------------- staff ----------------
const Staff = z.object({ email: z.string(), role: Role, display_name: z.string().nullable(), created_at: z.string() });
practice.openapi(
  def({ method: "get", path: "/practice/staff", tag: "Practice", summary: "List staff", response: z.object({ items: z.array(Staff) }) }),
  async (c) =>
    c.json(
      {
        items: await practiceDb(c).all<z.infer<typeof Staff>>(
          "select email, role, display_name, created_at from practice_staff where practice_id = ?1 order by email",
        ),
      },
      200,
    ),
);
practice.use("/practice/staff", async (c, next) => (c.req.method === "GET" ? next() : requirePracticeRole("partner")(c, next)));
practice.use("/practice/staff/*", requirePracticeRole("partner"));
practice.openapi(
  def({
    method: "post",
    path: "/practice/staff",
    tag: "Practice",
    summary: "Add or change a staff member (partner only)",
    body: z.object({ email: z.string().email().max(200), role: Role, displayName: z.string().max(120).nullable().default(null) }),
    response: Staff,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    const email = b.email.toLowerCase();
    const plan = (await pdb.first<{ plan: string }>("select plan from practices where id = ?1"))?.plan ?? "trial";
    const existing = await pdb.first<{ role: string }>("select role from practice_staff where practice_id = ?1 and email = ?3", email);
    const staffCount = (await pdb.first<{ n: number }>("select count(*) n from practice_staff where practice_id = ?1"))?.n ?? 0;
    if (!existing && staffCount >= practiceQuota(plan).maxStaff)
      throw new AppError(429, "quota_exceeded", "Staff quota reached for this plan", { metric: "staff" });
    if (existing?.role === "partner" && b.role !== "partner") await assertAnotherPartner(pdb, email);
    const audit = new PracticeAudit(pdb);
    await pdb.batch([
      pdb.stmt(
        "insert into practice_staff (practice_id, email, role, display_name) values (?1, ?3, ?4, ?5) on conflict (practice_id, email) do update set role = excluded.role, display_name = excluded.display_name",
        email,
        b.role,
        b.displayName,
      ),
      // a role change away from preparer/reviewer keeps assignments, which only matter for those roles
      await audit.stmt("staff.upserted", email, null, { role: b.role, previous: existing?.role ?? null }),
    ]);
    const row = await pdb.first<z.infer<typeof Staff>>(
      "select email, role, display_name, created_at from practice_staff where practice_id = ?1 and email = ?3",
      email,
    );
    return c.json(row!, 200);
  },
);
async function assertAnotherPartner(pdb: PracticeDb, email: string) {
  const others = await pdb.first<{ n: number }>("select count(*) n from practice_staff where practice_id = ?1 and role = 'partner' and email != ?3", email);
  if (!others?.n) throw conflict("A practice must keep at least one partner");
}
practice.openapi(
  def({
    method: "delete",
    path: "/practice/staff/{email}",
    tag: "Practice",
    summary: "Remove a staff member and their assignments (partner only; the last partner cannot be removed)",
    params: z.object({ email: z.string().min(3).max(200) }),
    response: z.object({ removed: z.boolean() }),
  }),
  async (c) => {
    const email = c.req.valid("param").email.toLowerCase();
    const pdb = practiceDb(c);
    const row = await pdb.first<{ role: string }>("select role from practice_staff where practice_id = ?1 and email = ?3", email);
    if (!row) throw notFound("Staff member");
    if (row.role === "partner") await assertAnotherPartner(pdb, email);
    const audit = new PracticeAudit(pdb);
    await pdb.batch([
      pdb.stmt("delete from client_assignments where practice_id = ?1 and email = ?3", email),
      pdb.stmt("delete from review_claims where practice_id = ?1 and assignee = ?3", email),
      pdb.stmt("delete from practice_staff where practice_id = ?1 and email = ?3", email),
      await audit.stmt("staff.removed", email, null, { role: row.role }),
    ]);
    return c.json({ removed: true }, 200);
  },
);

// ---------------- clients ----------------
const ClientSummary = z.object({
  tenantId: z.string(),
  name: z.string(),
  status: z.string(),
  feeModel: z.string(),
  awaitingReview: z.number(),
  oldestAwaitingDays: z.number(),
  openQueries: z.number(),
  openExceptions: z.number(),
  health: z.object({ score: z.number(), status: z.enum(["green", "amber", "red"]), reasons: z.array(z.string()) }),
  nextDeadline: z.object({ title: z.string(), dueDate: z.string(), daysLeft: z.number() }).nullable(),
  assignees: z.array(z.object({ email: z.string(), role: z.string() })),
});
type Summary = z.infer<typeof ClientSummary>;

/** One aggregate query per signal for ALL visible clients (no per-client N+1), then pure health scoring. */
export async function clientSummaries(pdb: PracticeDb, role: PracticeRole, asOf: string, onlyTenant?: string): Promise<Summary[]> {
  const scope = clientScopeSql(role);
  const filter = onlyTenant ? " and pc.tenant_id = ?3" : "";
  const args = onlyTenant ? [onlyTenant] : [];
  const clients = await pdb.all<ClientRow>(
    `select ${CLIENT_COLS.split(", ")
      .map((x) => `pc.${x}`)
      .join(", ")} from practice_clients pc where pc.practice_id = ?1 and pc.tenant_id in (${scope})${filter} order by pc.name, pc.tenant_id`,
    ...args,
  );
  if (!clients.length) return [];
  const byT = <T extends { tenant_id: string }>(rows: T[]) => new Map(rows.map((r) => [r.tenant_id, r]));
  const tf = onlyTenant ? " and t.tenant_id = ?3" : "";
  const awaiting = byT(
    await pdb.all<{ tenant_id: string; n: number; oldest: string | null; last: string | null }>(
      `select t.tenant_id, sum(case when t.reviewed_at is null then 1 else 0 end) n, min(case when t.reviewed_at is null then t.created_at end) oldest, max(t.created_at) last
       from transactions t where t.tenant_id in (${scope})${tf} group by t.tenant_id`,
      ...args,
    ),
  );
  const queries = byT(
    await pdb.all<{ tenant_id: string; n: number }>(
      `select q.tenant_id, count(*) n from client_queries q where q.practice_id = ?1 and q.status = 'open' and q.tenant_id in (${scope})${onlyTenant ? " and q.tenant_id = ?3" : ""} group by q.tenant_id`,
      ...args,
    ),
  );
  const exc = byT(
    await pdb.all<{ tenant_id: string; n: number }>(
      `select e.tenant_id, count(*) n from exceptions e where e.status = 'open' and e.tenant_id in (${scope})${onlyTenant ? " and e.tenant_id = ?3" : ""} group by e.tenant_id`,
      ...args,
    ),
  );
  const assign = await pdb.all<{ tenant_id: string; email: string; role: string }>(
    `select a.tenant_id, a.email, a.role from client_assignments a where a.practice_id = ?1 and a.tenant_id in (${scope})${onlyTenant ? " and a.tenant_id = ?3" : ""} order by a.role, a.email`,
    ...args,
  );
  return clients.map((cl) => {
    const a = awaiting.get(cl.tenant_id);
    const dl = B.clientDeadlines({ vatStagger: cl.vat_stagger, mtdItsa: !!cl.mtd_itsa, saRequired: !!cl.sa_required }, asOf, 60);
    const oldestAwaitingDays = a?.oldest ? Math.max(0, daysBetween(a.oldest, asOf)) : 0;
    const health = B.clientHealth({
      awaitingReview: a?.n ?? 0,
      oldestAwaitingDays,
      openQueries: queries.get(cl.tenant_id)?.n ?? 0,
      overdueDeadlines: dl.filter((d) => d.daysLeft < 0).length,
      dueSoonDeadlines: dl.filter((d) => d.daysLeft >= 0 && d.daysLeft <= 14).length,
      anomalies: exc.get(cl.tenant_id)?.n ?? 0,
      daysSinceLastActivity: a?.last ? daysBetween(a.last, asOf) : null,
    });
    const next = dl.find((d) => d.daysLeft >= 0) ?? null;
    return {
      tenantId: cl.tenant_id,
      name: cl.name,
      status: cl.status,
      feeModel: cl.fee_model,
      awaitingReview: a?.n ?? 0,
      oldestAwaitingDays,
      openQueries: queries.get(cl.tenant_id)?.n ?? 0,
      openExceptions: exc.get(cl.tenant_id)?.n ?? 0,
      health,
      nextDeadline: next ? { title: next.title, dueDate: next.dueDate, daysLeft: next.daysLeft } : null,
      assignees: assign.filter((x) => x.tenant_id === cl.tenant_id).map(({ email, role }) => ({ email, role })),
    };
  });
}

practice.openapi(
  def({
    method: "get",
    path: "/practice/clients",
    tag: "Practice",
    summary: "Clients visible to me with health, review backlog, queries and next deadline (worst health first)",
    query: z.object({ asOf: Day.optional(), status: z.enum(["onboarding", "active", "archived"]).optional() }),
    response: z.object({ items: z.array(ClientSummary) }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const items = (await clientSummaries(practiceDb(c), c.get("practice").role, q.asOf ?? today()))
      .filter((s) => (q.status ? s.status === q.status : s.status !== "archived"))
      .sort((a, b) => a.health.score - b.health.score || a.name.localeCompare(b.name));
    return c.json({ items }, 200);
  },
);

const ClientSettings = z.object({
  vatStagger: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  mtdItsa: z.boolean(),
  saRequired: z.boolean(),
  yearEnd: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  feeModel: z.enum(["fixed", "hourly", "outcome"]),
  feePence: z.number().int().min(0).max(100_000_000),
  hourlyRatePence: z.number().int().min(0).max(10_000_000),
  autoApprove: z.object({ threshold: z.number().min(0.9).max(1), categories: z.array(z.string().regex(/^\d{4}$/)).max(50) }),
  qaSampleRate: z.number().min(0).max(1),
  reviewSlaHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30),
  status: z.enum(["onboarding", "active", "archived"]),
});
practice.use("/practice/clients", async (c, next) => (c.req.method === "GET" ? next() : requirePracticeRole(...MANAGERS)(c, next)));
practice.openapi(
  def({
    method: "post",
    path: "/practice/clients",
    tag: "Practice",
    summary: "Add a client business (creates its books with the default chart of accounts); partner/manager",
    body: ClientSettings.partial()
      .omit({ status: true })
      .extend({
        name: z.string().min(1).max(120),
        vatRegistered: z.boolean().default(false),
        vatScheme: z.enum(["standard", "cash", "flat_rate"]).nullable().default(null),
      }),
    response: z.object({ tenantId: z.string(), name: z.string(), status: z.string() }),
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const p = c.get("practice");
    const pdb = practiceDb(c);
    const plan = (await pdb.first<{ plan: string }>("select plan from practices where id = ?1"))?.plan ?? "trial";
    const count = (await pdb.first<{ n: number }>("select count(*) n from practice_clients where practice_id = ?1 and status != 'archived'"))?.n ?? 0;
    if (count >= practiceQuota(plan).maxClients)
      throw new AppError(429, "quota_exceeded", `Client quota (${practiceQuota(plan).maxClients}) reached for this plan`, { metric: "clients" });
    if (b.vatRegistered && !b.vatStagger) throw badRequest("vatStagger (1, 2 or 3) is required for a VAT-registered client");
    const tid = newId();
    const raw = c.env.DB;
    const tdb = new TenantDb(raw, tid);
    const audit = new PracticeAudit(pdb);
    const outbox = new Outbox(tdb);
    outbox.add("practice.client_added", { practiceId: p.practiceId, clientName: b.name }, p.email);
    await raw.batch([
      raw
        .prepare("insert into tenants (id, name, trading_type, vat_registered, vat_scheme, plan) values (?1, ?2, 'sole_trader', ?3, ?4, 'practice')")
        .bind(tid, b.name, b.vatRegistered ? 1 : 0, b.vatScheme),
      ...defaultSetupStatements(tdb),
      pdb.stmt(
        `insert into practice_clients (practice_id, tenant_id, name, status, year_end, vat_stagger, mtd_itsa, sa_required, fee_model, fee_pence, hourly_rate_pence, auto_approve_json, qa_sample_rate, review_sla_hours)
         values (?1, ?3, ?4, 'onboarding', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
        tid,
        b.name,
        b.yearEnd ?? "04-05",
        b.vatRegistered ? (b.vatStagger ?? null) : null,
        b.mtdItsa ? 1 : 0,
        b.saRequired === false ? 0 : 1,
        b.feeModel ?? "fixed",
        b.feePence ?? 0,
        b.hourlyRatePence ?? 0,
        JSON.stringify(b.autoApprove ?? { threshold: 0.97, categories: [] }),
        b.qaSampleRate ?? 0.1,
        b.reviewSlaHours ?? 48,
      ),
      auditStmt(tdb, p.email, "practice.client_added", tid, { practiceId: p.practiceId }),
      await audit.stmt("client.created", tid, tid, { name: b.name }),
      ...outbox.stmts,
    ]);
    await outbox.publish(c.env);
    return c.json({ tenantId: tid, name: b.name, status: "onboarding" }, 201);
  },
);

practice.openapi(
  def({
    method: "get",
    path: "/practice/clients/{id}",
    tag: "Practice",
    summary: "Client detail: settings, health, deadlines and assignments",
    params: ClientId,
    query: z.object({ asOf: Day.optional() }),
    response: z.object({
      summary: ClientSummary,
      settings: ClientSettings,
      deadlines: z.array(z.object({ id: z.string(), kind: z.string(), title: z.string(), dueDate: z.string(), daysLeft: z.number(), verified: z.boolean() })),
    }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const asOf = c.req.valid("query").asOf ?? today();
    const pdb = practiceDb(c);
    const role = c.get("practice").role;
    const cl = await accessibleClient(pdb, role, id);
    const [summary] = await clientSummaries(pdb, role, asOf, id);
    const deadlines = B.clientDeadlines({ vatStagger: cl.vat_stagger, mtdItsa: !!cl.mtd_itsa, saRequired: !!cl.sa_required }, asOf, 120).map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      dueDate: d.dueDate,
      daysLeft: d.daysLeft,
      verified: d.verified,
    }));
    return c.json({ summary: summary!, settings: settingsOf(cl), deadlines }, 200);
  },
);
const settingsOf = (cl: ClientRow): z.infer<typeof ClientSettings> => ({
  vatStagger: cl.vat_stagger,
  mtdItsa: !!cl.mtd_itsa,
  saRequired: !!cl.sa_required,
  yearEnd: cl.year_end,
  feeModel: cl.fee_model,
  feePence: cl.fee_pence,
  hourlyRatePence: cl.hourly_rate_pence,
  autoApprove: B.parsePolicy(cl.auto_approve_json),
  qaSampleRate: cl.qa_sample_rate,
  reviewSlaHours: cl.review_sla_hours,
  status: cl.status as "onboarding" | "active" | "archived",
});

practice.use("/practice/clients/:id", async (c, next) => (c.req.method === "GET" ? next() : requirePracticeRole(...MANAGERS)(c, next)));
practice.openapi(
  def({
    method: "patch",
    path: "/practice/clients/{id}",
    tag: "Practice",
    summary: "Change client settings: deadlines config, fees, auto-approve policy, QA sampling, SLA, status (partner/manager)",
    params: ClientId,
    body: ClientSettings.partial(),
    response: ClientSettings,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    const cl = await accessibleClient(pdb, c.get("practice").role, id);
    const next = { ...settingsOf(cl), ...b };
    if (b.status && b.status !== "archived" && cl.status === "archived") {
      const plan = (await pdb.first<{ plan: string }>("select plan from practices where id = ?1"))?.plan ?? "trial";
      const count = (await pdb.first<{ n: number }>("select count(*) n from practice_clients where practice_id = ?1 and status != 'archived'"))?.n ?? 0;
      if (count >= practiceQuota(plan).maxClients) throw new AppError(429, "quota_exceeded", "Client quota reached for this plan", { metric: "clients" });
    }
    const audit = new PracticeAudit(pdb);
    await pdb.batch([
      pdb.stmt(
        `update practice_clients set vat_stagger = ?4, mtd_itsa = ?5, sa_required = ?6, year_end = ?7, fee_model = ?8, fee_pence = ?9, hourly_rate_pence = ?10,
         auto_approve_json = ?11, qa_sample_rate = ?12, review_sla_hours = ?13, status = ?14 where practice_id = ?1 and tenant_id = ?3`,
        id,
        next.vatStagger,
        next.mtdItsa ? 1 : 0,
        next.saRequired ? 1 : 0,
        next.yearEnd,
        next.feeModel,
        next.feePence,
        next.hourlyRatePence,
        JSON.stringify(next.autoApprove),
        next.qaSampleRate,
        next.reviewSlaHours,
        next.status,
      ),
      await audit.stmt("client.settings_changed", id, id, b),
    ]);
    return c.json(next, 200);
  },
);

const Assignment = z.object({ email: z.string().email().max(200), role: z.enum(["preparer", "reviewer"]) });
practice.use("/practice/clients/:id/assignments", requirePracticeRole(...MANAGERS));
practice.openapi(
  def({
    method: "put",
    path: "/practice/clients/{id}/assignments",
    tag: "Practice",
    summary: "Replace a client's preparer/reviewer assignments (partner/manager)",
    params: ClientId,
    body: z.object({ assignments: z.array(Assignment).max(20) }),
    response: z.object({ assignments: z.array(Assignment) }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const list = c.req.valid("json").assignments.map((a) => ({ ...a, email: a.email.toLowerCase() }));
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, id);
    await assertAssignable(pdb, list);
    const audit = new PracticeAudit(pdb);
    await pdb.batch([
      pdb.stmt("delete from client_assignments where practice_id = ?1 and tenant_id = ?3", id),
      ...list.map((a) =>
        pdb.stmt("insert or ignore into client_assignments (practice_id, tenant_id, email, role) values (?1, ?3, ?4, ?5)", id, a.email, a.role),
      ),
      await audit.stmt("client.assignments_set", id, id, list),
    ]);
    return c.json({ assignments: list }, 200);
  },
);
/** Assignees must be staff; a reviewer assignment needs a staff role that may sign off. */
export async function assertAssignable(pdb: PracticeDb, list: { email: string; role: "preparer" | "reviewer" }[]) {
  const staff = new Map(
    (await pdb.all<{ email: string; role: PracticeRole }>("select email, role from practice_staff where practice_id = ?1")).map((s) => [s.email, s.role]),
  );
  for (const a of list) {
    const r = staff.get(a.email);
    if (!r) throw badRequest(`${a.email} is not on the practice staff`);
    if (r === "readonly") throw badRequest(`${a.email} is read-only and cannot be assigned`);
    if (a.role === "reviewer" && r === "preparer") throw badRequest(`${a.email} is a preparer and cannot be a reviewer`);
  }
}

// ---------------- dashboard + deadlines ----------------
practice.openapi(
  def({
    method: "get",
    path: "/practice/deadlines",
    tag: "Practice",
    summary: "Deadlines across all my clients (VAT, Self Assessment, MTD ITSA), overdue first. UNVERIFIED dates.",
    query: z.object({ asOf: Day.optional(), days: z.coerce.number().int().min(1).max(366).default(60) }),
    response: z.object({
      items: z.array(
        z.object({ tenantId: z.string(), client: z.string(), id: z.string(), kind: z.string(), title: z.string(), dueDate: z.string(), daysLeft: z.number() }),
      ),
      verified: z.literal(false),
    }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const asOf = q.asOf ?? today();
    const clients = await practiceDb(c).all<ClientRow>(
      `select ${CLIENT_COLS} from practice_clients where practice_id = ?1 and tenant_id in (${clientScopeSql(c.get("practice").role)})`,
    );
    const items = clients
      .flatMap((cl) =>
        B.clientDeadlines({ vatStagger: cl.vat_stagger, mtdItsa: !!cl.mtd_itsa, saRequired: !!cl.sa_required }, asOf, q.days).map((d) => ({
          tenantId: cl.tenant_id,
          client: cl.name,
          id: d.id,
          kind: d.kind,
          title: d.title,
          dueDate: d.dueDate,
          daysLeft: d.daysLeft,
        })),
      )
      .sort((a, b) => a.daysLeft - b.daysLeft || a.client.localeCompare(b.client));
    return c.json({ items, verified: false as const }, 200);
  },
);

practice.openapi(
  def({
    method: "get",
    path: "/practice/dashboard",
    tag: "Practice",
    summary: "Practice dashboard: client health, workload, review backlog by age, deadlines, risk flags, WIP and billing-ready",
    query: z.object({ asOf: Day.optional() }),
    response: z.object({
      clients: z.object({ total: z.number(), green: z.number(), amber: z.number(), red: z.number(), worst: z.array(ClientSummary) }),
      review: z.object({ awaiting: z.number(), byAge: z.record(z.string(), z.number()), slaBreached: z.number(), qaPending: z.number() }),
      workload: z.array(
        z.object({ email: z.string(), role: z.string(), clients: z.number(), awaiting: z.number(), claimed: z.number(), openTasks: z.number() }),
      ),
      deadlines: z.object({ overdue: z.number(), next14Days: z.number() }),
      riskFlags: z.array(z.object({ tenantId: z.string(), client: z.string(), flag: z.string() })),
      wip: z.object({ totalPence: z.number(), billingReadyClients: z.number() }),
      openQueries: z.number(),
      openChecklists: z.number(),
    }),
  }),
  async (c) => {
    const asOf = c.req.valid("query").asOf ?? today();
    const pdb = practiceDb(c);
    const role = c.get("practice").role;
    const scope = clientScopeSql(role);
    const sums = await clientSummaries(pdb, role, asOf);
    const live = sums.filter((s) => s.status !== "archived");
    const slaRows = await pdb.all<{ created_at: string; sla: number }>(
      `select t.created_at, pc.review_sla_hours sla from transactions t join practice_clients pc on pc.practice_id = ?1 and pc.tenant_id = t.tenant_id
       where t.tenant_id in (${scope}) and t.reviewed_at is null`,
    );
    const ages = slaRows.map(
      (r) => (Date.parse(`${asOf}T23:59:59Z`) - Date.parse(r.created_at.replace(" ", "T") + (r.created_at.endsWith("Z") ? "" : "Z"))) / 3_600_000,
    );
    const qaPending =
      (await pdb.first<{ n: number }>(`select count(*) n from transactions t where t.tenant_id in (${scope}) and t.qa_sample = 1 and t.qa_result is null`))
        ?.n ?? 0;
    const staff = await pdb.all<{ email: string; role: PracticeRole }>("select email, role from practice_staff where practice_id = ?1 order by email");
    const assignCounts = await pdb.all<{ email: string; n: number }>(
      "select email, count(distinct tenant_id) n from client_assignments where practice_id = ?1 group by email",
    );
    const claimed = await pdb.all<{ assignee: string; n: number }>("select assignee, count(*) n from review_claims where practice_id = ?1 group by assignee");
    const tasks = await pdb.all<{ assignee: string; n: number }>(
      "select assignee, count(*) n from tasks where practice_id = ?1 and status != 'done' and assignee is not null group by assignee",
    );
    const awaitingBy = new Map(live.map((s) => [s.tenantId, s.awaitingReview]));
    const assignedAwaiting = await pdb.all<{ email: string; tenant_id: string }>(
      "select distinct email, tenant_id from client_assignments where practice_id = ?1",
    );
    const wipRows = await wipByClient(pdb, scope, asOf);
    const deadlineCounts = await (async () => {
      let overdue = 0,
        soon = 0;
      const rows = await pdb.all<ClientRow>(`select ${CLIENT_COLS} from practice_clients where practice_id = ?1 and tenant_id in (${scope})`);
      for (const cl of rows) {
        const dl = B.clientDeadlines({ vatStagger: cl.vat_stagger, mtdItsa: !!cl.mtd_itsa, saRequired: !!cl.sa_required }, asOf, 14);
        overdue += dl.filter((d) => d.daysLeft < 0).length;
        soon += dl.filter((d) => d.daysLeft >= 0).length;
      }
      return { overdue, next14Days: soon };
    })();
    const riskFlags = live.flatMap((s) => [
      ...(s.health.status === "red" ? [{ tenantId: s.tenantId, client: s.name, flag: `health red: ${s.health.reasons.join("; ")}` }] : []),
      ...(s.oldestAwaitingDays > 14 ? [{ tenantId: s.tenantId, client: s.name, flag: `review backlog ${s.oldestAwaitingDays} days old` }] : []),
      ...(s.openExceptions >= 5 ? [{ tenantId: s.tenantId, client: s.name, flag: `${s.openExceptions} open exceptions` }] : []),
    ]);
    return c.json(
      {
        clients: {
          total: live.length,
          green: live.filter((s) => s.health.status === "green").length,
          amber: live.filter((s) => s.health.status === "amber").length,
          red: live.filter((s) => s.health.status === "red").length,
          worst: [...live].sort((a, b) => a.health.score - b.health.score).slice(0, 10),
        },
        review: {
          awaiting: slaRows.length,
          byAge: B.bucketCounts(ages.map((h) => Math.floor(h / 24))),
          slaBreached: slaRows.filter((r, i) => B.slaState(ages[i]!, r.sla) === "breached").length,
          qaPending,
        },
        workload: staff.map((s) => ({
          email: s.email,
          role: s.role,
          clients: assignCounts.find((a) => a.email === s.email)?.n ?? 0,
          awaiting: assignedAwaiting.filter((a) => a.email === s.email).reduce((n, a) => n + (awaitingBy.get(a.tenant_id) ?? 0), 0),
          claimed: claimed.find((x) => x.assignee === s.email)?.n ?? 0,
          openTasks: tasks.find((x) => x.assignee === s.email)?.n ?? 0,
        })),
        deadlines: deadlineCounts,
        riskFlags,
        wip: { totalPence: wipRows.reduce((n, w) => n + w.wipPence, 0), billingReadyClients: wipRows.filter((w) => w.billingReady).length },
        openQueries: live.reduce((n, s) => n + s.openQueries, 0),
        openChecklists:
          (await pdb.first<{ n: number }>(`select count(*) n from close_checklists where practice_id = ?1 and status = 'open' and tenant_id in (${scope})`))
            ?.n ?? 0,
      },
      200,
    );
  },
);

/** WIP per client from unbilled time, fixed fees since the last billing record, and completed-but-unbilled closes. */
export async function wipByClient(pdb: PracticeDb, scope: string, asOf: string) {
  const clients = await pdb.all<ClientRow>(
    `select ${CLIENT_COLS} from practice_clients where practice_id = ?1 and tenant_id in (${scope}) and status != 'archived'`,
  );
  const time = new Map(
    (
      await pdb.all<{ tenant_id: string; m: number }>(
        `select tenant_id, sum(minutes) m from time_entries where practice_id = ?1 and billable = 1 and billing_record_id is null and tenant_id in (${scope}) group by tenant_id`,
      )
    ).map((r) => [r.tenant_id, r.m]),
  );
  const lastBill = new Map(
    (
      await pdb.all<{ tenant_id: string; kind: string; last: string }>(
        `select tenant_id, kind, max(period_end) last from billing_records where practice_id = ?1 and status != 'void' and tenant_id in (${scope}) group by tenant_id, kind`,
      )
    ).map((r) => [`${r.tenant_id}:${r.kind}`, r.last]),
  );
  const closes = await pdb.all<{ tenant_id: string; completed_at: string }>(
    `select tenant_id, completed_at from close_checklists where practice_id = ?1 and status = 'complete' and tenant_id in (${scope})`,
  );
  return clients.map((cl) => {
    const since = lastBill.get(`${cl.tenant_id}:${cl.fee_model}`) ?? cl.created_at.slice(0, 10);
    const months = Math.max(0, monthsBetween(since, asOf));
    const outcomes = closes.filter((x) => x.tenant_id === cl.tenant_id && x.completed_at.slice(0, 10) > since).length;
    const wip = B.wipPence({
      feeModel: cl.fee_model,
      feePence: cl.fee_pence,
      hourlyRatePence: cl.hourly_rate_pence,
      unbilledMinutes: time.get(cl.tenant_id) ?? 0,
      completedOutcomes: outcomes,
      monthsSinceLastBill: months,
    });
    return {
      tenantId: cl.tenant_id,
      client: cl.name,
      feeModel: cl.fee_model,
      unbilledMinutes: time.get(cl.tenant_id) ?? 0,
      outcomes,
      months,
      since,
      wipPence: wip,
      billingReady: wip > 0,
    };
  });
}
export const monthsBetween = (a: string, b: string) => {
  const [ya, ma] = a.split("-").map(Number) as [number, number];
  const [yb, mb] = b.split("-").map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
};

// ---------------- guarded bulk actions ----------------
practice.use("/practice/bulk", requirePracticeRole(...MANAGERS));
practice.openapi(
  def({
    method: "post",
    path: "/practice/bulk",
    tag: "Practice",
    summary: "Cross-client bulk action. Without confirmToken: dry-run preview + token. With the matching token: executes. Max 50 clients.",
    body: z.object({
      action: z.enum(["set_status", "assign", "create_checklist"]),
      clientIds: z.array(z.string().min(1).max(64)).min(1).max(50),
      status: z.enum(["onboarding", "active", "archived"]).optional(),
      assignment: Assignment.optional(),
      templateId: z.string().max(64).optional(),
      periodEnd: Day.optional(),
      confirmToken: z.string().max(64).optional(),
    }),
    response: z.object({
      executed: z.boolean(),
      affected: z.number(),
      skipped: z.array(z.object({ tenantId: z.string(), reason: z.string() })),
      confirmToken: z.string(),
    }),
  }),
  async (c) => {
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    const role = c.get("practice").role;
    const ids = [...new Set(b.clientIds)];
    const visible = new Set(
      (
        await pdb.all<{ tenant_id: string }>(
          `select tenant_id from practice_clients where practice_id = ?1 and tenant_id in (${clientScopeSql(role).replace("pc.status != 'archived'", "1 = 1")})`,
        )
      ).map((r) => r.tenant_id),
    );
    const skipped = ids.filter((id) => !visible.has(id)).map((tenantId) => ({ tenantId, reason: "not found" }));
    const targets = ids.filter((id) => visible.has(id));
    if (b.action === "set_status" && !b.status) throw badRequest("status is required");
    if (b.action === "assign") {
      if (!b.assignment) throw badRequest("assignment is required");
      await assertAssignable(pdb, [{ ...b.assignment, email: b.assignment.email.toLowerCase() }]);
    }
    let tpl: { id: string; name: string; kind: string; items_json: string } | null = null;
    if (b.action === "create_checklist") {
      if (!b.templateId || !b.periodEnd) throw badRequest("templateId and periodEnd are required");
      tpl = await pdb.first("select id, name, kind, items_json from close_templates where practice_id = ?1 and id = ?3", b.templateId);
      if (!tpl) throw notFound("Close template");
    }
    const paramsKey = JSON.stringify([b.status, b.assignment, b.templateId, b.periodEnd]);
    const token = B.bulkConfirmToken(`${b.action}:${paramsKey}`, targets, targets.length);
    if (!b.confirmToken) return c.json({ executed: false, affected: targets.length, skipped, confirmToken: token }, 200);
    if (b.confirmToken !== token) throw conflict("confirmToken does not match the current preview; preview again");
    const audit = new PracticeAudit(pdb);
    const stmts: D1PreparedStatement[] = [];
    for (const t of targets) {
      if (b.action === "set_status") stmts.push(pdb.stmt("update practice_clients set status = ?4 where practice_id = ?1 and tenant_id = ?3", t, b.status));
      else if (b.action === "assign")
        stmts.push(
          pdb.stmt(
            "insert or ignore into client_assignments (practice_id, tenant_id, email, role) values (?1, ?3, ?4, ?5)",
            t,
            b.assignment!.email.toLowerCase(),
            b.assignment!.role,
          ),
        );
      else stmts.push(...checklistStmts(pdb, t, tpl!, b.periodEnd!, newId()));
    }
    stmts.push(await audit.stmt(`bulk.${b.action}`, null, null, { targets, params: JSON.parse(paramsKey) }));
    try {
      await pdb.batch(stmts);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw conflict("A checklist for that period already exists for one of the clients; nothing was changed");
      throw e;
    }
    return c.json({ executed: true, affected: targets.length, skipped, confirmToken: token }, 200);
  },
);

export function checklistStmts(
  pdb: PracticeDb,
  tenantId: string,
  tpl: { id: string; name: string; kind: string; items_json: string },
  periodEnd: string,
  id: string,
) {
  const items = JSON.parse(tpl.items_json) as { title: string; required?: boolean }[];
  return [
    pdb.stmt(
      "insert into close_checklists (practice_id, id, tenant_id, template_id, name, kind, period_end, created_by) values (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?2)",
      id,
      tenantId,
      tpl.id,
      tpl.name,
      tpl.kind,
      periodEnd,
    ),
    ...items.map((it, i) =>
      pdb.stmt(
        "insert into close_items (practice_id, checklist_id, idx, title, required) values (?1, ?3, ?4, ?5, ?6)",
        id,
        i,
        it.title,
        it.required === false ? 0 : 1,
      ),
    ),
  ];
}
