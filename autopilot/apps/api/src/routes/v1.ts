import { OpenAPIHono, z } from "@hono/zod-openapi";
import { renderInvoicePdf } from "../services/invoice-pdf.js";
import { computeVatReturn, isSafeRuleRegex, computeSaSummary, vatOnNet, VAT_RATES, type VatInputLine } from "@xevrion/pipeline";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import * as S from "../schemas.js";
import { def, IdParam } from "../lib/route.js";
import { TenantDb, newId, encodeCursor, decodeCursor } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { requireRole } from "../lib/auth.js";
import { validationHook } from "../lib/route.js";
import { ingestBankCsv } from "../services/ingest.js";
import { scanHook, RECEIPT_TYPES, MAX_RECEIPT } from "../services/scan.js";
import { Outbox } from "../services/events.js";
import { categoriseTransaction } from "../services/categorise.js";
import { platform } from "./platform.js";
import { books } from "./books.js";
import { invoicing } from "./invoicing.js";
import { compliance } from "./compliance.js";
import { collab, assertPeriodOpen } from "./collab.js";
import { privacy } from "./privacy.js";
import { banking } from "./banking.js";
import { ops } from "./ops.js";
import { assistant } from "./assistant.js";
import { agentReviews } from "./agent-reviews.js";
import { agentReviewEvidence } from "./agent-review-evidence.js";
import { agentReviewRetention } from "./agent-review-retention.js";
import { agentReviewUsage } from "./agent-review-usage.js";
import { agentReviewAnalytics } from "./agent-review-analytics.js";
import { agentReviewRegulator } from "./agent-review-regulator.js";
import { reviewFeed } from "./review-feed.js";
import { reviewWorkflow } from "./review-workflow.js";
import { reviewTemplates } from "./review-templates.js";
import { reviewAttachments } from "./review-attachments.js";
import { notifyAdmin, notifyReviewLog } from "./notify.js";
import { auditStream } from "./audit-stream.js";
import { ssoAdmin } from "./sso.js";
import { scim } from "./scim.js";
import { customRoles } from "./custom-roles.js";
import { etagFor, ifMatchFails, ifNoneMatchHits, orderBy, selectFields, PLAN_SEATS } from "@xevrion/platform";
import { AppError, badRequest, conflict, notFound, tooLarge, unsupported } from "../lib/errors.js";
import { sha256Hex } from "../services/csv.js";
import { categoryKind } from "../services/ledger.js";

export const v1 = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const actor = (c: C) => c.get("principal").email;
const owner = requireRole("owner");
const reviewer = requireRole("owner", "reviewer");

const TENANT_COLS = "id, name, trading_type, vat_registered, vat_scheme, vat_basis, flat_rate_percent, plan";
type TenantRow = z.infer<typeof S.TenantSchema>;

/** Keyset pagination helper over (created_at, id) desc. */
async function paged<T extends { created_at: string; id: string }>(
  db: TenantDb,
  baseSql: string,
  params: unknown[],
  cursor: string | undefined,
  limit: number,
) {
  const cur = decodeCursor(cursor);
  const where = cur ? ` and (created_at, id) < (?${params.length + 2}, ?${params.length + 3})` : "";
  const rows = await db.all<T>(`${baseSql}${where} order by created_at desc, id desc limit ${limit + 1}`, ...params, ...(cur ?? []));
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

// ---------- account ----------
v1.openapi(def({ method: "get", path: "/me", tag: "Account", summary: "Current principal", response: S.MeSchema }), (c) => c.json(c.get("principal"), 200));

v1.openapi(def({ method: "get", path: "/tenant", tag: "Account", summary: "Current tenant", response: S.TenantSchema }), async (c) => {
  const t = await scope(c)
    .tenantRowStmt(TENANT_COLS + ", version")
    .first<TenantRow & { version: number }>();
  if (!t) throw notFound("Tenant");
  const { version, ...rest } = t;
  const tag = etagFor(t.id, version);
  c.header("etag", tag);
  if (ifNoneMatchHits(c.req.header("if-none-match"), tag)) return c.body(null, 304) as never;
  return c.json(rest, 200);
});

v1.use("/tenant", async (c, next) => (c.req.method === "PATCH" ? owner(c, next) : next()));
v1.openapi(
  def({ method: "patch", path: "/tenant", tag: "Account", summary: "Update VAT settings", body: S.UpdateTenantBody, response: S.TenantSchema }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    const f: Record<string, string | number | null> = {};
    if (b.name !== undefined) f.name = b.name;
    if (b.vatRegistered !== undefined) f.vat_registered = b.vatRegistered ? 1 : 0;
    if (b.vatScheme !== undefined) f.vat_scheme = b.vatScheme;
    if (b.flatRatePercent !== undefined) f.flat_rate_percent = b.flatRatePercent;
    if (!Object.keys(f).length) throw badRequest("Nothing to update");
    if ((f.vat_scheme ?? null) === "flat_rate" && b.flatRatePercent == null) {
      const cur = await db.tenantRowStmt("flat_rate_percent").first<{ flat_rate_percent: number | null }>();
      if (cur?.flat_rate_percent == null) throw badRequest("flatRatePercent is required for the flat rate scheme");
    }
    const cur = (await db.tenantRowStmt("id, version").first<{ id: string; version: number }>())!;
    if (ifMatchFails(c.req.header("if-match"), etagFor(cur.id, cur.version)))
      throw new AppError(412, "precondition_failed", "Tenant settings changed since you fetched them", { currentVersion: cur.version });
    f.version = cur.version + 1;
    await db.batch([db.updateTenantStmt(f), auditStmt(db, actor(c), "tenant.updated", db.tenantId, f)]);
    c.header("etag", etagFor(cur.id, cur.version + 1));
    return c.json((await db.tenantRowStmt(TENANT_COLS).first<TenantRow>())!, 200);
  },
);

v1.use("/users", owner);
v1.openapi(def({ method: "get", path: "/users", tag: "Account", summary: "List users", response: z.array(S.UserSchema) }), async (c) =>
  c.json(await scope(c).all<z.infer<typeof S.UserSchema>>("select id, email, role, display_name from users where tenant_id = ?1 order by email"), 200),
);
v1.openapi(
  def({ method: "post", path: "/users", tag: "Account", summary: "Add a user", body: S.CreateUserBody, response: S.UserSchema, status: 201 }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    const id = newId();
    const email = b.email.toLowerCase();
    if (await db.first("select id from users where tenant_id = ?1 and email = ?2", email)) throw conflict("User already exists");
    if (b.role !== "owner") {
      const plan = (await db.tenantRowStmt("plan").first<{ plan: string | null }>())?.plan ?? "free";
      const seats = PLAN_SEATS[plan] ?? PLAN_SEATS.free!;
      const used = (await db.first<{ n: number }>("select count(*) n from users where tenant_id = ?1 and role != 'owner'"))?.n ?? 0;
      if (used >= seats)
        throw new AppError(429, "quota_exceeded", `Your plan includes ${seats} reviewer/accountant seat(s)`, { metric: "seats", limit: seats });
    }
    await db.batch([
      db.stmt("insert into users (tenant_id, id, email, role, display_name) values (?1, ?2, ?3, ?4, ?5)", id, email, b.role, b.displayName ?? null),
      auditStmt(db, actor(c), "user.created", id, { email, role: b.role }),
    ]);
    return c.json({ id, email, role: b.role, display_name: b.displayName ?? null }, 201);
  },
);

// ---------- ingestion ----------
const MAX_CSV = 2 * 1024 * 1024;

v1.use("/uploads/*", owner);
v1.openapi(
  def({
    method: "post",
    path: "/uploads/bank-csv",
    tag: "Ingestion",
    summary: "Upload a bank statement CSV (creates a job and queues the pipeline)",
    response: S.UploadResult,
    status: 201,
  }),
  async (c) => {
    const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
    if (!["text/csv", "text/plain", "application/csv"].includes(ct)) throw unsupported("Send the CSV with content-type text/csv");
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX_CSV) throw tooLarge("CSV larger than 2 MB");
    return c.json(await ingestBankCsv(c.env, scope(c), actor(c), bytes, c.req.header("x-filename")), 201);
  },
);

