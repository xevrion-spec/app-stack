/**
 * Client portal API (ADR 0025). A client contact authenticates with a portal session (exchanged from a MOCK magic
 * token that staff hand over; nothing is emailed) and can only ever see their own business at their own practice:
 * open queries (answer), document requests (upload), engagement letters (accept by hash).
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { monotonicIso } from "../lib/audit.js";
import { badRequest, conflict, notFound, tooLarge, unauthenticated, unsupported } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import { PracticeAudit, PracticeDb } from "../lib/practice.js";
import { rateLimit } from "../lib/ratelimit.js";
import { Outbox } from "../services/events.js";
import { sha256Hex } from "../services/csv.js";
import { MAX_RECEIPT, RECEIPT_TYPES, scanHook } from "../services/scan.js";
import { endSession, exchangeMagic, lookupSession } from "../services/portal-tokens.js";
import { DOC_COLS, ENG_COLS, docOut, engOut } from "./practice-onboard.js";

type C = Context<AppEnv>;
export const portal = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
const Id = z.string().min(1).max(64);
const TAG = "Client portal";
const bearer = (c: C) => {
  const h = c.req.header("authorization") ?? "";
  return h.startsWith("Bearer ps_") ? h.slice(7) : null;
};

/** Portal session auth. Staff identities, dev headers and API keys are never accepted here. */
const portalPrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw unauthenticated("Portal session required");
  const s = await lookupSession(c.env.DB, token);
  if (!s) throw unauthenticated("Invalid or expired portal session");
  c.set("portal", { portalUserId: s.portal_user_id, practiceId: s.practice_id, tenantId: s.tenant_id, email: s.email });
  return next();
};
for (const p of [
  "/portal/me",
  "/portal/queries",
  "/portal/queries/*",
  "/portal/document-requests",
  "/portal/document-requests/*",
  "/portal/engagements",
  "/portal/engagements/*",
  "/portal/logout",
])
  portal.use(p, portalPrincipal, rateLimit);
const ctx = (c: C) => {
  const p = c.get("portal");
  return { p, pdb: new PracticeDb(c.env.DB, p.practiceId, `portal:${p.email}`), tdb: new TenantDb(c.env.DB, p.tenantId) };
};
async function commit(c: C, action: string, subject: string, stmts: D1PreparedStatement[], ev?: (o: Outbox) => void) {
  const { p, pdb, tdb } = ctx(c);
  const outbox = new Outbox(tdb);
  ev?.(outbox);
  await pdb.batch([...stmts, await new PracticeAudit(pdb).stmt(action, subject, p.tenantId), ...outbox.stmts]);
  await outbox.publish(c.env);
}

portal.openapi(
  def({
    method: "post",
    path: "/portal/session",
    tag: TAG,
    summary: "Exchange a single-use magic token for an 8-hour portal session (mock magic-link flow; no email)",
    body: z.object({ token: z.string().min(10).max(100) }),
    response: z.object({ sessionToken: z.string(), expiresAt: z.string() }),
  }),
  async (c) => {
    const r = await exchangeMagic(c.env.DB, c.req.valid("json").token);
    if (!r) throw unauthenticated("Invalid, used or expired magic link");
    const pdb = new PracticeDb(c.env.DB, r.practice_id, `portal:${r.email}`);
    await pdb.batch([await new PracticeAudit(pdb).stmt("portal.signed_in", r.portal_user_id, r.tenant_id)]);
    return c.json({ sessionToken: r.sessionToken, expiresAt: r.expiresAt }, 200);
  },
);
portal.openapi(
  def({ method: "post", path: "/portal/logout", tag: TAG, summary: "End this portal session", response: z.object({ ok: z.boolean() }) }),
  async (c) => {
    await endSession(c.env.DB, bearer(c)!);
    return c.json({ ok: true }, 200);
  },
);
portal.openapi(
  def({
    method: "get",
    path: "/portal/me",
    tag: TAG,
    summary: "Who I am, my business and my practice, with counts of things waiting for me",
    response: z.object({
      email: z.string(),
      tenantId: z.string(),
      business: z.string(),
      practice: z.string(),
      openQueries: z.number(),
      openDocumentRequests: z.number(),
      engagementsAwaitingAcceptance: z.number(),
    }),
  }),
  async (c) => {
    const { p, pdb } = ctx(c);
    const r = await pdb.first<{ business: string; practice: string; q: number; d: number; e: number }>(
      `select pc.name business, (select name from practices where id = ?1) practice,
        (select count(*) from client_queries where practice_id = ?1 and tenant_id = ?3 and status = 'open') q,
        (select count(*) from document_requests where practice_id = ?1 and tenant_id = ?3 and status = 'open') d,
        (select count(*) from engagements where practice_id = ?1 and tenant_id = ?3 and status = 'sent') e
       from practice_clients pc where pc.practice_id = ?1 and pc.tenant_id = ?3`,
      p.tenantId,
    );
    if (!r) throw notFound("Business");
    return c.json(
      {
        email: p.email,
        tenantId: p.tenantId,
        business: r.business,
        practice: r.practice,
        openQueries: r.q,
        openDocumentRequests: r.d,
        engagementsAwaitingAcceptance: r.e,
      },
      200,
    );
  },
);

