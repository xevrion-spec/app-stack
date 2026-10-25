/**
 * UK GDPR tools (owner only): subject access export (DSAR), erasure with statutory-retention holds, consent log, tenant data
 * export (portability) and the retention policy. Retention periods are UNVERIFIED placeholders; check with an adviser.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireRole } from "../lib/auth.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { conflict } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import { sha256Hex } from "../services/csv.js";

type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const me = (c: C) => c.get("principal").email;
export const privacy = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
privacy.use("/privacy/*", requireRole("owner"));

const RETENTION_POLICY = {
  verified: false,
  notice: "Placeholder retention periods. Confirm with an adviser before relying on them.",
  rules: [
    {
      data: "Accounting records (transactions, journals, invoices, credit notes, VAT, receipts)",
      keep: "at least 5 years after the 31 January Self Assessment deadline (6 years for VAT records)",
      erasure: "retained under legal obligation; contact details minimised",
    },
    { data: "Audit log", keep: "same as accounting records", erasure: "retained (security and legal obligation)" },
    { data: "Team membership, comments, notifications, preferences", keep: "while the account is active", erasure: "deleted or pseudonymised on request" },
    { data: "Consent records", keep: "as long as needed to prove consent", erasure: "subject pseudonymised (hash), record kept" },
  ],
};
privacy.openapi(
  def({
    method: "get",
    path: "/privacy/retention",
    tag: "Privacy",
    summary: "Data retention policy (UNVERIFIED placeholders)",
    response: z.record(z.string(), z.unknown()),
  }),
  (c) => c.json(RETENTION_POLICY as Record<string, unknown>, 200),
);

const Subject = z.object({ email: z.string().email() });
async function subjectData(db: TenantDb, email: string) {
  const e = email.toLowerCase();
  return {
    users: await db.all("select id, email, role, display_name, created_at from users where tenant_id = ?1 and lower(email) = ?2", e),
    invoices: await db.all(
      "select id, number, customer_name, customer_email, issue_date, gross_pence from invoices where tenant_id = ?1 and lower(customer_email) = ?2",
      e,
    ),
    comments: await db.all("select id, subject_type, subject_id, body, created_at from comments where tenant_id = ?1 and lower(author) = ?2", e),
    notifications: await db.all("select id, kind, title, created_at, read_at from notifications where tenant_id = ?1 and user_email = ?2", e),
    consents: await db.all("select id, purpose, granted, source, created_at from consents where tenant_id = ?1 and lower(subject) = ?2", e),
    auditEntries: (await db.first<{ n: number }>("select count(*) n from audit_log where tenant_id = ?1 and lower(actor) = ?2", e))?.n ?? 0,
  };
}
privacy.openapi(
  def({
    method: "post",
    path: "/privacy/dsar",
    tag: "Privacy",
    summary: "Subject access request: everything held about an email in this tenant",
    body: Subject,
    response: z.record(z.string(), z.unknown()),
  }),
  async (c) => {
    const db = scope(c);
    const email = c.req.valid("json").email;
    const data = await subjectData(db, email);
    const id = newId();
    await db.batch([
      db.stmt(
        "insert into privacy_requests (tenant_id, id, kind, subject, status, result_json, requested_by) values (?1, ?2, 'export', ?3, 'completed', ?4, ?5)",
        id,
        await sha256Hex(email.toLowerCase()),
        JSON.stringify({ counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])) }),
        me(c),
      ),
      auditStmt(db, me(c), "privacy.dsar", id),
    ]);
    return c.json({ requestId: id, subject: email, generatedAt: new Date().toISOString(), data, retention: RETENTION_POLICY }, 200);
  },
);
privacy.openapi(
  def({
    method: "post",
    path: "/privacy/erasure",
    tag: "Privacy",
    summary: "Erase or pseudonymise a person's data; accounting records are retained (legal obligation) and reported",
    body: Subject.extend({ confirm: z.literal(true) }),
    response: z.record(z.string(), z.unknown()),
  }),
  async (c) => {
    const db = scope(c);
    const e = c.req.valid("json").email.toLowerCase();
    const owners = await db.all<{ email: string }>("select email from users where tenant_id = ?1 and role = 'owner'");
    if (owners.some((o) => o.email.toLowerCase() === e))
      throw conflict("Owners cannot be erased while they own the account; transfer ownership or close the account first");
    const hash = await sha256Hex(e);
    const pseudo = `erased:${hash.slice(0, 12)}`;
    const before = await subjectData(db, e);
    const id = newId();
    await db.batch([
      db.stmt("delete from users where tenant_id = ?1 and lower(email) = ?2 and role != 'owner'", e),
      db.stmt("update invoices set customer_email = null where tenant_id = ?1 and lower(customer_email) = ?2", e),
      db.stmt("update comments set author = ?3 where tenant_id = ?1 and lower(author) = ?2", e, pseudo),
      db.stmt("update comments set body = replace(body, ?2, ?3) where tenant_id = ?1 and instr(lower(body), ?2) > 0", e, pseudo),
      db.stmt("delete from notifications where tenant_id = ?1 and user_email = ?2", e),
      db.stmt("delete from notification_prefs where tenant_id = ?1 and user_email = ?2", e),
      db.stmt("update consents set subject = ?3 where tenant_id = ?1 and lower(subject) = ?2", e, pseudo),
      db.stmt(
        "insert into privacy_requests (tenant_id, id, kind, subject, status, result_json, requested_by) values (?1, ?2, 'erasure', ?3, 'completed', ?4, ?5)",
        id,
        hash,
        JSON.stringify({ users: before.users.length, invoicesMinimised: before.invoices.length, comments: before.comments.length }),
        me(c),
      ),
      auditStmt(db, me(c), "privacy.erasure", id, { pseudonym: pseudo }),
    ]);
    return c.json(
      {
        requestId: id,
        pseudonym: pseudo,
        erased: { memberships: before.users.length, notifications: before.notifications.length },
        pseudonymised: { comments: before.comments.length, consents: before.consents.length },
        minimised: { invoiceEmails: before.invoices.length },
        retained: [
          { data: "invoices (names, amounts)", count: before.invoices.length, reason: "statutory accounting records" },
          { data: "audit log entries", count: before.auditEntries, reason: "security and legal obligation" },
        ],
      },
      200,
    );
  },
);

const Consent = z
  .object({ id: z.string(), subject: z.string(), purpose: z.string(), granted: z.number(), source: z.string().nullable(), created_at: z.string() })
  .openapi("Consent");
privacy.openapi(
  def({
    method: "post",
    path: "/privacy/consents",
    tag: "Privacy",
    summary: "Record a consent grant or withdrawal (append-only log)",
    body: z.object({
      subject: z.string().email(),
      purpose: z.enum(["marketing_email", "product_updates", "analytics", "accountant_access", "open_banking"]),
      granted: z.boolean(),
      source: z.string().max(100).optional(),
    }),
    response: Consent,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    const id = newId();
    await db.batch([
      db.stmt(
        "insert into consents (tenant_id, id, subject, purpose, granted, source, recorded_by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        id,
        b.subject.toLowerCase(),
        b.purpose,
        b.granted ? 1 : 0,
        b.source ?? null,
        me(c),
      ),
      auditStmt(db, me(c), b.granted ? "consent.granted" : "consent.withdrawn", id, { purpose: b.purpose }),
    ]);
    return c.json(
      (await db.first<z.infer<typeof Consent>>("select id, subject, purpose, granted, source, created_at from consents where tenant_id = ?1 and id = ?2", id))!,
      201,
    );
  },
);
privacy.openapi(
  def({
    method: "get",
    path: "/privacy/consents",
    tag: "Privacy",
    summary: "Current consent state per subject and purpose (latest record wins) plus history",
    query: z.object({ subject: z.string().email().optional() }),
    response: z.object({ current: z.array(z.record(z.string(), z.unknown())), history: z.array(Consent) }),
  }),
  async (c) => {
    const s = c.req.valid("query").subject?.toLowerCase();
    const history = await scope(c).all<z.infer<typeof Consent>>(
      `select id, subject, purpose, granted, source, created_at from consents where tenant_id = ?1${s ? " and subject = ?2" : ""} order by created_at, id`,
      ...(s ? [s] : []),
    );
    const latest = new Map<string, z.infer<typeof Consent>>();
    for (const h of history) latest.set(`${h.subject}|${h.purpose}`, h);
    return c.json(
      { current: [...latest.values()].map((h) => ({ subject: h.subject, purpose: h.purpose, granted: !!h.granted, since: h.created_at })), history },
      200,
    );
  },
);

const EXPORT_TABLES = [
  "users",
  "transactions",
  "journals",
  "journal_lines",
  "categories",
  "category_rules",
  "invoices",
  "invoice_payments",
  "credit_notes",
  "recurring_invoices",
  "documents",
  "exceptions",
  "vat_returns",
  "mileage_trips",
  "comments",
  "period_closes",
  "consents",
  "mtd_submissions",
] as const;
privacy.openapi(
  def({
    method: "get",
    path: "/privacy/export",
    tag: "Privacy",
    summary: "Full tenant data export (portability), JSON; document files are referenced by key",
    response: z.record(z.string(), z.unknown()),
  }),
  async (c) => {
    const db = scope(c);
    const out: Record<string, unknown[]> = {};
    for (const t of EXPORT_TABLES) out[t] = await db.all(`select * from ${t} where tenant_id = ?1 limit 100000`);
    await db.batch([auditStmt(db, me(c), "privacy.tenant_export", db.tenantId, { tables: EXPORT_TABLES.length })]);
    return c.json({ exportedAt: new Date().toISOString(), format: "autopilot-export/v1", tables: out }, 200);
  },
);