v1.openapi(
  def({
    method: "post",
    path: "/uploads/receipt",
    tag: "Ingestion",
    summary: "Upload a receipt (PDF/image). Optional x-receipt-* headers carry known totals until OCR lands.",
    response: S.UploadResult,
    status: 201,
  }),
  async (c) => {
    const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
    if (!RECEIPT_TYPES.has(ct)) throw unsupported(`Unsupported receipt type ${ct}`);
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) throw badRequest("Empty file");
    if (bytes.byteLength > MAX_RECEIPT) throw tooLarge("Receipt larger than 10 MB");
    const db = scope(c);
    const sha = await sha256Hex(bytes);
    const dup = await db.first<{ id: string }>("select id from documents where tenant_id = ?1 and sha256 = ?2", sha);
    if (dup) return c.json({ documentId: dup.id, sha256: sha, jobId: null, inserted: 0, duplicates: 1, rejectedRows: [] }, 201);
    const scan = await scanHook(bytes, ct);
    const docId = newId();
    const key = `${db.tenantId}/receipts/${docId}`;
    await c.env.DOCS.put(key, bytes, { httpMetadata: { contentType: ct }, sha256: sha, customMetadata: { tenant: db.tenantId } });
    // Until OCR (Daytona sandbox parser) is wired, clients may pass known totals; values are treated as untrusted and validated.
    const total = Number(c.req.header("x-receipt-total-pence")),
      vat = Number(c.req.header("x-receipt-vat-pence") ?? 0);
    const date = c.req.header("x-receipt-date"),
      merchant = c.req.header("x-receipt-merchant")?.slice(0, 120);
    const extracted =
      Number.isSafeInteger(total) && total > 0 && date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isSafeInteger(vat) && vat >= 0 && vat <= total
        ? JSON.stringify({ date, merchant: merchant ?? "", totalPence: total, vatPence: vat, source: "client" })
        : null;
    await db.batch([
      db.stmt(
        "insert into documents (tenant_id, id, r2_key, filename, sha256, kind, size_bytes, content_type, scan_status, extracted_json) values (?1, ?2, ?3, ?4, ?5, 'receipt', ?6, ?7, ?8, ?9)",
        docId,
        key,
        c.req.header("x-filename")?.slice(0, 120) ?? "receipt",
        sha,
        bytes.byteLength,
        ct,
        scan,
        extracted,
      ),
      auditStmt(db, actor(c), "upload.receipt", docId, { sha256: sha, size: bytes.byteLength, extracted: !!extracted }),
    ]);
    return c.json({ documentId: docId, sha256: sha, jobId: null, inserted: 1, duplicates: 0, rejectedRows: [] }, 201);
  },
);