const PortalQuery = z.object({
  id: z.string(),
  question: z.string(),
  transaction: z.object({ id: z.string(), date: z.string(), description: z.string().nullable(), amountPence: z.number() }).nullable(),
  status: z.enum(["open", "answered", "closed"]),
  askedAt: z.string(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
});
portal.openapi(
  def({ method: "get", path: "/portal/queries", tag: TAG, summary: "Questions from my accountant", response: z.object({ items: z.array(PortalQuery) }) }),
  async (c) => {
    const { p, pdb } = ctx(c);
    const rows = await pdb.all<{
      id: string;
      question: string;
      transaction_id: string | null;
      status: "open" | "answered" | "closed";
      asked_at: string;
      answer: string | null;
      answered_at: string | null;
      txn_date: string | null;
      description: string | null;
      amount_pence: number | null;
    }>(
      "select q.id, q.question, q.transaction_id, q.status, q.asked_at, q.answer, q.answered_at, t.txn_date, t.description, t.amount_pence from client_queries q left join transactions t on t.id = q.transaction_id and t.tenant_id = q.tenant_id where q.practice_id = ?1 and q.tenant_id = ?3 order by q.status = 'open' desc, q.asked_at desc limit 500",
      p.tenantId,
    );
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          question: r.question,
          transaction:
            r.transaction_id && r.txn_date ? { id: r.transaction_id, date: r.txn_date, description: r.description, amountPence: r.amount_pence ?? 0 } : null,
          status: r.status,
          askedAt: r.asked_at,
          answer: r.answer,
          answeredAt: r.answered_at,
        })),
      },
      200,
    );
  },
);
portal.openapi(
  def({
    method: "post",
    path: "/portal/queries/{id}/answer",
    tag: TAG,
    summary: "Answer an open query (emits query.answered; the practice sees it in its queue)",
    params: z.object({ id: Id }),
    body: z.object({ answer: z.string().min(1).max(4000) }),
    response: z.object({ id: z.string(), status: z.literal("answered") }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { p, pdb } = ctx(c);
    const q = await pdb.first<{ status: string }>("select status from client_queries where practice_id = ?1 and tenant_id = ?3 and id = ?4", p.tenantId, id);
    if (!q) throw notFound("Query");
    if (q.status !== "open") throw conflict(`Query is ${q.status}`);
    await commit(
      c,
      "query.answered",
      id,
      [
        pdb.stmt(
          "update client_queries set status = 'answered', answer = ?5, answered_by = ?6, answered_at = ?7 where practice_id = ?1 and tenant_id = ?3 and id = ?4 and status = 'open'",
          p.tenantId,
          id,
          c.req.valid("json").answer,
          p.email,
          monotonicIso(),
        ),
      ],
      (o) => o.add("query.answered", { queryId: id, by: p.email }, `portal:${p.email}`),
    );
    return c.json({ id, status: "answered" as const }, 200);
  },
);

const PortalDoc = z.object({
  id: z.string(),
  title: z.string(),
  dueDate: z.string().nullable(),
  status: z.enum(["open", "fulfilled", "waived"]),
  overdue: z.boolean(),
  fulfilledAt: z.string().nullable(),
});
portal.openapi(
  def({
    method: "get",
    path: "/portal/document-requests",
    tag: TAG,
    summary: "Documents my accountant needs from me",
    response: z.object({ items: z.array(PortalDoc) }),
  }),
  async (c) => {
    const { p, pdb } = ctx(c);
    const rows = await pdb.all<Parameters<typeof docOut>[0]>(
      `select ${DOC_COLS} from document_requests where practice_id = ?1 and tenant_id = ?3 and status != 'waived' order by status = 'open' desc, coalesce(due_date, '9999')`,
      p.tenantId,
    );
    return c.json(
      {
        items: rows.map((r) => docOut(r)).map(({ id, title, dueDate, status, overdue, fulfilledAt }) => ({ id, title, dueDate, status, overdue, fulfilledAt })),
      },
      200,
    );
  },
);
const UPLOAD_TYPES = new Set([...RECEIPT_TYPES, "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
portal.openapi(
  def({
    method: "post",
    path: "/portal/document-requests/{id}/upload",
    tag: TAG,
    summary: "Upload the requested document (raw body; PDF/image/CSV/XLSX up to 10 MB; scanned; stored privately)",
    params: z.object({ id: Id }),
    response: z.object({ id: z.string(), status: z.literal("fulfilled"), sha256: z.string() }),
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { p, pdb } = ctx(c);
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!UPLOAD_TYPES.has(type)) throw unsupported("Upload a PDF, image, CSV or XLSX file");
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_RECEIPT) throw tooLarge("File is larger than 10 MB");
    const r = await pdb.first<{ status: string; title: string }>(
      "select status, title from document_requests where practice_id = ?1 and tenant_id = ?3 and id = ?4",
      p.tenantId,
      id,
    );
    if (!r) throw notFound("Document request");
    if (r.status !== "open") throw conflict(`Request is ${r.status}`);
    const bytes = await c.req.arrayBuffer();
    if (!bytes.byteLength) throw badRequest("Empty file");
    if (bytes.byteLength > MAX_RECEIPT) throw tooLarge("File is larger than 10 MB");
    if ((await scanHook(bytes, type)) !== "clean") throw badRequest("File failed the content scan");
    const sha = await sha256Hex(bytes);
    const key = `portal/${p.tenantId}/${id}/${sha}`;
    await c.env.DOCS.put(key, bytes, { httpMetadata: { contentType: type } });
    const docId = newId();
    await commit(
      c,
      "document_request.fulfilled",
      id,
      [
        pdb.stmt(
          "update document_requests set status = 'fulfilled', document_key = ?5, content_type = ?6, size_bytes = ?7, sha256 = ?8, fulfilled_by = ?9, fulfilled_at = ?10 where practice_id = ?1 and tenant_id = ?3 and id = ?4 and status = 'open'",
          p.tenantId,
          id,
          key,
          type,
          bytes.byteLength,
          sha,
          p.email,
          monotonicIso(),
        ),
      ],
      (o) => o.add("document_request.fulfilled", { requestId: id, documentId: docId, title: r.title }, `portal:${p.email}`),
    );
    return c.json({ id, status: "fulfilled" as const, sha256: sha }, 201);
  },
);

const PortalEngagement = z.object({
  id: z.string(),
  services: z.array(z.string()),
  feeSummary: z.string(),
  letterText: z.string(),
  letterSha256: z.string(),
  status: z.enum(["sent", "accepted"]),
  acceptedAt: z.string().nullable(),
});
portal.openapi(
  def({
    method: "get",
    path: "/portal/engagements",
    tag: TAG,
    summary: "Engagement letters sent to me",
    response: z.object({ items: z.array(PortalEngagement) }),
  }),
  async (c) => {
    const { p, pdb } = ctx(c);
    const rows = await pdb.all<Parameters<typeof engOut>[0] & { letter_text: string }>(
      `select ${ENG_COLS}, letter_text from engagements where practice_id = ?1 and tenant_id = ?3 and status in ('sent', 'accepted') order by created_at desc`,
      p.tenantId,
    );
    return c.json(
      {
        items: rows.map((r) => {
          const e = engOut(r);
          return {
            id: e.id,
            services: e.services,
            feeSummary: e.feeSummary,
            letterText: r.letter_text,
            letterSha256: e.letterSha256,
            status: e.status as "sent" | "accepted",
            acceptedAt: e.acceptedAt,
          };
        }),
      },
      200,
    );
  },
);
portal.openapi(
  def({
    method: "post",
    path: "/portal/engagements/{id}/accept",
    tag: TAG,
    summary: "Accept a letter. The client echoes the sha256 of the text they read, which must match the frozen hash.",
    params: z.object({ id: Id }),
    body: z.object({ letterSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    response: z.object({ id: z.string(), status: z.literal("accepted"), acceptedAt: z.string() }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { p, pdb } = ctx(c);
    const e = await pdb.first<{ status: string; letter_sha256: string }>(
      "select status, letter_sha256 from engagements where practice_id = ?1 and tenant_id = ?3 and id = ?4",
      p.tenantId,
      id,
    );
    if (!e || e.status === "draft" || e.status === "withdrawn") throw notFound("Engagement");
    if (e.status === "accepted") throw conflict("Already accepted");
    if (e.letter_sha256 !== c.req.valid("json").letterSha256) throw conflict("The letter you accepted does not match the current letter");
    const at = monotonicIso();
    await commit(
      c,
      "engagement.accepted",
      id,
      [
        pdb.stmt(
          "update engagements set status = 'accepted', accepted_by = ?5, accepted_at = ?6 where practice_id = ?1 and tenant_id = ?3 and id = ?4 and status = 'sent'",
          p.tenantId,
          id,
          p.email,
          at,
        ),
      ],
      (o) => o.add("engagement.accepted", { engagementId: id, letterSha256: e.letter_sha256, by: p.email }, `portal:${p.email}`),
    );
    return c.json({ id, status: "accepted" as const, acceptedAt: at }, 200);
  },
);
