/**
 * Practice co-pilot API, part 3: onboarding and engagement (ADR 0025).
 * Engagement letters (hash frozen once sent), authorisation records (64-8 style; DATA ONLY, nothing is sent to HMRC),
 * document requests, client portal invitations with a MOCK magic link (returned to staff, never emailed), per-client
 * audit export with chain verification, and working papers with immutable four-eyes sign-off.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { monotonicIso } from "../lib/audit.js";
import { conflict, notFound } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import {
  PracticeAudit,
  accessibleClient,
  clientScopeSql,
  practiceDb,
  requirePracticeRole,
  verifyAuditChain,
  type AuditRow,
  type PracticeDb,
} from "../lib/practice.js";
import { Outbox } from "../services/events.js";
import { sha256Hex } from "../services/csv.js";
import { buildSnapshot, type PaperKind } from "../services/working-papers.js";
import { issueMagicToken } from "../services/portal-tokens.js";
import { MANAGERS, SIGNERS } from "./practice.js";

type C = Context<AppEnv>;
export const onboard = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
const Id = z.string().min(1).max(64);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TAG = "Practice onboarding";
const client = async (c: C, id: string) => {
  const pdb = practiceDb(c);
  const row = await accessibleClient(pdb, c.get("practice").role, id);
  return { pdb, row };
};
interface Change {
  action: string;
  subject: string;
  meta?: unknown;
}
async function commit(pdb: PracticeDb, tenantId: string, { action, subject, meta }: Change, stmts: D1PreparedStatement[], ev?: (o: Outbox) => void) {
  const outbox = new Outbox(new TenantDb(pdb.db, tenantId));
  ev?.(outbox);
  await pdb.batch([...stmts, await new PracticeAudit(pdb).stmt(action, subject, tenantId, meta), ...outbox.stmts]);
  return outbox;
}

// ---------------- engagement letters ----------------
const Engagement = z.object({
  id: z.string(),
  tenantId: z.string(),
  services: z.array(z.string()),
  feeSummary: z.string(),
  letterSha256: z.string(),
  status: z.enum(["draft", "sent", "accepted", "withdrawn"]),
  createdBy: z.string(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  acceptedBy: z.string().nullable(),
  acceptedAt: z.string().nullable(),
});
type EngRow = {
  id: string;
  tenant_id: string;
  services_json: string;
  fee_summary: string;
  letter_sha256: string;
  status: "draft" | "sent" | "accepted" | "withdrawn";
  created_by: string;
  created_at: string;
  sent_at: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
};
export const ENG_COLS = "id, tenant_id, services_json, fee_summary, letter_sha256, status, created_by, created_at, sent_at, accepted_by, accepted_at";
export const engOut = (r: EngRow) => ({
  id: r.id,
  tenantId: r.tenant_id,
  services: JSON.parse(r.services_json) as string[],
  feeSummary: r.fee_summary,
  letterSha256: r.letter_sha256,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  sentAt: r.sent_at,
  acceptedBy: r.accepted_by,
  acceptedAt: r.accepted_at,
});
const SERVICES = ["bookkeeping", "vat_returns", "mtd_itsa", "self_assessment", "year_end_accounts", "payroll", "management_accounts", "advisory"] as const;
onboard.use("/practice/clients/:id/engagements", async (c, next) => (c.req.method === "GET" ? next() : requirePracticeRole(...MANAGERS)(c, next)));
onboard.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/engagements",
    tag: TAG,
    summary: "Draft an engagement letter (managers). The letter text is hashed; the hash is frozen once sent.",
    params: z.object({ id: Id }),
    body: z.object({
      services: z.array(z.enum(SERVICES)).min(1).max(SERVICES.length),
      feeSummary: z.string().min(1).max(500),
      letterText: z.string().min(20).max(50_000),
    }),
    response: Engagement,
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const { pdb } = await client(c, id);
    const eid = newId();
    const sha = await sha256Hex(b.letterText);
    const at = monotonicIso();
    await commit(pdb, id, { action: "engagement.drafted", subject: eid, meta: { services: b.services, sha } }, [
      pdb.stmt(
        "insert into engagements (practice_id, id, tenant_id, services_json, fee_summary, letter_text, letter_sha256, created_by, created_at) values (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?2, ?9)",
        eid,
        id,
        JSON.stringify([...new Set(b.services)]),
        b.feeSummary,
        b.letterText,
        sha,
        at,
      ),
    ]);
    const row = await pdb.first<EngRow>(`select ${ENG_COLS} from engagements where practice_id = ?1 and id = ?3`, eid);
    return c.json(engOut(row!), 201);
  },
);
onboard.openapi(
  def({
    method: "get",
    path: "/practice/clients/{id}/engagements",
    tag: TAG,
    summary: "Engagement letters for a client",
    params: z.object({ id: Id }),
    response: z.object({ items: z.array(Engagement) }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { pdb } = await client(c, id);
    const rows = await pdb.all<EngRow>(`select ${ENG_COLS} from engagements where practice_id = ?1 and tenant_id = ?3 order by created_at desc`, id);
    return c.json({ items: rows.map(engOut) }, 200);
  },
);
async function loadEngagement(c: C, id: string) {
  const pdb = practiceDb(c);
  const row = await pdb.first<EngRow>(`select ${ENG_COLS} from engagements where practice_id = ?1 and id = ?3`, id);
  if (!row) throw notFound("Engagement");
  await accessibleClient(pdb, c.get("practice").role, row.tenant_id);
  return { pdb, row };
}
onboard.use("/practice/engagements/*", requirePracticeRole(...MANAGERS));
onboard.openapi(
  def({
    method: "post",
    path: "/practice/engagements/{id}/send",
    tag: TAG,
    summary: "Mark a draft as sent: it appears in the client portal for acceptance. Nothing is emailed.",
    params: z.object({ id: Id }),
    response: Engagement,
  }),
  async (c) => {
    const { pdb, row } = await loadEngagement(c, c.req.valid("param").id);
    if (row.status !== "draft") throw conflict(`Engagement is ${row.status}`);
    await commit(pdb, row.tenant_id, { action: "engagement.sent", subject: row.id, meta: { sha: row.letter_sha256 } }, [
      pdb.stmt("update engagements set status = 'sent', sent_at = ?4 where practice_id = ?1 and id = ?3 and status = 'draft'", row.id, monotonicIso()),
    ]);
    return c.json(engOut((await pdb.first<EngRow>(`select ${ENG_COLS} from engagements where practice_id = ?1 and id = ?3`, row.id))!), 200);
  },
);
onboard.openapi(
  def({
    method: "post",
    path: "/practice/engagements/{id}/withdraw",
    tag: TAG,
    summary: "Withdraw a draft or sent letter",
    params: z.object({ id: Id }),
    response: Engagement,
  }),
  async (c) => {
    const { pdb, row } = await loadEngagement(c, c.req.valid("param").id);
    if (row.status === "accepted" || row.status === "withdrawn") throw conflict(`Engagement is ${row.status}`);
    await commit(pdb, row.tenant_id, { action: "engagement.withdrawn", subject: row.id, meta: null }, [
      pdb.stmt("update engagements set status = 'withdrawn' where practice_id = ?1 and id = ?3", row.id),
    ]);
    return c.json(engOut({ ...row, status: "withdrawn" }), 200);
  },
);

// ---------------- authorisation records (data only) ----------------
const AUTH_KINDS = ["agent_64_8", "mtd_vat", "mtd_itsa", "paye", "corporation_tax", "self_assessment"] as const;
const Authorisation = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.enum(AUTH_KINDS),
  referenceMasked: z.string().nullable(),
  status: z.enum(["requested", "confirmed", "revoked"]),
  evidenceNote: z.string().nullable(),
  recordedBy: z.string(),
  recordedAt: z.string(),
  confirmedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
type AuthRow = {
  id: string;
  tenant_id: string;
  kind: (typeof AUTH_KINDS)[number];
  reference_masked: string | null;
  status: "requested" | "confirmed" | "revoked";
  evidence_note: string | null;
  recorded_by: string;
  recorded_at: string;
  confirmed_at: string | null;
  revoked_at: string | null;
};
const AUTH_COLS = "id, tenant_id, kind, reference_masked, status, evidence_note, recorded_by, recorded_at, confirmed_at, revoked_at";
const authOut = (r: AuthRow) => ({
  id: r.id,
  tenantId: r.tenant_id,
  kind: r.kind,
  referenceMasked: r.reference_masked,
  status: r.status,
  evidenceNote: r.evidence_note,
  recordedBy: r.recorded_by,
  recordedAt: r.recorded_at,
  confirmedAt: r.confirmed_at,
  revokedAt: r.revoked_at,
});
/** Keeps only the last 3 characters of a UTR/VRN/PAYE reference; the full value is never stored. */
export const maskReference = (ref: string) => {
  const s = ref.replace(/\s+/g, "");
  return s.length <= 3 ? "***" : `${"*".repeat(Math.min(8, s.length - 3))}${s.slice(-3)}`;
};
onboard.use("/practice/clients/:id/authorisations", async (c, next) => (c.req.method === "GET" ? next() : requirePracticeRole(...MANAGERS)(c, next)));
onboard.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/authorisations",
    tag: TAG,
    summary: "Record an agent authorisation (64-8 style). DATA ONLY: no HMRC request is made. References are masked on write.",
    params: z.object({ id: Id }),
    body: z.object({
      kind: z.enum(AUTH_KINDS),
      reference: z.string().min(3).max(32).optional(),
      status: z.enum(["requested", "confirmed"]).default("requested"),
      evidenceNote: z.string().max(1000).nullable().default(null),
    }),
    response: Authorisation,
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const { pdb } = await client(c, id);
    const active = await pdb.first("select id from authorisations where practice_id = ?1 and tenant_id = ?3 and kind = ?4 and status != 'revoked'", id, b.kind);
    if (active) throw conflict("An active authorisation of this kind already exists; revoke it first");
    const aid = newId();
    const at = monotonicIso();
    await commit(pdb, id, { action: "authorisation.recorded", subject: aid, meta: { kind: b.kind, status: b.status } }, [
      pdb.stmt(
        "insert into authorisations (practice_id, id, tenant_id, kind, reference_masked, status, evidence_note, recorded_by, recorded_at, confirmed_at) values (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?2, ?9, ?10)",
        aid,
        id,
        b.kind,
        b.reference ? maskReference(b.reference) : null,
        b.status,
        b.evidenceNote,
        at,
        b.status === "confirmed" ? at : null,
      ),
    ]);
    return c.json(authOut((await pdb.first<AuthRow>(`select ${AUTH_COLS} from authorisations where practice_id = ?1 and id = ?3`, aid))!), 201);
  },
);
onboard.openapi(
  def({
    method: "get",
    path: "/practice/clients/{id}/authorisations",
    tag: TAG,
    summary: "Authorisation records for a client",
    params: z.object({ id: Id }),
    response: z.object({ items: z.array(Authorisation) }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { pdb } = await client(c, id);
    const rows = await pdb.all<AuthRow>(`select ${AUTH_COLS} from authorisations where practice_id = ?1 and tenant_id = ?3 order by recorded_at desc`, id);
    return c.json({ items: rows.map(authOut) }, 200);
  },
);
onboard.use("/practice/authorisations/*", requirePracticeRole(...MANAGERS));
onboard.openapi(
  def({
    method: "post",
    path: "/practice/authorisations/{id}/{action}",
    tag: TAG,
    summary: "Confirm or revoke an authorisation record",
    params: z.object({ id: Id, action: z.enum(["confirm", "revoke"]) }),
    response: Authorisation,
  }),
  async (c) => {
    const { id, action } = c.req.valid("param");
    const pdb = practiceDb(c);
    const row = await pdb.first<AuthRow>(`select ${AUTH_COLS} from authorisations where practice_id = ?1 and id = ?3`, id);
    if (!row) throw notFound("Authorisation");
    await accessibleClient(pdb, c.get("practice").role, row.tenant_id);
    if (row.status === "revoked" || (action === "confirm" && row.status === "confirmed")) throw conflict(`Authorisation is ${row.status}`);
    const at = monotonicIso();
    const sql =
      action === "confirm"
        ? "update authorisations set status = 'confirmed', confirmed_at = ?4 where practice_id = ?1 and id = ?3"
        : "update authorisations set status = 'revoked', revoked_at = ?4 where practice_id = ?1 and id = ?3";
    await commit(pdb, row.tenant_id, { action: `authorisation.${action === "confirm" ? "confirmed" : "revoked"}`, subject: id, meta: null }, [
      pdb.stmt(sql, id, at),
    ]);
    return c.json(authOut((await pdb.first<AuthRow>(`select ${AUTH_COLS} from authorisations where practice_id = ?1 and id = ?3`, id))!), 200);
  },
);

// ---------------- document requests ----------------
const DOC_TEMPLATES: Record<string, string[]> = {
  year_end: [
    "Bank statements for the full year",
    "Sales invoices issued",
    "Purchase invoices and receipts",
    "Loan and finance agreements",
    "Asset purchases over £1,000",
  ],
  vat_quarter: ["Bank statements for the quarter", "Sales invoices issued in the quarter", "Purchase invoices with VAT"],
  onboarding: ["Photo ID for each director/owner", "Proof of address", "Previous accountant's final accounts", "HMRC references (UTR/VRN)"],
};
const DocRequest = z.object({
  id: z.string(),
  tenantId: z.string(),
  title: z.string(),
  dueDate: z.string().nullable(),
  status: z.enum(["open", "fulfilled", "waived"]),
  contentType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  sha256: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  fulfilledBy: z.string().nullable(),
  fulfilledAt: z.string().nullable(),
  overdue: z.boolean(),
});
type DocRow = {
  id: string;
  tenant_id: string;
  title: string;
  due_date: string | null;
  status: "open" | "fulfilled" | "waived";
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  created_by: string;
  created_at: string;
  fulfilled_by: string | null;
  fulfilled_at: string | null;
};
export const DOC_COLS = "id, tenant_id, title, due_date, status, content_type, size_bytes, sha256, created_by, created_at, fulfilled_by, fulfilled_at";
export const docOut = (r: DocRow, asOf = new Date().toISOString().slice(0, 10)) => ({
  id: r.id,
  tenantId: r.tenant_id,
  title: r.title,
  dueDate: r.due_date,
  status: r.status,
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  createdBy: r.created_by,
  createdAt: r.created_at,
  fulfilledBy: r.fulfilled_by,
  fulfilledAt: r.fulfilled_at,
  overdue: r.status === "open" && !!r.due_date && r.due_date < asOf,
});
onboard.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/document-requests",
    tag: TAG,
    summary: "Request documents from a client (explicit titles and/or a template). Shown in the portal; nothing is emailed.",
    params: z.object({ id: Id }),
    body: z
      .object({
        titles: z.array(z.string().min(2).max(200)).max(50).default([]),
        template: z.enum(["year_end", "vat_quarter", "onboarding"]).optional(),
        dueDate: Day.optional(),
      })
      .refine((b) => b.titles.length || b.template, "titles or template is required"),
    response: z.object({ created: z.number(), skippedDuplicates: z.number() }),
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const { pdb } = await client(c, id);
    const wanted = [...new Set([...(b.template ? DOC_TEMPLATES[b.template]! : []), ...b.titles.map((t) => t.trim())])];
    const open = new Set(
      (await pdb.all<{ title: string }>("select title from document_requests where practice_id = ?1 and tenant_id = ?3 and status = 'open'", id)).map(
        (r) => r.title,
      ),
    );
    const fresh = wanted.filter((t) => !open.has(t));
    const at = monotonicIso();
    if (fresh.length)
      await commit(
        pdb,
        id,
        { action: "document_request.created", subject: id, meta: { count: fresh.length, template: b.template ?? null } },
        fresh.map((t) =>
          pdb.stmt(
            "insert into document_requests (practice_id, id, tenant_id, title, due_date, created_by, created_at) values (?1, ?3, ?4, ?5, ?6, ?2, ?7)",
            newId(),
            id,
            t,
            b.dueDate ?? null,
            at,
          ),
        ),
      );
    return c.json({ created: fresh.length, skippedDuplicates: wanted.length - fresh.length }, 201);
  },
);
onboard.openapi(
  def({
    method: "get",
    path: "/practice/document-requests",
    tag: TAG,
    summary: "Document requests across my clients (the upload checklist)",
    query: z.object({ clientId: Id.optional(), status: z.enum(["open", "fulfilled", "waived"]).optional(), asOf: Day.optional() }),
    response: z.object({ items: z.array(DocRequest), open: z.number(), overdue: z.number() }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const pdb = practiceDb(c);
    const args: unknown[] = [];
    let f = "";
    if (q.clientId) {
      args.push(q.clientId);
      f += ` and tenant_id = ?${args.length + 2}`;
    }
    if (q.status) {
      args.push(q.status);
      f += ` and status = ?${args.length + 2}`;
    }
    const rows = await pdb.all<DocRow>(
      `select ${DOC_COLS} from document_requests where practice_id = ?1 and tenant_id in (${clientScopeSql(c.get("practice").role)})${f} order by coalesce(due_date, '9999'), created_at limit 2000`,
      ...args,
    );
    const items = rows.map((r) => docOut(r, q.asOf));
    return c.json({ items, open: items.filter((i) => i.status === "open").length, overdue: items.filter((i) => i.overdue).length }, 200);
  },
);
onboard.openapi(
  def({
    method: "post",
    path: "/practice/document-requests/{id}/waive",
    tag: TAG,
    summary: "Waive an open document request",
    params: z.object({ id: Id }),
    response: DocRequest,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const pdb = practiceDb(c);
    const row = await pdb.first<DocRow>(`select ${DOC_COLS} from document_requests where practice_id = ?1 and id = ?3`, id);
    if (!row) throw notFound("Document request");
    await accessibleClient(pdb, c.get("practice").role, row.tenant_id);
    if (row.status !== "open") throw conflict(`Request is ${row.status}`);
    await commit(pdb, row.tenant_id, { action: "document_request.waived", subject: id, meta: null }, [
      pdb.stmt("update document_requests set status = 'waived' where practice_id = ?1 and id = ?3", id),
    ]);
    return c.json(docOut({ ...row, status: "waived" }), 200);
  },
);

// ---------------- portal users (mock magic link) ----------------
const PortalUser = z.object({ id: z.string(), tenantId: z.string(), email: z.string(), status: z.enum(["active", "revoked"]), createdAt: z.string() });
onboard.use("/practice/clients/:id/portal-users", async (c, next) => (c.req.method === "GET" ? next() : requirePracticeRole(...MANAGERS)(c, next)));
onboard.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/portal-users",
    tag: TAG,
    summary:
      "Invite a client contact to the portal. MOCK delivery: the single-use magic token (15 min) is returned here for staff to hand over; Autopilot never emails it.",
    params: z.object({ id: Id }),
    body: z.object({ email: z.string().email().max(200) }),
    response: z.object({ portalUser: PortalUser, magicToken: z.string(), expiresAt: z.string(), delivery: z.literal("mock_returned_to_staff") }),
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const email = c.req.valid("json").email.toLowerCase();
    const { pdb } = await client(c, id);
    let user = await pdb.first<{ id: string; status: string; created_at: string }>(
      "select id, status, created_at from portal_users where practice_id = ?1 and tenant_id = ?3 and email = ?4",
      id,
      email,
    );
    const stmts: D1PreparedStatement[] = [];
    if (!user) {
      user = { id: newId(), status: "active", created_at: monotonicIso() };
      stmts.push(
        pdb.stmt(
          "insert into portal_users (practice_id, id, tenant_id, email, created_by, created_at) values (?1, ?3, ?4, ?5, ?2, ?6)",
          user.id,
          id,
          email,
          user.created_at,
        ),
      );
    } else if (user.status === "revoked") {
      stmts.push(pdb.stmt("update portal_users set status = 'active' where practice_id = ?1 and id = ?3", user.id));
    }
    const magic = await issueMagicToken(c.env.DB, user.id);
    const outbox = await commit(pdb, id, { action: "portal.invited", subject: user.id, meta: { email } }, [...stmts, magic.stmt], (o) =>
      o.add("portal.invited", { portalUserId: user!.id, email }, pdb.email),
    );
    await outbox.publish(c.env);
    return c.json(
      {
        portalUser: { id: user.id, tenantId: id, email, status: "active" as const, createdAt: user.created_at },
        magicToken: magic.token,
        expiresAt: magic.expiresAt,
        delivery: "mock_returned_to_staff" as const,
      },
      201,
    );
  },
);
onboard.openapi(
  def({
    method: "get",
    path: "/practice/clients/{id}/portal-users",
    tag: TAG,
    summary: "Portal users for a client",
    params: z.object({ id: Id }),
    response: z.object({ items: z.array(PortalUser) }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { pdb } = await client(c, id);
    const rows = await pdb.all<{ id: string; tenant_id: string; email: string; status: "active" | "revoked"; created_at: string }>(
      "select id, tenant_id, email, status, created_at from portal_users where practice_id = ?1 and tenant_id = ?3 order by email",
      id,
    );
    return c.json({ items: rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, email: r.email, status: r.status, createdAt: r.created_at })) }, 200);
  },
);
onboard.use("/practice/portal-users/*", requirePracticeRole(...MANAGERS));
onboard.openapi(
  def({
    method: "post",
    path: "/practice/portal-users/{id}/revoke",
    tag: TAG,
    summary: "Revoke a portal user and every token they hold",
    params: z.object({ id: Id }),
    response: z.object({ revoked: z.boolean() }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const pdb = practiceDb(c);
    const u = await pdb.first<{ tenant_id: string }>("select tenant_id from portal_users where practice_id = ?1 and id = ?3", id);
    if (!u) throw notFound("Portal user");
    await accessibleClient(pdb, c.get("practice").role, u.tenant_id);
    await commit(pdb, u.tenant_id, { action: "portal.revoked", subject: id, meta: null }, [
      pdb.stmt("update portal_users set status = 'revoked' where practice_id = ?1 and id = ?3", id),
      // Tokens carry no practice_id; scope the delete through the practice-owned user row.
      pdb.stmt(
        "update portal_tokens set used_at = coalesce(used_at, ?4) where portal_user_id in (select id from portal_users where practice_id = ?1 and id = ?3)",
        id,
        monotonicIso(),
      ),
    ]);
    return c.json({ revoked: true }, 200);
  },
);

// ---------------- audit export + verification ----------------
onboard.use("/practice/clients/:id/audit-export", requirePracticeRole(...MANAGERS));
onboard.openapi(
  def({
    method: "get",
    path: "/practice/clients/{id}/audit-export",
    tag: TAG,
    summary: "Per-client audit trail (practice chain entries + the client's own audit log) with whole-chain verification",
    params: z.object({ id: Id }),
    query: z.object({ format: z.enum(["json", "csv"]).default("json") }),
    response: z.object({
      tenantId: z.string(),
      client: z.string(),
      generatedAt: z.string(),
      chain: z.object({ ok: z.boolean(), entries: z.number(), brokenAt: z.number().nullable(), headHash: z.string() }),
      practiceEntries: z.array(
        z.object({ seq: z.number(), actor: z.string(), action: z.string(), subject: z.string().nullable(), createdAt: z.string(), hash: z.string() }),
      ),
      clientEntries: z.array(z.object({ actor: z.string(), action: z.string(), subject: z.string().nullable(), createdAt: z.string() })),
    }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { format } = c.req.valid("query");
    const { pdb, row } = await client(c, id);
    const all = await pdb.all<AuditRow>(
      "select seq, id, tenant_id, actor, action, subject, meta_json, created_at, prev_hash, hash from practice_audit where practice_id = ?1 order by seq",
    );
    const chain = await verifyAuditChain(all);
    const mine = all
      .filter((r) => r.tenant_id === id)
      .map((r) => ({ seq: r.seq, actor: r.actor, action: r.action, subject: r.subject, createdAt: r.created_at, hash: r.hash }));
    const tdb = new TenantDb(c.env.DB, id);
    const own = (
      await tdb.all<{ actor: string; action: string; subject: string | null; created_at: string }>(
        "select actor, action, subject, created_at from audit_log where tenant_id = ?1 order by created_at, id limit 10000",
      )
    ).map((r) => ({ actor: r.actor, action: r.action, subject: r.subject, createdAt: r.created_at }));
    await pdb.batch([await new PracticeAudit(pdb).stmt("audit.exported", id, id, { format, entries: mine.length + own.length })]);
    const generatedAt = new Date().toISOString();
    if (format === "csv") {
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const lines = [
        "source,seq,created_at,actor,action,subject,hash",
        ...mine.map((e) => ["practice", e.seq, e.createdAt, e.actor, e.action, e.subject, e.hash].map(esc).join(",")),
        ...own.map((e) => ["client", "", e.createdAt, e.actor, e.action, e.subject, ""].map(esc).join(",")),
      ];
      return c.body(`${lines.join("\n")}\n`, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${id}.csv"`,
        "x-audit-chain-ok": String(chain.ok),
        "x-audit-chain-head": chain.headHash,
      }) as never;
    }
    return c.json({ tenantId: id, client: row.name, generatedAt, chain, practiceEntries: mine, clientEntries: own }, 200);
  },
);
onboard.use("/practice/audit/verify", requirePracticeRole("partner"));
onboard.openapi(
  def({
    method: "get",
    path: "/practice/audit/verify",
    tag: TAG,
    summary: "Recompute the practice's hash chain (partners)",
    response: z.object({ ok: z.boolean(), entries: z.number(), brokenAt: z.number().nullable(), headHash: z.string() }),
  }),
  async (c) => {
    const rows = await practiceDb(c).all<AuditRow>(
      "select seq, id, tenant_id, actor, action, subject, meta_json, created_at, prev_hash, hash from practice_audit where practice_id = ?1 order by seq",
    );
    return c.json(await verifyAuditChain(rows), 200);
  },
);

// ---------------- working papers ----------------
const WorkingPaper = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.enum(["trial_balance", "bank_reconciliation", "vat_reconciliation"]),
  periodEnd: z.string(),
  status: z.enum(["prepared", "signed_off"]),
  snapshot: z.record(z.string(), z.unknown()),
  snapshotSha256: z.string(),
  integrityOk: z.boolean(),
  changedSinceSnapshot: z.boolean(),
  preparedBy: z.string(),
  preparedAt: z.string(),
  signedBy: z.string().nullable(),
  signedAt: z.string().nullable(),
  signNote: z.string().nullable(),
});
type WpRow = {
  id: string;
  tenant_id: string;
  kind: PaperKind;
  period_end: string;
  status: "prepared" | "signed_off";
  snapshot_json: string;
  snapshot_sha256: string;
  prepared_by: string;
  prepared_at: string;
  signed_by: string | null;
  signed_at: string | null;
  sign_note: string | null;
};
const WP_COLS = "id, tenant_id, kind, period_end, status, snapshot_json, snapshot_sha256, prepared_by, prepared_at, signed_by, signed_at, sign_note";
async function wpOut(c: C, r: WpRow) {
  const live = await buildSnapshot(new TenantDb(c.env.DB, r.tenant_id), r.kind, r.period_end);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    periodEnd: r.period_end,
    status: r.status,
    snapshot: JSON.parse(r.snapshot_json) as Record<string, unknown>,
    snapshotSha256: r.snapshot_sha256,
    integrityOk: (await sha256Hex(r.snapshot_json)) === r.snapshot_sha256,
    changedSinceSnapshot: live.sha256 !== r.snapshot_sha256,
    preparedBy: r.prepared_by,
    preparedAt: r.prepared_at,
    signedBy: r.signed_by,
    signedAt: r.signed_at,
    signNote: r.sign_note,
  };
}
onboard.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/working-papers",
    tag: TAG,
    summary: "Prepare a working paper: an immutable, hashed snapshot of the client ledger at a period end",
    params: z.object({ id: Id }),
    body: z.object({ kind: z.enum(["trial_balance", "bank_reconciliation", "vat_reconciliation"]), periodEnd: Day }),
    response: WorkingPaper,
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const { pdb } = await client(c, id);
    const snap = await buildSnapshot(new TenantDb(c.env.DB, id), b.kind, b.periodEnd);
    const wid = newId();
    await commit(pdb, id, { action: "working_paper.prepared", subject: wid, meta: { kind: b.kind, periodEnd: b.periodEnd, sha: snap.sha256 } }, [
      pdb.stmt(
        "insert into working_papers (practice_id, id, tenant_id, kind, period_end, snapshot_json, snapshot_sha256, prepared_by, prepared_at) values (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?2, ?9)",
        wid,
        id,
        b.kind,
        b.periodEnd,
        snap.json,
        snap.sha256,
        monotonicIso(),
      ),
    ]);
    return c.json(await wpOut(c, (await pdb.first<WpRow>(`select ${WP_COLS} from working_papers where practice_id = ?1 and id = ?3`, wid))!), 201);
  },
);
onboard.openapi(
  def({
    method: "get",
    path: "/practice/clients/{id}/working-papers",
    tag: TAG,
    summary: "Working papers for a client",
    params: z.object({ id: Id }),
    response: z.object({ items: z.array(WorkingPaper) }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { pdb } = await client(c, id);
    const rows = await pdb.all<WpRow>(
      `select ${WP_COLS} from working_papers where practice_id = ?1 and tenant_id = ?3 order by period_end desc, prepared_at desc limit 200`,
      id,
    );
    const items = [];
    for (const r of rows) items.push(await wpOut(c, r));
    return c.json({ items }, 200);
  },
);
async function loadPaper(c: C, id: string) {
  const pdb = practiceDb(c);
  const row = await pdb.first<WpRow>(`select ${WP_COLS} from working_papers where practice_id = ?1 and id = ?3`, id);
  if (!row) throw notFound("Working paper");
  await accessibleClient(pdb, c.get("practice").role, row.tenant_id);
  return { pdb, row };
}
onboard.openapi(
  def({
    method: "get",
    path: "/practice/working-papers/{id}",
    tag: TAG,
    summary: "One working paper with integrity check",
    params: z.object({ id: Id }),
    response: WorkingPaper,
  }),
  async (c) => {
    const { row } = await loadPaper(c, c.req.valid("param").id);
    return c.json(await wpOut(c, row), 200);
  },
);
onboard.use("/practice/working-papers/:id/sign-off", requirePracticeRole(...SIGNERS));
onboard.openapi(
  def({
    method: "post",
    path: "/practice/working-papers/{id}/sign-off",
    tag: TAG,
    summary: "Four-eyes sign-off (reviewer/manager/partner, never the preparer). Refused if the ledger changed since the snapshot. Immutable after.",
    params: z.object({ id: Id }),
    body: z.object({ note: z.string().max(1000).nullable().default(null) }),
    response: WorkingPaper,
  }),
  async (c) => {
    const { pdb, row } = await loadPaper(c, c.req.valid("param").id);
    const note = c.req.valid("json").note;
    if (row.status === "signed_off") throw conflict("Already signed off");
    if (row.prepared_by === pdb.email) throw conflict("Four-eyes: the preparer cannot sign off their own working paper");
    const current = await wpOut(c, row);
    if (!current.integrityOk) throw conflict("Snapshot integrity check failed");
    if (current.changedSinceSnapshot) throw conflict("The ledger changed since this snapshot; prepare a new working paper");
    const at = monotonicIso();
    const outbox = await commit(
      pdb,
      row.tenant_id,
      { action: "working_paper.signed_off", subject: row.id, meta: { sha: row.snapshot_sha256 } },
      [
        pdb.stmt(
          "update working_papers set status = 'signed_off', signed_by = ?2, signed_at = ?4, sign_note = ?5 where practice_id = ?1 and id = ?3 and status = 'prepared'",
          row.id,
          at,
          note,
        ),
      ],
      (o) =>
        o.add("working_paper.signed_off", { workingPaperId: row.id, periodEnd: row.period_end, snapshotSha256: row.snapshot_sha256, by: pdb.email }, pdb.email),
    );
    await outbox.publish(c.env);
    return c.json({ ...current, status: "signed_off" as const, signedBy: pdb.email, signedAt: at, signNote: note }, 200);
  },
);