// ---------- transactions ----------
v1.openapi(
  def({
    method: "get",
    path: "/transactions",
    tag: "Transactions",
    summary: "List transactions",
    query: S.PageQuery.extend({
      status: z.string().max(20).optional(),
      categoryCode: z.string().max(10).optional(),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      minPence: z.coerce.number().int().optional(),
      maxPence: z.coerce.number().int().optional(),
      tag: z.string().max(30).optional(),
      sort: z.enum(["date", "-date", "amount", "-amount", "created", "-created"]).optional(),
      fields: z.string().max(300).optional(),
    }),
    response: S.page(S.TransactionSchema.partial().extend({ id: z.string() }), "TransactionPage"),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const db = scope(c);
    const conds: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      conds.push(sql.replace(/\?(?!\d)/, `?${params.length + 1}`));
    };
    if (q.status) add("status = ?", q.status);
    if (q.categoryCode) add("category_code = ?", q.categoryCode);
    if (q.from) add("txn_date >= ?", q.from);
    if (q.to) add("txn_date <= ?", q.to);
    if (q.minPence !== undefined) add("amount_pence >= ?", q.minPence);
    if (q.maxPence !== undefined) add("amount_pence <= ?", q.maxPence);
    if (q.tag) add("id in (select transaction_id from transaction_tags where tenant_id = ?1 and tag = ?)", q.tag);
    const base =
      "select id, txn_date, description, amount_pence, currency, status, category_code, confidence, vat_rate_code, vat_pence, document_id, created_at from transactions where tenant_id = ?1" +
      conds.map((x) => ` and ${x}`).join("");
    const pick = <T extends Record<string, unknown>>(rows: T[]) => rows.map((r) => selectFields(r, q.fields, TXN_FIELDS)) as (Partial<T> & { id: string })[];
    if (!q.sort || q.sort === "-created") {
      const p = await paged<z.infer<typeof S.TransactionSchema>>(db, base, params, q.cursor, q.limit);
      return c.json({ items: pick(p.items), nextCursor: p.nextCursor }, 200);
    }
    // Custom sort: offset cursor (stable because ties break on id). Fine for the page sizes a sole trader has.
    const offset = q.cursor ? Math.max(0, Number(/^o(\d{1,7})$/.exec(q.cursor)?.[1] ?? 0)) : 0;
    const order = orderBy(q.sort, { date: "txn_date", amount: "amount_pence", created: "created_at" }, "created_at desc, id desc");
    const rows = await db.all<z.infer<typeof S.TransactionSchema>>(`${base} order by ${order} limit ${q.limit + 1} offset ${offset}`, ...params);
    return c.json({ items: pick(rows.slice(0, q.limit)), nextCursor: rows.length > q.limit ? `o${offset + q.limit}` : null }, 200);
  },
);
const TXN_FIELDS = [
  "txn_date",
  "description",
  "amount_pence",
  "currency",
  "status",
  "category_code",
  "confidence",
  "vat_rate_code",
  "vat_pence",
  "document_id",
  "created_at",
] as const;

async function categoriseTxn(c: C, id: string, categoryCode: string, vatRateCode: string | null, vatPence: number, extra: D1PreparedStatement[] = []) {
  const db = scope(c);
  const outbox = new Outbox(db);
  const t = await categoriseTransaction(db, actor(c), id, categoryCode, vatRateCode, vatPence, { outbox, extra });
  await outbox.publish(c.env);
  return t;
}

v1.use("/transactions/*", reviewer);
v1.openapi(
  def({
    method: "patch",
    path: "/transactions/{id}",
    tag: "Transactions",
    summary: "Manually categorise (posts reversing + new journal)",
    params: IdParam,
    body: S.CategoriseBody,
    response: S.TransactionSchema,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = scope(c);
    const t = await db.first<{ description: string | null; amount_pence: number }>(
      "select description, amount_pence from transactions where tenant_id = ?1 and id = ?2",
      id,
    );
    if (!t) throw notFound("Transaction");
    await assertPeriodOpen(db, id);
    const extra =
      b.createRule && t.description
        ? [
            db.stmt(
              "insert into category_rules (tenant_id, id, pattern, match_type, category_code, vat_rate_code, priority, created_by) values (?1, ?2, ?3, 'contains', ?4, ?5, 10, ?6)",
              newId(),
              t.description.toUpperCase().slice(0, 80),
              b.categoryCode,
              b.vatRateCode,
              actor(c),
            ),
          ]
        : [];
    // Every manual categorisation is evidence for learned rules (/v1/books/rules/suggestions).
    if (t.description)
      extra.push(
        db.stmt(
          "insert into category_corrections (tenant_id, id, transaction_id, description, category_code, vat_rate_code, amount_pence, created_by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
          newId(),
          id,
          t.description,
          b.categoryCode,
          b.vatRateCode,
          t.amount_pence,
          actor(c),
        ),
      );
    await categoriseTxn(c, id, b.categoryCode, b.vatRateCode, b.vatPence, extra);
    return c.json(
      (await db.first<z.infer<typeof S.TransactionSchema>>(
        "select id, txn_date, description, amount_pence, currency, status, category_code, confidence, vat_rate_code, vat_pence, document_id, created_at from transactions where tenant_id = ?1 and id = ?2",
        id,
      ))!,
      200,
    );
  },
);

// ---------- categories & rules ----------
v1.openapi(def({ method: "get", path: "/categories", tag: "Categories", summary: "Chart of accounts", response: z.array(S.CategorySchema) }), async (c) =>
  c.json(
    await scope(c).all<z.infer<typeof S.CategorySchema>>(
      "select code, name, kind, sa_box, default_vat_rate_code from categories where tenant_id = ?1 order by code",
    ),
    200,
  ),
);
v1.use("/categories", async (c, next) => (c.req.method === "POST" ? owner(c, next) : next()));
v1.openapi(
  def({
    method: "post",
    path: "/categories",
    tag: "Categories",
    summary: "Add a category",
    body: S.CreateCategoryBody,
    response: S.CategorySchema,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    if (await db.first("select code from categories where tenant_id = ?1 and code = ?2", b.code)) throw conflict("Category code exists");
    await db.batch([
      db.stmt(
        "insert into categories (tenant_id, code, name, kind, sa_box, default_vat_rate_code) values (?1, ?2, ?3, ?4, ?5, ?6)",
        b.code,
        b.name,
        b.kind,
        b.saBox,
        b.defaultVatRateCode,
      ),
      auditStmt(db, actor(c), "category.created", b.code, b),
    ]);
    return c.json({ code: b.code, name: b.name, kind: b.kind, sa_box: b.saBox, default_vat_rate_code: b.defaultVatRateCode }, 201);
  },
);
v1.openapi(def({ method: "get", path: "/rules", tag: "Categories", summary: "Categorisation rules", response: z.array(S.RuleSchema) }), async (c) =>
  c.json(
    await scope(c).all<z.infer<typeof S.RuleSchema>>(
      "select id, pattern, match_type, category_code, vat_rate_code, priority from category_rules where tenant_id = ?1 order by priority, pattern",
    ),
    200,
  ),
);
v1.use("/rules", async (c, next) => (c.req.method === "POST" ? reviewer(c, next) : next()));
v1.openapi(
  def({ method: "post", path: "/rules", tag: "Categories", summary: "Add a rule", body: S.CreateRuleBody, response: S.RuleSchema, status: 201 }),
  async (c) => {
    const b = c.req.valid("json");
    if (b.matchType === "regex" && !isSafeRuleRegex(b.pattern))
      throw badRequest("Invalid or unsafe regex (nested quantifiers, backreferences and lookarounds are not allowed)");
    // Regex patterns keep their case: upper-casing would turn \d into \D. Matching is case-insensitive anyway.
    const pattern = b.matchType === "regex" ? b.pattern : b.pattern.toUpperCase();
    const db = scope(c);
    if (!(await db.first("select code from categories where tenant_id = ?1 and code = ?2", b.categoryCode))) throw badRequest("Unknown category");
    const id = newId();
    await db.batch([
      db.stmt(
        "insert into category_rules (tenant_id, id, pattern, match_type, category_code, vat_rate_code, priority, created_by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        id,
        pattern,
        b.matchType,
        b.categoryCode,
        b.vatRateCode,
        b.priority,
        actor(c),
      ),
      auditStmt(db, actor(c), "rule.created", id, b),
    ]);
    return c.json({ id, pattern, match_type: b.matchType, category_code: b.categoryCode, vat_rate_code: b.vatRateCode, priority: b.priority }, 201);
  },
);

// ---------- ledger ----------
const TbRow = z.object({
  account_code: z.string(),
  name: z.string().nullable(),
  debit_pence: z.number().int(),
  credit_pence: z.number().int(),
  balance_pence: z.number().int(),
});
v1.openapi(
  def({
    method: "get",
    path: "/ledger/trial-balance",
    tag: "Ledger",
    summary: "Trial balance (must net to zero)",
    response: z.object({ rows: z.array(TbRow), totalDebit: z.number().int(), totalCredit: z.number().int(), balanced: z.boolean() }).openapi("TrialBalance"),
  }),
  async (c) => {
    const rows = await scope(c).all<z.infer<typeof TbRow>>(
      `select l.account_code, c.name, sum(l.debit_pence) as debit_pence, sum(l.credit_pence) as credit_pence, sum(l.debit_pence) - sum(l.credit_pence) as balance_pence
     from journal_lines l left join categories c on c.tenant_id = l.tenant_id and c.code = l.account_code where l.tenant_id = ?1 group by l.account_code, c.name order by l.account_code`,
    );
    const totalDebit = rows.reduce((a, r) => a + r.debit_pence, 0),
      totalCredit = rows.reduce((a, r) => a + r.credit_pence, 0);
    return c.json({ rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit }, 200);
  },
);
const JournalOut = z.object({
  id: z.string(),
  entry_date: z.string(),
  memo: z.string().nullable(),
  source_type: z.string().nullable(),
  source_id: z.string().nullable(),
  created_at: z.string(),
});
v1.openapi(
  def({ method: "get", path: "/ledger/journals", tag: "Ledger", summary: "Journals", query: S.PageQuery, response: S.page(JournalOut, "JournalPage") }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(
      await paged<z.infer<typeof JournalOut>>(
        scope(c),
        "select id, entry_date, memo, source_type, source_id, created_at from journals where tenant_id = ?1",
        [],
        q.cursor,
        q.limit,
      ),
      200,
    );
  },
);

// ---------- invoices ----------
v1.openapi(def({ method: "get", path: "/invoices", tag: "Invoices", summary: "List invoices", response: z.array(S.InvoiceSchema) }), async (c) =>
  c.json(
    await scope(c).all<z.infer<typeof S.InvoiceSchema>>(
      "select id, number, customer_name, customer_email, issue_date, due_date, status, net_pence, vat_pence, gross_pence, lines_json from invoices where tenant_id = ?1 and deleted_at is null order by issue_date desc, number desc",
    ),
    200,
  ),
);
v1.use("/invoices", async (c, next) => (c.req.method === "POST" ? owner(c, next) : next()));
// Reads of a single invoice (detail, balance, PDF) match the list: any member; changes stay owner-only.
v1.use("/invoices/*", async (c, next) => (c.req.method === "GET" ? next() : owner(c, next)));
v1.openapi(
  def({
    method: "post",
    path: "/invoices",
    tag: "Invoices",
    summary: "Create a draft invoice (sequential numbering)",
    body: S.CreateInvoiceBody,
    response: S.InvoiceSchema,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    if (b.dueDate < b.issueDate) throw badRequest("dueDate must be on or after issueDate");
    const db = scope(c);
    let net = 0,
      vat = 0;
    for (const l of b.lines) {
      const lineNet = Math.round(l.quantity * l.unitPence);
      net += lineNet;
      vat += vatOnNet(lineNet, VAT_RATES[l.vatRateCode] ?? 0);
    }
    const seq = await db.first<{ prefix: string; next_value: number }>(
      "update invoice_sequences set next_value = next_value + 1 where tenant_id = ?1 returning prefix, next_value - 1 as next_value",
    );
    if (!seq) throw badRequest("Invoice numbering not initialised");
    const outbox = new Outbox(db);
    const id = newId();
    const number = `${seq.prefix}${String(seq.next_value).padStart(4, "0")}`;
    const row = {
      id,
      number,
      customer_name: b.customerName,
      customer_email: b.customerEmail ?? null,
      issue_date: b.issueDate,
      due_date: b.dueDate,
      status: "draft",
      net_pence: net,
      vat_pence: vat,
      gross_pence: net + vat,
      lines_json: JSON.stringify(b.lines),
    };
    await db.batch([
      db.stmt(
        "insert into invoices (tenant_id, id, number, customer_name, customer_email, issue_date, due_date, status, net_pence, vat_pence, gross_pence, lines_json) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9, ?10, ?11)",
        id,
        number,
        row.customer_name,
        row.customer_email,
        row.issue_date,
        row.due_date,
        net,
        vat,
        net + vat,
        row.lines_json,
      ),
      auditStmt(db, actor(c), "invoice.created", id, { number, gross: net + vat }),
      outbox.add("invoice.created", { invoiceId: id, number, customerName: row.customer_name, grossPence: net + vat }, actor(c)) && outbox.stmts.pop()!,
    ]);
    await outbox.publish(c.env);
    return c.json(row, 201);
  },
);
const TRANSITIONS: Record<string, string[]> = { draft: ["sent", "void"], sent: ["paid", "void"], paid: [], void: [] };
v1.openapi(
  def({
    method: "post",
    path: "/invoices/{id}/status",
    tag: "Invoices",
    summary: "Change status (draft→sent→paid, or void). Does not email anyone.",
    params: IdParam,
    body: S.InvoiceStatusBody,
    response: S.InvoiceSchema,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = scope(c);
    const inv = await db.first<{ status: string; number: string; gross_pence: number }>(
      "select status, number, gross_pence from invoices where tenant_id = ?1 and id = ?2 and deleted_at is null",
      id,
    );
    if (!inv) throw notFound("Invoice");
    const outbox = new Outbox(db);
    if (b.status === "paid")
      outbox.add("invoice.paid", { invoiceId: id, number: inv.number, grossPence: inv.gross_pence, transactionId: b.paidTransactionId ?? null }, actor(c));
    if (!TRANSITIONS[inv.status]?.includes(b.status)) throw conflict(`Cannot move invoice from ${inv.status} to ${b.status}`);
    await db.batch([
      db.stmt(
        "update invoices set status = ?3, paid_transaction_id = coalesce(?4, paid_transaction_id), version = version + 1 where tenant_id = ?1 and id = ?2",
        id,
        b.status,
        b.paidTransactionId ?? null,
      ),
      auditStmt(db, actor(c), "invoice.status", id, { from: inv.status, to: b.status }),
      ...outbox.stmts,
    ]);
    await outbox.publish(c.env);
    return c.json(
      (await db.first<z.infer<typeof S.InvoiceSchema>>(
        "select id, number, customer_name, customer_email, issue_date, due_date, status, net_pence, vat_pence, gross_pence, lines_json from invoices where tenant_id = ?1 and id = ?2",
        id,
      ))!,
      200,
    );
  },
);
v1.openAPIRegistry.registerPath({
  method: "get",
  path: "/invoices/{id}/pdf",
  tags: ["Invoices"],
  summary: "Render the invoice as PDF (A4, pdf-lib)",
  security: [{ accessJwt: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "PDF", content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } } },
    404: { description: "Not found" },
  },
});
v1.get("/invoices/:id/pdf", async (c) => {
  const db = scope(c);
  const id = c.req.param("id");
  const inv = await db.first<{
    number: string;
    customer_name: string;
    issue_date: string;
    due_date: string;
    status: string;
    net_pence: number;
    vat_pence: number;
    gross_pence: number;
    lines_json: string;
  }>(
    "select number, customer_name, issue_date, due_date, status, net_pence, vat_pence, gross_pence, lines_json from invoices where tenant_id = ?1 and id = ?2",
    id,
  );
  if (!inv) throw notFound("Invoice not found");
  const t = await db.tenantRowStmt("name").first<{ name: string }>();
  const pdf = await renderInvoicePdf({
    sellerName: t?.name ?? "",
    number: inv.number,
    issueDate: inv.issue_date,
    dueDate: inv.due_date,
    customerName: inv.customer_name,
    status: inv.status,
    lines: JSON.parse(inv.lines_json),
    netPence: inv.net_pence,
    vatPence: inv.vat_pence,
    grossPence: inv.gross_pence,
  });
  return c.body(pdf as Uint8Array<ArrayBuffer>, 200, {
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="invoice-${inv.number.replace(/[^\w.-]/g, "_")}.pdf"`,
    "cache-control": "private, no-store",
  });
});

// ---------- VAT & SA ----------
async function vatLines(db: TenantDb): Promise<VatInputLine[]> {
  const rows = await db.all<{
    id: string;
    txn_date: string;
    amount_pence: number;
    category_code: string | null;
    vat_rate_code: string | null;
    vat_pence: number | null;
    document_id: string | null;
  }>(
    "select id, txn_date, amount_pence, category_code, vat_rate_code, vat_pence, document_id from transactions where tenant_id = ?1 and status in ('categorised','reconciled')",
  );
  const kinds = new Map<string, Awaited<ReturnType<typeof categoryKind>>>();
  const out: VatInputLine[] = [];
  for (const r of rows) {
    const code = r.category_code ?? "9999";
    if (!kinds.has(code)) kinds.set(code, await categoryKind(db, code));
    out.push({
      id: r.id,
      date: r.txn_date,
      grossPence: r.amount_pence,
      kind: kinds.get(code)!,
      vatRateCode: r.vat_rate_code,
      evidencedVatPence: r.vat_pence && r.vat_pence > 0 ? r.vat_pence : r.document_id ? 0 : null,
    });
  }
  return out;
}

/**
 * Accrual basis (standard and flat-rate schemes): sales VAT follows the invoice tax point (issue date), so issued
 * invoices become income lines and the bank receipts that paid them are dropped to avoid double counting.
 * Cash accounting keeps bank-dated receipts only. Bank income with no invoice (e.g. card payouts) stays in both.
 */
async function accrualAdjust(db: TenantDb, lines: VatInputLine[]): Promise<VatInputLine[]> {
  const invs = await db.all<{ id: string; issue_date: string; lines_json: string; paid_transaction_id: string | null }>(
    "select id, issue_date, lines_json, paid_transaction_id from invoices where tenant_id = ?1 and status in ('sent','paid')",
  );
  const paidBy = new Set(invs.map((i) => i.paid_transaction_id).filter((x): x is string => !!x));
  const out = lines.filter((l) => !(l.kind === "income" && paidBy.has(l.id)));
  for (const inv of invs) {
    const ls = JSON.parse(inv.lines_json) as { quantity: number; unitPence: number; vatRateCode: string }[];
    ls.forEach((l, i) => {
      const net = Math.round(l.quantity * l.unitPence);
      const rate = VAT_RATES[l.vatRateCode] ?? null;
      out.push({
        id: `${inv.id}#${i}`,
        date: inv.issue_date,
        grossPence: net + (rate == null ? 0 : vatOnNet(net, rate)),
        kind: "income",
        vatRateCode: l.vatRateCode,
      });
    });
  }
  return out;
}
v1.use("/vat/*", reviewer);
v1.openapi(
  def({
    method: "post",
    path: "/vat/drafts",
    tag: "VAT",
    summary: "Compute and store a DRAFT VAT return (unverified rates, never submitted)",
    body: S.VatDraftBody,
    response: S.VatDraftSchema,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    if (b.periodEnd < b.periodStart) throw badRequest("periodEnd before periodStart");
    const db = scope(c);
    const t = await db
      .tenantRowStmt("vat_registered, vat_scheme, flat_rate_percent")
      .first<{ vat_registered: number; vat_scheme: string | null; flat_rate_percent: number | null }>();
    const scheme = (b.scheme ?? t?.vat_scheme ?? "standard") as "standard" | "cash" | "flat_rate";
    let draft;
    try {
      const bank = await vatLines(db);
      draft = computeVatReturn(scheme === "cash" ? bank : await accrualAdjust(db, bank), {
        scheme,
        periodStart: b.periodStart,
        periodEnd: b.periodEnd,
        flatRatePercent: t?.flat_rate_percent ?? null,
      });
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    draft.warnings.push(
      scheme === "cash"
        ? "Cash accounting: sales dated by bank receipt."
        : "Accrual: sales dated by invoice issue date; receipts matched to invoices excluded.",
    );
    if (!t?.vat_registered) draft.warnings.push("Tenant is not marked VAT registered.");
    const id = newId();
    const vatOutbox = new Outbox(db);
    await db.batch([
      db.stmt(
        "insert into vat_returns (tenant_id, id, period_start, period_end, boxes_json, status) values (?1, ?2, ?3, ?4, ?5, 'draft')",
        id,
        b.periodStart,
        b.periodEnd,
        JSON.stringify(draft),
      ),
      auditStmt(db, actor(c), "vat.draft_created", id, { scheme, box5: draft.box5 }),
      vatOutbox.add("vat_draft.ready", { draftId: id, periodStart: b.periodStart, periodEnd: b.periodEnd, box5Pence: draft.box5 }, actor(c)) &&
        vatOutbox.stmts.pop()!,
    ]);
    await vatOutbox.publish(c.env);
    return c.json({ id, ...draft }, 201);
  },
);
v1.openapi(def({ method: "get", path: "/vat/drafts", tag: "VAT", summary: "List VAT drafts", response: z.array(S.VatDraftSchema) }), async (c) => {
  const rows = await scope(c).all<{ id: string; boxes_json: string }>("select id, boxes_json from vat_returns where tenant_id = ?1 order by created_at desc");
  return c.json(
    rows.map((r) => ({ id: r.id, ...JSON.parse(r.boxes_json) })),
    200,
  );
});
const SaOut = z
  .object({
    taxYear: z.string(),
    turnoverPence: z.number().int(),
    expensesByCategory: z.record(z.string(), z.number().int()),
    allowableExpensesPence: z.number().int(),
    profitPence: z.number().int(),
    tradingAllowanceComparison: z.object({ allowancePence: z.number().nullable(), profitIfAllowanceUsed: z.number().nullable(), betterOption: z.string() }),
    status: z.literal("draft"),
    verified: z.literal(false),
    notes: z.array(z.string()),
  })
  .openapi("SaSummary");
v1.openapi(
  def({ method: "get", path: "/sa/summary", tag: "Self Assessment", summary: "DRAFT self-employment summary", query: S.SaQuery, response: SaOut }),
  async (c) => {
    const q = c.req.valid("query");
    const db = scope(c);
    const rows = await db.all<{ txn_date: string; amount_pence: number; vat_pence: number | null; kind: string | null; sa_box: string | null }>(
      `select t.txn_date, t.amount_pence, t.vat_pence, c.kind, c.sa_box from transactions t left join categories c on c.tenant_id = t.tenant_id and c.code = t.category_code
     where t.tenant_id = ?1 and t.status in ('categorised','reconciled') and t.category_code not in ('8000','9999')`,
    );
    const cfg = JSON.parse((await c.env.CONFIG.get(`sa:${db.tenantId}`)) ?? "null") as { tradingAllowancePence?: number } | null;
    return c.json(
      computeSaSummary(
        rows.map((r) => ({
          date: r.txn_date,
          grossPence: r.amount_pence,
          netPence: r.amount_pence - Math.sign(r.amount_pence) * (r.vat_pence ?? 0),
          kind: r.kind === "income" ? "income" : "expense",
          saCategory: r.sa_box,
        })),
        { tradingAllowancePence: cfg?.tradingAllowancePence ?? null, taxYearStart: q.taxYearStart, taxYearEnd: q.taxYearEnd },
      ),
      200,
    );
  },
);

// ---------- exceptions & review ----------
v1.openapi(
  def({
    method: "get",
    path: "/exceptions",
    tag: "Review",
    summary: "Exceptions queue",
    query: S.PageQuery.extend({ status: z.enum(["open", "resolved"]).default("open") }),
    response: S.page(S.ExceptionSchema, "ExceptionPage"),
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(
      await paged<z.infer<typeof S.ExceptionSchema>>(
        scope(c),
        "select id, job_id, stage, reason, reason_code, subject_type, subject_id, status, created_at from exceptions where tenant_id = ?1 and status = ?2",
        [q.status],
        q.cursor,
        q.limit,
      ),
      200,
    );
  },
);
v1.use("/exceptions/*", reviewer);
v1.openapi(
  def({
    method: "post",
    path: "/exceptions/{id}/resolve",
    tag: "Review",
    summary: "Approve, override (re-categorise) or dismiss an exception",
    params: IdParam,
    body: S.ResolveExceptionBody,
    response: S.ExceptionSchema,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = scope(c);
    const ex = await db.first<{ status: string; job_id: string; subject_type: string | null; subject_id: string | null }>(
      "select status, job_id, subject_type, subject_id from exceptions where tenant_id = ?1 and id = ?2",
      id,
    );
    if (!ex) throw notFound("Exception");
    if (ex.status !== "open") throw conflict("Exception already resolved");
    if (b.decision === "override" && !b.override) throw badRequest("override details required");
    const resolve = [
      db.stmt(
        "update exceptions set status = 'resolved', resolved_by = ?3, resolved_at = datetime('now'), resolution_json = ?4 where tenant_id = ?1 and id = ?2",
        id,
        actor(c),
        JSON.stringify(b),
      ),
      db.stmt(
        "insert into reviews (tenant_id, id, job_id, reviewer, decision, notes) values (?1, ?2, ?3, ?4, ?5, ?6)",
        newId(),
        ex.job_id,
        actor(c),
        b.decision,
        b.note ?? null,
      ),
      auditStmt(db, actor(c), `exception.${b.decision}`, id, b),
    ];
    const exOutbox = new Outbox(db);
    exOutbox.add("exception.resolved", { exceptionId: id, decision: b.decision, by: actor(c) }, actor(c));
    resolve.push(...exOutbox.stmts);
    if (b.decision === "override" && ex.subject_type === "transaction" && ex.subject_id) {
      await categoriseTxn(c, ex.subject_id, b.override!.categoryCode, b.override!.vatRateCode ?? null, b.override!.vatPence ?? 0, resolve);
    } else await db.batch(resolve);
    await exOutbox.publish(c.env);
    return c.json(
      (await db.first<z.infer<typeof S.ExceptionSchema>>(
        "select id, job_id, stage, reason, reason_code, subject_type, subject_id, status, created_at from exceptions where tenant_id = ?1 and id = ?2",
        id,
      ))!,
      200,
    );
  },
);

// ---------- jobs, billing, export ----------
v1.openapi(def({ method: "get", path: "/jobs", tag: "Jobs", summary: "Jobs", query: S.PageQuery, response: S.page(S.JobSchema, "JobPage") }), async (c) => {
  const q = c.req.valid("query");
  return c.json(
    await paged<z.infer<typeof S.JobSchema>>(
      scope(c),
      "select id, kind, period, status, qa_score, created_at from jobs where tenant_id = ?1",
      [],
      q.cursor,
      q.limit,
    ),
    200,
  );
});
v1.openapi(
  def({
    method: "get",
    path: "/jobs/{id}",
    tag: "Jobs",
    summary: "Job with event timeline",
    params: IdParam,
    response: z.object({ job: S.JobSchema, events: z.array(S.JobEventSchema) }).openapi("JobDetail"),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = scope(c);
    const job = await db.first<z.infer<typeof S.JobSchema>>(
      "select id, kind, period, status, qa_score, created_at from jobs where tenant_id = ?1 and id = ?2",
      id,
    );
    if (!job) throw notFound("Job");
    const events = await db.all<z.infer<typeof S.JobEventSchema>>(
      "select e.id, e.stage, e.status, e.detail, e.created_at from job_events e join jobs j on j.id = e.job_id where j.tenant_id = ?1 and e.job_id = ?2 order by e.created_at, e.rowid",
      id,
    );
    return c.json({ job, events }, 200);
  },
);
v1.use("/jobs/*", async (c, next) => (c.req.method === "POST" ? reviewer(c, next) : next()));
v1.openapi(
  def({
    method: "post",
    path: "/jobs/{id}/rerun",
    tag: "Jobs",
    summary: "Re-queue a job (idempotent stages)",
    params: IdParam,
    response: z.object({ queued: z.boolean() }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = scope(c);
    if (!(await db.first("select id from jobs where tenant_id = ?1 and id = ?2", id))) throw notFound("Job");
    await db.batch([db.stmt("update jobs set status = 'queued' where tenant_id = ?1 and id = ?2", id), auditStmt(db, actor(c), "job.rerun", id)]);
    await c.env.PIPELINE.send({ jobId: id, tenantId: db.tenantId });
    return c.json({ queued: true }, 200);
  },
);
const BillingOut = z.object({ id: z.string(), job_id: z.string().nullable(), event: z.string(), amount_pence: z.number().nullable(), created_at: z.string() });
v1.openapi(def({ method: "get", path: "/billing/events", tag: "Billing", summary: "Outcome/billing events", response: z.array(BillingOut) }), async (c) =>
  c.json(
    await scope(c).all<z.infer<typeof BillingOut>>(
      "select id, job_id, event, amount_pence, created_at from billing_events where tenant_id = ?1 order by created_at desc limit 500",
    ),
    200,
  ),
);

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // neutralise spreadsheet formula injection in text; real numbers (e.g. -4560 pence) stay numeric
  const safe = typeof v !== "number" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
v1.openAPIRegistry.registerPath({
  method: "get",
  path: "/export/transactions.csv",
  tags: ["Export"],
  summary: "Transactions as CSV",
  security: [{ accessJwt: [] }],
  responses: { 200: { description: "CSV", content: { "text/csv": { schema: z.string() } } } },
});
/** Rows per page when streaming exports (keyset over (txn_date, id), so memory stays flat at 100k+ rows). */
const EXPORT_PAGE = 2000;
v1.get("/export/transactions.csv", async (c) => {
  const db = scope(c);
  const head = ["txn_date", "description", "amount_pence", "currency", "category_code", "vat_rate_code", "vat_pence", "status"];
  await db.run("insert into audit_log (tenant_id, id, actor, action, subject) values (?1, ?2, ?3, 'export.transactions_csv', null)", newId(), actor(c));
  const enc = new TextEncoder();
  let after: [string, string] | null = null;
  let headerSent = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (!headerSent) {
        headerSent = true;
        ctrl.enqueue(enc.encode(head.join(",") + "\n"));
      }
      const rows: Record<string, unknown>[] = await db.all<Record<string, unknown>>(
        `select id, txn_date, description, amount_pence, currency, category_code, vat_rate_code, vat_pence, status from transactions where tenant_id = ?1${
          after ? " and (txn_date > ?2 or (txn_date = ?2 and id > ?3))" : ""
        } order by txn_date, id limit ${EXPORT_PAGE}`,
        ...(after ?? []),
      );
      if (rows.length) ctrl.enqueue(enc.encode(rows.map((r) => head.map((h) => csvCell(r[h])).join(",")).join("\n") + "\n"));
      if (rows.length < EXPORT_PAGE) return ctrl.close();
      const last = rows[rows.length - 1]!;
      after = [String(last.txn_date), String(last.id)];
    },
  });
  return c.body(stream, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=transactions.csv" });
});
v1.openapi(def({ method: "get", path: "/export/ledger.json", tag: "Export", summary: "Journals with lines as JSON", response: z.any() }), async (c) => {
  const db = scope(c);
  const journals = await db.all<{ id: string }>(
    "select id, entry_date, memo, source_type, source_id from journals where tenant_id = ?1 order by entry_date, created_at",
  );
  const lines = await db.all<{ journal_id: string }>(
    "select journal_id, account_code, debit_pence, credit_pence, vat_rate_code from journal_lines where tenant_id = ?1",
  );
  const by = new Map<string, unknown[]>();
  // O(n): the previous spread-copy per line was O(n²) on large ledgers.
  for (const l of lines) {
    const arr = by.get(l.journal_id);
    if (arr) arr.push(l);
    else by.set(l.journal_id, [l]);
  }
  await db.run("insert into audit_log (tenant_id, id, actor, action, subject) values (?1, ?2, ?3, 'export.ledger_json', null)", newId(), actor(c));
  return c.json({ journals: journals.map((j) => ({ ...j, lines: by.get(j.id) ?? [] })) }, 200);
});

v1.route("/", platform);
v1.route("/books", books);
v1.route("/", invoicing);
v1.route("/", compliance);
v1.route("/", collab);
v1.route("/", privacy);
v1.route("/", assistant);
v1.route("/", banking);
v1.route("/", ops);
v1.route("/", agentReviews);
v1.route("/", agentReviewEvidence);
v1.route("/", agentReviewRetention);
v1.route("/", agentReviewUsage);
v1.route("/", agentReviewAnalytics);
v1.route("/", agentReviewRegulator);
v1.route("/", reviewFeed);
v1.route("/", reviewWorkflow);
v1.route("/", reviewAttachments);
v1.route("/", reviewTemplates);
v1.route("/", notifyAdmin);
v1.route("/", notifyReviewLog);
v1.route("/", auditStream);
v1.route("/", ssoAdmin);
v1.route("/scim/v2", scim);
v1.route("/", customRoles);
