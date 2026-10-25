/**
 * Practice co-pilot API, part 2: work queues and workflow (ADR 0024).
 * Review queue across clients with SLA + claims, single and bulk approval with confidence floors, per-client
 * auto-approve rules with deterministic QA sampling, close checklists from templates, client queries (portal only,
 * events only), recurring task templates, time tracking and internal billing records (never invoiced or charged).
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as B from "@xevrion/books";
import type { AppEnv, PracticeRole } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt, monotonicIso } from "../lib/audit.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import { PracticeAudit, accessibleClient, clientScopeSql, practiceDb, requirePracticeRole, type PracticeDb } from "../lib/practice.js";
import { categoriseTransaction } from "../services/categorise.js";
import { Outbox } from "../services/events.js";
import { ingestBankCsv } from "../services/ingest.js";
import { MANAGERS, SIGNERS, assertAssignable, checklistStmts, monthsBetween, wipByClient } from "./practice.js";

type C = Context<AppEnv>;
export const work = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Id = z.string().min(1).max(64);
const today = () => new Date().toISOString().slice(0, 10);
const APPROVERS: PracticeRole[] = ["partner", "manager", "reviewer", "preparer"];
const toIso = (s: string) => (s.includes("T") ? s : `${s.replace(" ", "T")}Z`);

// ---------------- review queue ----------------
const QueueItem = z.object({
  tenantId: z.string(),
  client: z.string(),
  transactionId: z.string(),
  date: z.string(),
  description: z.string().nullable(),
  amountPence: z.number(),
  categoryCode: z.string().nullable(),
  confidence: z.number().nullable(),
  status: z.string(),
  ageHours: z.number(),
  sla: z.enum(["ok", "due_soon", "breached"]),
  assignee: z.string().nullable(),
  autoApprovable: z.boolean(),
  reason: z.string(),
});
work.openapi(
  def({
    method: "get",
    path: "/practice/review-queue",
    tag: "Practice workflow",
    summary: "Items awaiting first-pass review across my clients, oldest first, with SLA state and auto-approve eligibility",
    query: z.object({
      clientId: Id.optional(),
      assignee: z.string().max(200).optional(),
      unclaimed: z.enum(["true", "false"]).optional(),
      maxConfidence: z.coerce.number().min(0).max(1).optional(),
      sla: z.enum(["ok", "due_soon", "breached"]).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    response: z.object({ items: z.array(QueueItem), total: z.number() }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const pdb = practiceDb(c);
    const conds: string[] = [];
    const args: unknown[] = [];
    const arg = (v: unknown) => (args.push(v), `?${args.length + 2}`);
    if (q.clientId) conds.push(`t.tenant_id = ${arg(q.clientId)}`);
    if (q.assignee) conds.push(`rc.assignee = ${arg(q.assignee.toLowerCase())}`);
    if (q.unclaimed === "true") conds.push("rc.assignee is null");
    if (q.maxConfidence !== undefined) conds.push(`coalesce(t.confidence, 0) <= ${arg(q.maxConfidence)}`);
    const where = `t.tenant_id in (${clientScopeSql(c.get("practice").role)}) and t.reviewed_at is null${conds.map((x) => ` and ${x}`).join("")}`;
    const from = `from transactions t join practice_clients pc on pc.practice_id = ?1 and pc.tenant_id = t.tenant_id
      left join review_claims rc on rc.tenant_id = t.tenant_id and rc.transaction_id = t.id where ${where}`;
    const total = (await pdb.first<{ n: number }>(`select count(*) n ${from}`, ...args))?.n ?? 0;
    const rows = await pdb.all<{
      tenant_id: string;
      client: string;
      id: string;
      txn_date: string;
      description: string | null;
      amount_pence: number;
      category_code: string | null;
      confidence: number | null;
      status: string;
      created_at: string;
      assignee: string | null;
      sla_hours: number;
      policy: string;
    }>(
      `select t.tenant_id, pc.name client, t.id, t.txn_date, t.description, t.amount_pence, t.category_code, t.confidence, t.status, t.created_at, rc.assignee,
       pc.review_sla_hours sla_hours, pc.auto_approve_json policy ${from} order by t.created_at, t.id limit ${arg(q.sla ? 5000 : q.limit)}`,
      ...args,
    );
    const now = Date.now();
    let items = rows.map((r) => {
      const ageHours = Math.max(0, Math.round((now - Date.parse(toIso(r.created_at))) / 36_000) / 100);
      const d = B.autoApproveDecision({ id: r.id, categoryCode: r.category_code, confidence: r.confidence, status: r.status }, B.parsePolicy(r.policy));
      return {
        tenantId: r.tenant_id,
        client: r.client,
        transactionId: r.id,
        date: r.txn_date,
        description: r.description,
        amountPence: r.amount_pence,
        categoryCode: r.category_code,
        confidence: r.confidence,
        status: r.status,
        ageHours,
        sla: B.slaState(ageHours, r.sla_hours),
        assignee: r.assignee,
        autoApprovable: d.approve,
        reason: d.reason,
      };
    });
    if (q.sla) items = items.filter((i) => i.sla === q.sla).slice(0, q.limit);
    return c.json({ items, total }, 200);
  },
);

/** Clients this request may touch, cached per request; 404 for anything outside the staff member's scope. */
const clientCache = (pdb: PracticeDb, role: PracticeRole) => {
  const m = new Map<string, Awaited<ReturnType<typeof accessibleClient>>>();
  return async (tenantId: string) => {
    if (!m.has(tenantId)) m.set(tenantId, await accessibleClient(pdb, role, tenantId));
    return m.get(tenantId)!;
  };
};

interface TxnRow {
  id: string;
  category_code: string | null;
  confidence: number | null;
  status: string;
  reviewed_at: string | null;
  vat_rate_code: string | null;
  vat_pence: number | null;
}
/** Marks reviewed + review_log + review.approved event + tenant audit, as statements for one atomic batch. */
function approveStmts(
  { pdb, tdb, outbox }: { pdb: PracticeDb; tdb: TenantDb; outbox: Outbox },
  t: TxnRow,
  finalCategory: string,
  method: "manual" | "bulk" | "auto_rule" | "qa",
  qaSample = false,
) {
  const at = monotonicIso();
  outbox.add("review.approved", { transactionId: t.id, categoryCode: finalCategory, aiCategoryCode: t.category_code, method, by: pdb.email }, pdb.email);
  return [
    tdb.stmt(
      "update transactions set reviewed_by = ?3, reviewed_at = ?4, review_method = ?5, qa_sample = ?6 where tenant_id = ?1 and id = ?2 and reviewed_at is null",
      t.id,
      pdb.email,
      at,
      method,
      qaSample ? 1 : 0,
    ),
    pdb.stmt(
      "insert into review_log (practice_id, tenant_id, id, transaction_id, ai_category_code, ai_confidence, final_category_code, method, reviewed_by, reviewed_at) values (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?2, ?10)",
      tdb.tenantId,
      newId(),
      t.id,
      t.category_code,
      t.confidence,
      finalCategory,
      method,
      at,
    ),
    auditStmt(tdb, pdb.email, "review.approved", t.id, { method, categoryCode: finalCategory }),
  ];
}

work.use("/practice/review/*", async (c, next) => requirePracticeRole(...APPROVERS)(c, next));
work.openapi(
  def({
    method: "post",
    path: "/practice/review/approve",
    tag: "Practice workflow",
    summary: "Approve review items (optionally correcting the category first). Corrections feed learning and the eval harness.",
    body: z.object({
      items: z
        .array(
          z.object({
            clientId: Id,
            transactionId: Id,
            categoryCode: z
              .string()
              .regex(/^\d{4}$/)
              .optional(),
            vatRateCode: z.string().max(16).nullable().optional(),
          }),
        )
        .min(1)
        .max(200),
    }),
    response: z.object({ approved: z.number(), corrected: z.number(), skipped: z.array(z.object({ transactionId: z.string(), reason: z.string() })) }),
  }),
  async (c) => {
    const pdb = practiceDb(c);
    const client = clientCache(pdb, c.get("practice").role);
    let approved = 0,
      corrected = 0;
    const skipped: { transactionId: string; reason: string }[] = [];
    for (const it of c.req.valid("json").items) {
      await client(it.clientId);
      const tdb = new TenantDb(c.env.DB, it.clientId);
      const t = await tdb.first<TxnRow>(
        "select id, category_code, confidence, status, reviewed_at, vat_rate_code, vat_pence from transactions where tenant_id = ?1 and id = ?2",
        it.transactionId,
      );
      if (!t) {
        skipped.push({ transactionId: it.transactionId, reason: "not found" });
        continue;
      }
      if (t.reviewed_at) {
        skipped.push({ transactionId: t.id, reason: "already reviewed" });
        continue;
      }
      const finalCat = it.categoryCode ?? t.category_code;
      if (!finalCat || finalCat === "9999") {
        skipped.push({ transactionId: t.id, reason: "needs a category before approval" });
        continue;
      }
      const outbox = new Outbox(tdb);
      const stmts = approveStmts({ pdb, tdb, outbox }, t, finalCat, "manual");
      if (it.categoryCode && it.categoryCode !== t.category_code) {
        corrected++;
        await categoriseTransaction(
          tdb,
          pdb.email,
          t.id,
          it.categoryCode,
          it.vatRateCode ?? t.vat_rate_code,
          it.vatRateCode === null ? 0 : (t.vat_pence ?? 0),
          {
            outbox,
            method: "practice_review",
            extra: [
              ...stmts,
              tdb.stmt(
                "insert into category_corrections (tenant_id, id, transaction_id, description, category_code, vat_rate_code, amount_pence, created_by) select ?1, ?3, id, description, ?4, ?5, amount_pence, ?6 from transactions where tenant_id = ?1 and id = ?2",
                t.id,
                newId(),
                it.categoryCode,
                it.vatRateCode ?? t.vat_rate_code,
                pdb.email,
              ),
            ],
          },
        );
      } else await tdb.batch([...stmts, ...outbox.stmts.splice(0)]);
      await outbox.publish(c.env);
      approved++;
    }
    return c.json({ approved, corrected, skipped }, 200);
  },
);

const SIGNER_SET = new Set<PracticeRole>(SIGNERS);
work.openapi(
  def({
    method: "post",
    path: "/practice/review/bulk-approve",
    tag: "Practice workflow",
    summary: "Bulk-approve high-confidence items (confidence floor 0.9) across clients. Preview first; execute with confirmToken. Max 1000.",
    body: z.object({
      clientIds: z.array(Id).max(50).optional(),
      minConfidence: z.number().min(0.9).max(1).default(0.97),
      limit: z.number().int().min(1).max(1000).default(500),
      confirmToken: z.string().max(64).optional(),
    }),
    response: z.object({
      executed: z.boolean(),
      eligible: z.number(),
      approved: z.number(),
      byClient: z.record(z.string(), z.number()),
      confirmToken: z.string(),
    }),
  }),
  async (c) => {
    const b = c.req.valid("json");
    const p = c.get("practice");
    if (!SIGNER_SET.has(p.role)) throw forbidden("Bulk approval needs a reviewer, manager or partner");
    const pdb = practiceDb(c);
    const args: unknown[] = [b.minConfidence];
    let filter = "";
    if (b.clientIds?.length) {
      filter = ` and t.tenant_id in (${b.clientIds.map((_, i) => `?${i + 4}`).join(", ")})`;
      args.push(...b.clientIds);
    }
    const rows = await pdb.all<TxnRow & { tenant_id: string }>(
      `select t.tenant_id, t.id, t.category_code, t.confidence, t.status, t.reviewed_at, t.vat_rate_code, t.vat_pence from transactions t
       where t.tenant_id in (${clientScopeSql(p.role)}) and t.reviewed_at is null and t.category_code is not null and t.category_code != '9999'
       and t.status != 'needs_review' and t.confidence >= ?3${filter} order by t.created_at, t.id limit ${b.limit}`,
      ...args,
    );
    const byClient: Record<string, number> = {};
    for (const r of rows) byClient[r.tenant_id] = (byClient[r.tenant_id] ?? 0) + 1;
    const token = B.bulkConfirmToken(
      `bulk-approve:${b.minConfidence}`,
      rows.map((r) => `${r.tenant_id}/${r.id}`),
      rows.length,
    );
    if (!b.confirmToken) return c.json({ executed: false, eligible: rows.length, approved: 0, byClient, confirmToken: token }, 200);
    if (b.confirmToken !== token) throw conflict("confirmToken does not match the current preview (the queue changed); preview again");
    const audit = new PracticeAudit(pdb);
    let approved = 0;
    for (const [tid, n] of Object.entries(byClient)) {
      const tdb = new TenantDb(c.env.DB, tid);
      const outbox = new Outbox(tdb);
      const stmts = rows.filter((r) => r.tenant_id === tid).flatMap((r) => approveStmts({ pdb, tdb, outbox }, r, r.category_code!, "bulk"));
      const changed = await pdb.batch([
        ...stmts,
        ...outbox.stmts.splice(0),
        await audit.stmt("review.bulk_approved", null, tid, { count: n, minConfidence: b.minConfidence }),
      ]);
      approved += changed.filter((_, i) => i % 3 === 0 && i < stmts.length).reduce((a, x) => a + x, 0);
      await outbox.publish(c.env);
    }
    return c.json({ executed: true, eligible: rows.length, approved, byClient, confirmToken: token }, 200);
  },
);

work.openapi(
  def({
    method: "post",
    path: "/practice/review/claim",
    tag: "Practice workflow",
    summary: "Claim review items for yourself or assign them to a colleague (managers may assign to others)",
    body: z.object({
      items: z
        .array(z.object({ clientId: Id, transactionId: Id }))
        .min(1)
        .max(500),
      assignee: z.string().email().max(200).optional(),
      release: z.boolean().default(false),
    }),
    response: z.object({ claimed: z.number(), assignee: z.string().nullable() }),
  }),
  async (c) => {
    const b = c.req.valid("json");
    const p = c.get("practice");
    const pdb = practiceDb(c);
    const assignee = (b.assignee ?? p.email).toLowerCase();
    if (assignee !== p.email && !MANAGERS.includes(p.role)) throw forbidden("Only partners and managers can assign work to others");
    if (!b.release) await assertAssignable(pdb, [{ email: assignee, role: "preparer" }]);
    const client = clientCache(pdb, p.role);
    const stmts: D1PreparedStatement[] = [];
    for (const it of b.items) {
      await client(it.clientId);
      stmts.push(
        b.release
          ? pdb.stmt("delete from review_claims where practice_id = ?1 and tenant_id = ?3 and transaction_id = ?4", it.clientId, it.transactionId)
          : pdb.stmt(
              `insert into review_claims (practice_id, tenant_id, transaction_id, assignee, claimed_at)
               select ?1, ?3, t.id, ?5, ?6 from transactions t where t.tenant_id = ?3 and t.id = ?4 and t.reviewed_at is null
               on conflict (tenant_id, transaction_id) do update set assignee = excluded.assignee, claimed_at = excluded.claimed_at`,
              it.clientId,
              it.transactionId,
              assignee,
              monotonicIso(),
            ),
      );
    }
    const n = (await pdb.batch(stmts)).reduce((a, x) => a + x, 0);
    return c.json({ claimed: n, assignee: b.release ? null : assignee }, 200);
  },
);

// ---------------- auto-approve rules + QA sampling ----------------
work.use("/practice/clients/:id/auto-approve", requirePracticeRole(...MANAGERS));
work.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/auto-approve",
    tag: "Practice workflow",
    summary: "Apply the client's auto-approve policy (allowlisted categories at >= threshold, floor 0.9) and QA-sample the result",
    params: z.object({ id: Id }),
    body: z.object({ dryRun: z.boolean().default(true), seed: z.string().max(40).optional() }),
    response: z.object({
      dryRun: z.boolean(),
      considered: z.number(),
      approved: z.number(),
      sampledForQa: z.number(),
      decisions: z.array(z.object({ transactionId: z.string(), approve: z.boolean(), reason: z.string() })),
    }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    const cl = await accessibleClient(pdb, c.get("practice").role, id);
    const policy = B.parsePolicy(cl.auto_approve_json);
    const tdb = new TenantDb(c.env.DB, id);
    const rows = await tdb.all<TxnRow>(
      "select id, category_code, confidence, status, reviewed_at, vat_rate_code, vat_pence from transactions where tenant_id = ?1 and reviewed_at is null order by created_at, id limit 2000",
    );
    const decisions = rows.map((r) => ({
      transactionId: r.id,
      ...B.autoApproveDecision({ id: r.id, categoryCode: r.category_code, confidence: r.confidence, status: r.status }, policy),
    }));
    const ok = rows.filter((_, i) => decisions[i]!.approve);
    const sample = new Set(
      B.qaSample(
        ok.map((r) => r.id),
        cl.qa_sample_rate,
        b.seed ?? today(),
      ),
    );
    if (!b.dryRun && ok.length) {
      const outbox = new Outbox(tdb);
      const audit = new PracticeAudit(pdb);
      await pdb.batch([
        ...ok.flatMap((r) => approveStmts({ pdb, tdb, outbox }, r, r.category_code!, "auto_rule", sample.has(r.id))),
        ...outbox.stmts.splice(0),
        await audit.stmt("review.auto_approved", null, id, { count: ok.length, sampled: sample.size, policy }),
      ]);
      await outbox.publish(c.env);
    }
    return c.json({ dryRun: b.dryRun, considered: rows.length, approved: ok.length, sampledForQa: sample.size, decisions: decisions.slice(0, 200) }, 200);
  },
);

work.openapi(
  def({
    method: "get",
    path: "/practice/qa",
    tag: "Practice workflow",
    summary: "Auto-approved items sampled for QA and not yet checked, plus the QA pass rate so far",
    query: z.object({ clientId: Id.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
    response: z.object({
      items: z.array(
        z.object({
          tenantId: z.string(),
          transactionId: z.string(),
          description: z.string().nullable(),
          amountPence: z.number(),
          categoryCode: z.string().nullable(),
        }),
      ),
      checked: z.number(),
      failed: z.number(),
      passRate: z.number().nullable(),
    }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const pdb = practiceDb(c);
    const scope = clientScopeSql(c.get("practice").role);
    const f = q.clientId ? " and t.tenant_id = ?3" : "";
    const args = q.clientId ? [q.clientId] : [];
    const items = await pdb.all<{ tenant_id: string; id: string; description: string | null; amount_pence: number; category_code: string | null }>(
      `select t.tenant_id, t.id, t.description, t.amount_pence, t.category_code from transactions t where t.tenant_id in (${scope}) and t.qa_sample = 1 and t.qa_result is null${f} order by t.reviewed_at limit ${q.limit}`,
      ...args,
    );
    const stats = await pdb.first<{ checked: number; failed: number }>(
      `select count(*) checked, sum(case when t.qa_result = 'fail' then 1 else 0 end) failed from transactions t where t.tenant_id in (${scope}) and t.qa_result is not null${f}`,
      ...args,
    );
    const checked = stats?.checked ?? 0;
    const failed = stats?.failed ?? 0;
    return c.json(
      {
        items: items.map((r) => ({
          tenantId: r.tenant_id,
          transactionId: r.id,
          description: r.description,
          amountPence: r.amount_pence,
          categoryCode: r.category_code,
        })),
        checked,
        failed,
        passRate: checked ? Math.round(((checked - failed) / checked) * 1000) / 1000 : null,
      },
      200,
    );
  },
);
work.use("/practice/qa/*", requirePracticeRole(...SIGNERS));
work.openapi(
  def({
    method: "post",
    path: "/practice/qa/{clientId}/{transactionId}",
    tag: "Practice workflow",
    summary: "Record a QA check of an auto-approved item; a fail must give the correct category (recategorises + logs)",
    params: z.object({ clientId: Id, transactionId: Id }),
    body: z.object({
      result: z.enum(["pass", "fail"]),
      categoryCode: z
        .string()
        .regex(/^\d{4}$/)
        .optional(),
    }),
    response: z.object({ result: z.enum(["pass", "fail"]) }),
  }),
  async (c) => {
    const { clientId, transactionId } = c.req.valid("param");
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, clientId);
    const tdb = new TenantDb(c.env.DB, clientId);
    const t = await tdb.first<TxnRow & { qa_sample: number; qa_result: string | null; vat_rate_code: string | null }>(
      "select id, category_code, confidence, status, reviewed_at, vat_rate_code, vat_pence, qa_sample, qa_result from transactions where tenant_id = ?1 and id = ?2",
      transactionId,
    );
    if (!t || !t.qa_sample) throw notFound("QA sample");
    if (t.qa_result) throw conflict("Already QA-checked");
    if (b.result === "fail" && (!b.categoryCode || b.categoryCode === t.category_code))
      throw badRequest("A failed QA check needs the correct (different) categoryCode");
    const outbox = new Outbox(tdb);
    const log = pdb.stmt(
      "insert into review_log (practice_id, tenant_id, id, transaction_id, ai_category_code, ai_confidence, final_category_code, method, reviewed_by, reviewed_at) values (?1, ?3, ?4, ?5, ?6, ?7, ?8, 'qa', ?2, ?9)",
      clientId,
      newId(),
      t.id,
      t.category_code,
      t.confidence,
      b.result === "fail" ? b.categoryCode : t.category_code,
      monotonicIso(),
    );
    const mark = tdb.stmt("update transactions set qa_result = ?3 where tenant_id = ?1 and id = ?2", t.id, b.result);
    if (b.result === "fail")
      await categoriseTransaction(tdb, pdb.email, t.id, b.categoryCode!, t.vat_rate_code, t.vat_pence ?? 0, {
        outbox,
        method: "practice_qa",
        extra: [mark, log],
      });
    else await tdb.batch([mark, log, auditStmt(tdb, pdb.email, "review.qa_passed", t.id)]);
    await outbox.publish(c.env);
    return c.json({ result: b.result }, 200);
  },
);

// ---------------- close templates + checklists ----------------
const TemplateItem = z.object({ title: z.string().min(1).max(200), required: z.boolean().default(true) });
const Template = z.object({ id: z.string(), name: z.string(), kind: z.enum(["month", "quarter", "year"]), items: z.array(TemplateItem) });
work.openapi(
  def({
    method: "get",
    path: "/practice/close-templates",
    tag: "Practice workflow",
    summary: "Close checklist templates",
    response: z.object({ items: z.array(Template) }),
  }),
  async (c) => {
    const rows = await practiceDb(c).all<{ id: string; name: string; kind: "month" | "quarter" | "year"; items_json: string }>(
      "select id, name, kind, items_json from close_templates where practice_id = ?1 order by kind, name",
    );
    return c.json({ items: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, items: JSON.parse(r.items_json) })) }, 200);
  },
);
work.use("/practice/close-templates", async (c, next) => (c.req.method === "GET" ? next() : requirePracticeRole(...MANAGERS)(c, next)));
work.openapi(
  def({
    method: "post",
    path: "/practice/close-templates",
    tag: "Practice workflow",
    summary: "Create a close checklist template (partner/manager)",
    body: z.object({ name: z.string().min(1).max(120), kind: z.enum(["month", "quarter", "year"]), items: z.array(TemplateItem).min(1).max(60) }),
    response: Template,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const id = newId();
    await practiceDb(c).run(
      "insert into close_templates (practice_id, id, name, kind, items_json) values (?1, ?3, ?4, ?5, ?6)",
      id,
      b.name,
      b.kind,
      JSON.stringify(b.items),
    );
    return c.json({ id, ...b }, 201);
  },
);

const Checklist = z.object({
  id: z.string(),
  tenantId: z.string(),
  client: z.string(),
  name: z.string(),
  kind: z.string(),
  periodEnd: z.string(),
  status: z.string(),
  done: z.number(),
  total: z.number(),
  completedBy: z.string().nullable(),
});
work.use("/practice/clients/:id/checklists", async (c, next) =>
  c.req.method === "GET" ? next() : requirePracticeRole(...MANAGERS, "reviewer", "preparer")(c, next),
);
work.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/checklists",
    tag: "Practice workflow",
    summary: "Start a close checklist for a client and period from a template",
    params: z.object({ id: Id }),
    body: z.object({ templateId: Id, periodEnd: Day }),
    response: z.object({ id: z.string() }),
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, id);
    const tpl = await pdb.first<{ id: string; name: string; kind: string; items_json: string }>(
      "select id, name, kind, items_json from close_templates where practice_id = ?1 and id = ?3",
      b.templateId,
    );
    if (!tpl) throw notFound("Close template");
    const cid = newId();
    const audit = new PracticeAudit(pdb);
    try {
      await pdb.batch([
        ...checklistStmts(pdb, id, tpl, b.periodEnd, cid),
        await audit.stmt("checklist.created", cid, id, { kind: tpl.kind, periodEnd: b.periodEnd }),
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw conflict("A checklist of that kind already exists for this period");
      throw e;
    }
    return c.json({ id: cid }, 201);
  },
);
work.openapi(
  def({
    method: "get",
    path: "/practice/checklists",
    tag: "Practice workflow",
    summary: "Close checklists across my clients",
    query: z.object({ status: z.enum(["open", "complete"]).optional(), clientId: Id.optional() }),
    response: z.object({ items: z.array(Checklist) }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const args: unknown[] = [];
    let f = "";
    if (q.status) {
      args.push(q.status);
      f += ` and k.status = ?${args.length + 2}`;
    }
    if (q.clientId) {
      args.push(q.clientId);
      f += ` and k.tenant_id = ?${args.length + 2}`;
    }
    const rows = await practiceDb(c).all<{
      id: string;
      tenant_id: string;
      client: string;
      name: string;
      kind: string;
      period_end: string;
      status: string;
      done: number;
      total: number;
      completed_by: string | null;
    }>(
      `select k.id, k.tenant_id, pc.name client, k.name, k.kind, k.period_end, k.status, k.completed_by,
        (select count(*) from close_items i where i.checklist_id = k.id and i.done_at is not null) done, (select count(*) from close_items i where i.checklist_id = k.id) total
       from close_checklists k join practice_clients pc on pc.practice_id = ?1 and pc.tenant_id = k.tenant_id
       where k.practice_id = ?1 and k.tenant_id in (${clientScopeSql(c.get("practice").role)})${f} order by k.period_end, pc.name limit 1000`,
      ...args,
    );
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          client: r.client,
          name: r.name,
          kind: r.kind,
          periodEnd: r.period_end,
          status: r.status,
          done: r.done,
          total: r.total,
          completedBy: r.completed_by,
        })),
      },
      200,
    );
  },
);
const ChecklistDetail = Checklist.extend({
  items: z.array(
    z.object({
      idx: z.number(),
      title: z.string(),
      required: z.boolean(),
      doneBy: z.string().nullable(),
      doneAt: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
  evidence: z.object({ awaitingReview: z.number(), openQueries: z.number(), openExceptions: z.number() }),
});
async function loadChecklist(c: C, id: string) {
  const pdb = practiceDb(c);
  const k = await pdb.first<{
    id: string;
    tenant_id: string;
    client: string;
    name: string;
    kind: string;
    period_end: string;
    status: string;
    completed_by: string | null;
  }>(
    `select k.id, k.tenant_id, pc.name client, k.name, k.kind, k.period_end, k.status, k.completed_by from close_checklists k
     join practice_clients pc on pc.practice_id = ?1 and pc.tenant_id = k.tenant_id where k.practice_id = ?1 and k.id = ?3 and k.tenant_id in (${clientScopeSql(c.get("practice").role)})`,
    id,
  );
  if (!k) throw notFound("Checklist");
  return { pdb, k };
}
work.openapi(
  def({
    method: "get",
    path: "/practice/checklists/{id}",
    tag: "Practice workflow",
    summary: "Checklist with items and live evidence (review backlog, open queries, exceptions up to the period end)",
    params: z.object({ id: Id }),
    response: ChecklistDetail,
  }),
  async (c) => {
    const { pdb, k } = await loadChecklist(c, c.req.valid("param").id);
    const items = await pdb.all<{ idx: number; title: string; required: number; done_by: string | null; done_at: string | null; note: string | null }>(
      "select idx, title, required, done_by, done_at, note from close_items where practice_id = ?1 and checklist_id = ?3 order by idx",
      k.id,
    );
    const tdb = new TenantDb(c.env.DB, k.tenant_id);
    const n = async (sql: string, ...a: unknown[]) => (await tdb.first<{ n: number }>(sql, ...a))?.n ?? 0;
    const evidence = {
      awaitingReview: await n("select count(*) n from transactions where tenant_id = ?1 and reviewed_at is null and txn_date <= ?2", k.period_end),
      openQueries:
        (await pdb.first<{ n: number }>("select count(*) n from client_queries where practice_id = ?1 and tenant_id = ?3 and status = 'open'", k.tenant_id))
          ?.n ?? 0,
      openExceptions: await n("select count(*) n from exceptions where tenant_id = ?1 and status = 'open'"),
    };
    return c.json(
      {
        id: k.id,
        tenantId: k.tenant_id,
        client: k.client,
        name: k.name,
        kind: k.kind,
        periodEnd: k.period_end,
        status: k.status,
        completedBy: k.completed_by,
        done: items.filter((i) => i.done_at).length,
        total: items.length,
        items: items.map((i) => ({ idx: i.idx, title: i.title, required: !!i.required, doneBy: i.done_by, doneAt: i.done_at, note: i.note })),
        evidence,
      },
      200,
    );
  },
);
work.openapi(
  def({
    method: "post",
    path: "/practice/checklists/{id}/items/{idx}",
    tag: "Practice workflow",
    summary: "Tick or untick a checklist item (not on a completed checklist)",
    params: z.object({ id: Id, idx: z.coerce.number().int().min(0).max(200) }),
    body: z.object({ done: z.boolean(), note: z.string().max(1000).nullable().default(null) }),
    response: z.object({ idx: z.number(), done: z.boolean() }),
  }),
  async (c) => {
    const { id, idx } = c.req.valid("param");
    const b = c.req.valid("json");
    const { pdb, k } = await loadChecklist(c, id);
    if (k.status === "complete") throw conflict("Checklist is complete and locked");
    const n = await pdb.run(
      "update close_items set done_by = ?5, done_at = ?6, note = coalesce(?7, note) where practice_id = ?1 and checklist_id = ?3 and idx = ?4",
      id,
      idx,
      b.done ? pdb.email : null,
      b.done ? monotonicIso() : null,
      b.note,
    );
    if (!n) throw notFound("Checklist item");
    return c.json({ idx, done: b.done }, 200);
  },
);
work.use("/practice/checklists/:id/complete", requirePracticeRole(...SIGNERS));
work.openapi(
  def({
    method: "post",
    path: "/practice/checklists/{id}/complete",
    tag: "Practice workflow",
    summary: "Complete and lock a checklist (reviewer/manager/partner; all required items done; no items awaiting review in the period)",
    params: z.object({ id: Id }),
    body: z.object({ note: z.string().max(1000).optional() }),
    response: z.object({ status: z.literal("complete") }),
  }),
  async (c) => {
    const { pdb, k } = await loadChecklist(c, c.req.valid("param").id);
    if (k.status === "complete") throw conflict("Already complete");
    const missing = await pdb.all<{ title: string }>(
      "select title from close_items where practice_id = ?1 and checklist_id = ?3 and required = 1 and done_at is null",
      k.id,
    );
    if (missing.length) throw new AppError(409, "conflict", "Required items are not done", { missing: missing.map((m) => m.title) });
    const tdb = new TenantDb(c.env.DB, k.tenant_id);
    const awaiting =
      (await tdb.first<{ n: number }>("select count(*) n from transactions where tenant_id = ?1 and reviewed_at is null and txn_date <= ?2", k.period_end))
        ?.n ?? 0;
    if (awaiting) throw new AppError(409, "conflict", `${awaiting} item(s) in the period still await review`, { awaiting });
    const outbox = new Outbox(tdb);
    outbox.add("checklist.completed", { checklistId: k.id, kind: k.kind, periodEnd: k.period_end, by: pdb.email }, pdb.email);
    const audit = new PracticeAudit(pdb);
    await pdb.batch([
      pdb.stmt(
        "update close_checklists set status = 'complete', completed_by = ?2, completed_at = ?4 where practice_id = ?1 and id = ?3 and status = 'open'",
        k.id,
        monotonicIso(),
      ),
      await audit.stmt("checklist.completed", k.id, k.tenant_id, { note: c.req.valid("json").note ?? null }),
      auditStmt(tdb, pdb.email, "checklist.completed", k.id),
      ...outbox.stmts,
    ]);
    await outbox.publish(c.env);
    return c.json({ status: "complete" as const }, 200);
  },
);

// ---------------- client queries (answered in the portal; events only, never emailed) ----------------
const Query = z.object({
  id: z.string(),
  tenantId: z.string(),
  client: z.string(),
  transactionId: z.string().nullable(),
  question: z.string(),
  status: z.string(),
  askedBy: z.string(),
  askedAt: z.string(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
});
work.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/queries",
    tag: "Practice workflow",
    summary: "Ask the client a question, optionally about a transaction (shows in their portal; emits query.raised; no email)",
    params: z.object({ id: Id }),
    body: z.object({ question: z.string().min(3).max(2000), transactionId: Id.optional() }),
    response: z.object({ id: z.string() }),
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, id);
    const tdb = new TenantDb(c.env.DB, id);
    if (b.transactionId && !(await tdb.first("select id from transactions where tenant_id = ?1 and id = ?2", b.transactionId))) throw notFound("Transaction");
    const qid = newId();
    const outbox = new Outbox(tdb);
    outbox.add("query.raised", { queryId: qid, transactionId: b.transactionId ?? null, question: b.question }, pdb.email);
    const audit = new PracticeAudit(pdb);
    await pdb.batch([
      pdb.stmt(
        "insert into client_queries (practice_id, id, tenant_id, transaction_id, question, asked_by, asked_at) values (?1, ?3, ?4, ?5, ?6, ?2, ?7)",
        qid,
        id,
        b.transactionId ?? null,
        b.question,
        monotonicIso(),
      ),
      await audit.stmt("query.raised", qid, id),
      ...outbox.stmts,
    ]);
    await outbox.publish(c.env);
    return c.json({ id: qid }, 201);
  },
);
work.openapi(
  def({
    method: "get",
    path: "/practice/queries",
    tag: "Practice workflow",
    summary: "Client queries across my clients",
    query: z.object({ status: z.enum(["open", "answered", "closed"]).optional(), clientId: Id.optional() }),
    response: z.object({ items: z.array(Query) }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const args: unknown[] = [];
    let f = "";
    if (q.status) {
      args.push(q.status);
      f += ` and q.status = ?${args.length + 2}`;
    }
    if (q.clientId) {
      args.push(q.clientId);
      f += ` and q.tenant_id = ?${args.length + 2}`;
    }
    const rows = await practiceDb(c).all<{
      id: string;
      tenant_id: string;
      client: string;
      transaction_id: string | null;
      question: string;
      status: string;
      asked_by: string;
      asked_at: string;
      answer: string | null;
      answered_at: string | null;
    }>(
      `select q.id, q.tenant_id, pc.name client, q.transaction_id, q.question, q.status, q.asked_by, q.asked_at, q.answer, q.answered_at from client_queries q
       join practice_clients pc on pc.practice_id = ?1 and pc.tenant_id = q.tenant_id where q.practice_id = ?1 and q.tenant_id in (${clientScopeSql(c.get("practice").role)})${f}
       order by q.asked_at desc limit 1000`,
      ...args,
    );
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          client: r.client,
          transactionId: r.transaction_id,
          question: r.question,
          status: r.status,
          askedBy: r.asked_by,
          askedAt: r.asked_at,
          answer: r.answer,
          answeredAt: r.answered_at,
        })),
      },
      200,
    );
  },
);
work.openapi(
  def({
    method: "post",
    path: "/practice/queries/{id}/close",
    tag: "Practice workflow",
    summary: "Close a query (after the client answered, or to withdraw it)",
    params: z.object({ id: Id }),
    response: z.object({ status: z.literal("closed") }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const pdb = practiceDb(c);
    const audit = new PracticeAudit(pdb);
    const q = await pdb.first<{ tenant_id: string }>(
      `select tenant_id from client_queries where practice_id = ?1 and id = ?3 and status != 'closed' and tenant_id in (${clientScopeSql(c.get("practice").role)})`,
      id,
    );
    if (!q) throw notFound("Open query");
    await pdb.batch([
      pdb.stmt("update client_queries set status = 'closed', closed_by = ?2, closed_at = ?4 where practice_id = ?1 and id = ?3", id, monotonicIso()),
      await audit.stmt("query.closed", id, q.tenant_id),
    ]);
    return c.json({ status: "closed" as const }, 200);
  },
);

// ---------------- task templates + tasks ----------------
const TaskTemplate = z.object({
  id: z.string(),
  name: z.string(),
  recurrence: z.enum(["monthly", "quarterly", "yearly"]),
  dueDay: z.number(),
  defaultRole: z.enum(["preparer", "reviewer"]).nullable(),
});
work.openapi(
  def({
    method: "get",
    path: "/practice/task-templates",
    tag: "Practice workflow",
    summary: "Recurring work templates",
    response: z.object({ items: z.array(TaskTemplate) }),
  }),
  async (c) => {
    const rows = await practiceDb(c).all<{
      id: string;
      name: string;
      recurrence: "monthly" | "quarterly" | "yearly";
      due_day: number;
      default_role: "preparer" | "reviewer" | null;
    }>("select id, name, recurrence, due_day, default_role from task_templates where practice_id = ?1 order by name");
    return c.json({ items: rows.map((r) => ({ id: r.id, name: r.name, recurrence: r.recurrence, dueDay: r.due_day, defaultRole: r.default_role })) }, 200);
  },
);
work.use("/practice/task-templates", async (c, next) => (c.req.method === "GET" ? next() : requirePracticeRole(...MANAGERS)(c, next)));
work.openapi(
  def({
    method: "post",
    path: "/practice/task-templates",
    tag: "Practice workflow",
    summary: "Create a recurring work template (partner/manager)",
    body: z.object({
      name: z.string().min(1).max(120),
      recurrence: z.enum(["monthly", "quarterly", "yearly"]),
      dueDay: z.number().int().min(1).max(28).default(28),
      defaultRole: z.enum(["preparer", "reviewer"]).nullable().default(null),
    }),
    response: TaskTemplate,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const id = newId();
    await practiceDb(c).run(
      "insert into task_templates (practice_id, id, name, recurrence, due_day, default_role) values (?1, ?3, ?4, ?5, ?6, ?7)",
      id,
      b.name,
      b.recurrence,
      b.dueDay,
      b.defaultRole,
    );
    return c.json({ id, ...b }, 201);
  },
);
/** Does a template recur in `month` (1-12) for a client whose year ends in `yearEndMonth`? Quarterly = Mar/Jun/Sep/Dec. */
const recursIn = (recurrence: string, month: number, yearEndMonth: number) =>
  recurrence === "monthly" || (recurrence === "quarterly" && month % 3 === 0) || (recurrence === "yearly" && month === yearEndMonth);
work.use("/practice/tasks/generate", requirePracticeRole(...MANAGERS));
work.openapi(
  def({
    method: "post",
    path: "/practice/tasks/generate",
    tag: "Practice workflow",
    summary: "Generate this month's recurring tasks for all active clients (idempotent per template, client and due date)",
    body: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
    response: z.object({ created: z.number(), considered: z.number() }),
  }),
  async (c) => {
    const { month } = c.req.valid("json");
    const pdb = practiceDb(c);
    const m = Number(month.slice(5));
    const tpls = await pdb.all<{ id: string; name: string; recurrence: string; due_day: number; default_role: string | null }>(
      "select id, name, recurrence, due_day, default_role from task_templates where practice_id = ?1",
    );
    const clients = await pdb.all<{ tenant_id: string; year_end: string; name: string }>(
      "select tenant_id, year_end, name from practice_clients where practice_id = ?1 and status = 'active'",
    );
    const assign = await pdb.all<{ tenant_id: string; email: string; role: string }>(
      "select tenant_id, email, role from client_assignments where practice_id = ?1 order by email",
    );
    const stmts: D1PreparedStatement[] = [];
    for (const t of tpls)
      for (const cl of clients) {
        if (!recursIn(t.recurrence, m, Number(cl.year_end.slice(0, 2)))) continue;
        const who = t.default_role ? (assign.find((a) => a.tenant_id === cl.tenant_id && a.role === t.default_role)?.email ?? null) : null;
        stmts.push(
          pdb.stmt(
            "insert or ignore into tasks (practice_id, id, tenant_id, template_id, title, due_date, assignee) values (?1, ?3, ?4, ?5, ?6, ?7, ?8)",
            newId(),
            cl.tenant_id,
            t.id,
            `${t.name} — ${cl.name}`,
            `${month}-${String(t.due_day).padStart(2, "0")}`,
            who,
          ),
        );
      }
    const created = (await pdb.batch(stmts)).reduce((a, x) => a + x, 0);
    return c.json({ created, considered: stmts.length }, 200);
  },
);
const Task = z.object({
  id: z.string(),
  tenantId: z.string(),
  title: z.string(),
  dueDate: z.string(),
  assignee: z.string().nullable(),
  status: z.string(),
  overdue: z.boolean(),
});
work.openapi(
  def({
    method: "get",
    path: "/practice/tasks",
    tag: "Practice workflow",
    summary: "Tasks across my clients",
    query: z.object({
      status: z.enum(["todo", "doing", "done"]).optional(),
      assignee: z.string().max(200).optional(),
      clientId: Id.optional(),
      asOf: Day.optional(),
    }),
    response: z.object({ items: z.array(Task) }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const args: unknown[] = [];
    let f = "";
    if (q.status) {
      args.push(q.status);
      f += ` and k.status = ?${args.length + 2}`;
    }
    if (q.assignee) {
      args.push(q.assignee.toLowerCase());
      f += ` and k.assignee = ?${args.length + 2}`;
    }
    if (q.clientId) {
      args.push(q.clientId);
      f += ` and k.tenant_id = ?${args.length + 2}`;
    }
    const asOf = q.asOf ?? today();
    const rows = await practiceDb(c).all<{ id: string; tenant_id: string; title: string; due_date: string; assignee: string | null; status: string }>(
      `select k.id, k.tenant_id, k.title, k.due_date, k.assignee, k.status from tasks k where k.practice_id = ?1 and k.tenant_id in (${clientScopeSql(c.get("practice").role)})${f} order by k.due_date, k.title limit 2000`,
      ...args,
    );
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          title: r.title,
          dueDate: r.due_date,
          assignee: r.assignee,
          status: r.status,
          overdue: r.status !== "done" && r.due_date < asOf,
        })),
      },
      200,
    );
  },
);
work.openapi(
  def({
    method: "patch",
    path: "/practice/tasks/{id}",
    tag: "Practice workflow",
    summary: "Update a task's status or assignee (assigning others needs partner/manager)",
    params: z.object({ id: Id }),
    body: z.object({ status: z.enum(["todo", "doing", "done"]).optional(), assignee: z.string().email().max(200).nullable().optional() }),
    response: z.object({ id: z.string(), status: z.string(), assignee: z.string().nullable() }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const p = c.get("practice");
    const pdb = practiceDb(c);
    const t = await pdb.first<{ status: string; assignee: string | null }>(
      `select status, assignee from tasks where practice_id = ?1 and id = ?3 and tenant_id in (${clientScopeSql(p.role)})`,
      id,
    );
    if (!t) throw notFound("Task");
    if (b.assignee !== undefined && b.assignee?.toLowerCase() !== p.email && !MANAGERS.includes(p.role))
      throw forbidden("Only partners and managers can assign tasks to others");
    if (b.assignee) await assertAssignable(pdb, [{ email: b.assignee.toLowerCase(), role: "preparer" }]);
    const status = b.status ?? t.status;
    const assignee = b.assignee === undefined ? t.assignee : (b.assignee?.toLowerCase() ?? null);
    await pdb.run(
      "update tasks set status = ?4, assignee = ?5, done_at = case when ?4 = 'done' then coalesce(done_at, ?6) else null end where practice_id = ?1 and id = ?3",
      id,
      status,
      assignee,
      monotonicIso(),
    );
    return c.json({ id, status, assignee }, 200);
  },
);

// ---------------- time + billing records (internal only) ----------------
work.openapi(
  def({
    method: "post",
    path: "/practice/time",
    tag: "Practice billing",
    summary: "Record time against a client (internal)",
    body: z.object({
      clientId: Id,
      minutes: z.number().int().min(1).max(1440),
      date: Day,
      note: z.string().max(500).nullable().default(null),
      billable: z.boolean().default(true),
    }),
    response: z.object({ id: z.string() }),
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, b.clientId);
    const id = newId();
    await pdb.run(
      "insert into time_entries (practice_id, id, tenant_id, email, minutes, entry_date, note, billable) values (?1, ?3, ?4, ?2, ?5, ?6, ?7, ?8)",
      id,
      b.clientId,
      b.minutes,
      b.date,
      b.note,
      b.billable ? 1 : 0,
    );
    return c.json({ id }, 201);
  },
);
work.openapi(
  def({
    method: "get",
    path: "/practice/time",
    tag: "Practice billing",
    summary: "Time entries (mine, or everyone's for partners/managers)",
    query: z.object({ clientId: Id.optional(), from: Day.optional(), to: Day.optional() }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          tenantId: z.string(),
          email: z.string(),
          minutes: z.number(),
          date: z.string(),
          note: z.string().nullable(),
          billable: z.boolean(),
          billed: z.boolean(),
        }),
      ),
      totalMinutes: z.number(),
    }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const p = c.get("practice");
    const args: unknown[] = [];
    let f = MANAGERS.includes(p.role) ? "" : " and email = ?2";
    if (q.clientId) {
      args.push(q.clientId);
      f += ` and tenant_id = ?${args.length + 2}`;
    }
    if (q.from) {
      args.push(q.from);
      f += ` and entry_date >= ?${args.length + 2}`;
    }
    if (q.to) {
      args.push(q.to);
      f += ` and entry_date <= ?${args.length + 2}`;
    }
    const rows = await practiceDb(c).all<{
      id: string;
      tenant_id: string;
      email: string;
      minutes: number;
      entry_date: string;
      note: string | null;
      billable: number;
      billing_record_id: string | null;
    }>(
      `select id, tenant_id, email, minutes, entry_date, note, billable, billing_record_id from time_entries where practice_id = ?1 and tenant_id in (${clientScopeSql(p.role)})${f} order by entry_date desc limit 2000`,
      ...args,
    );
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          email: r.email,
          minutes: r.minutes,
          date: r.entry_date,
          note: r.note,
          billable: !!r.billable,
          billed: !!r.billing_record_id,
        })),
        totalMinutes: rows.reduce((n, r) => n + r.minutes, 0),
      },
      200,
    );
  },
);
work.use("/practice/billing/*", requirePracticeRole(...MANAGERS));
work.openapi(
  def({
    method: "get",
    path: "/practice/billing/wip",
    tag: "Practice billing",
    summary: "Work in progress and billing-ready clients (internal valuation; nothing is invoiced or charged)",
    query: z.object({ asOf: Day.optional() }),
    response: z.object({
      items: z.array(
        z.object({
          tenantId: z.string(),
          client: z.string(),
          feeModel: z.string(),
          unbilledMinutes: z.number(),
          outcomes: z.number(),
          months: z.number(),
          wipPence: z.number(),
          billingReady: z.boolean(),
        }),
      ),
      totalPence: z.number(),
    }),
  }),
  async (c) => {
    const rows = await wipByClient(practiceDb(c), clientScopeSql(c.get("practice").role), c.req.valid("query").asOf ?? today());
    return c.json({ items: rows.map(({ since: _s, ...r }) => r), totalPence: rows.reduce((n, r) => n + r.wipPence, 0) }, 200);
  },
);
work.openapi(
  def({
    method: "post",
    path: "/practice/billing/records",
    tag: "Practice billing",
    summary: "Turn a client's WIP into an internal billing record (marks the time as billed). Not an invoice; nothing is sent.",
    body: z.object({ clientId: Id, periodEnd: Day }),
    response: z.object({ id: z.string(), amountPence: z.number(), kind: z.string() }),
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    const cl = await accessibleClient(pdb, c.get("practice").role, b.clientId);
    const [w] = (await wipByClient(pdb, clientScopeSql(c.get("practice").role), b.periodEnd)).filter((x) => x.tenantId === b.clientId);
    if (!w || !w.billingReady) throw conflict("Nothing to bill for this client and period");
    if (monthsBetween(w.since, b.periodEnd) < 0) throw badRequest("periodEnd is before the last billing record");
    const id = newId();
    const audit = new PracticeAudit(pdb);
    const desc =
      cl.fee_model === "hourly"
        ? `${w.unbilledMinutes} minutes at the hourly rate`
        : cl.fee_model === "fixed"
          ? `${w.months} month(s) fixed fee`
          : `${w.outcomes} completed close(s)`;
    await pdb.batch([
      pdb.stmt(
        "insert into billing_records (practice_id, id, tenant_id, kind, description, amount_pence, period_end, created_by) values (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?2)",
        id,
        b.clientId,
        cl.fee_model,
        desc,
        w.wipPence,
        b.periodEnd,
      ),
      pdb.stmt(
        "update time_entries set billing_record_id = ?4 where practice_id = ?1 and tenant_id = ?3 and billable = 1 and billing_record_id is null",
        b.clientId,
        id,
      ),
      await audit.stmt("billing.record_created", id, b.clientId, { amountPence: w.wipPence, kind: cl.fee_model }),
    ]);
    return c.json({ id, amountPence: w.wipPence, kind: cl.fee_model }, 201);
  },
);
work.openapi(
  def({
    method: "get",
    path: "/practice/billing/records",
    tag: "Practice billing",
    summary: "Internal billing records",
    query: z.object({ clientId: Id.optional() }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          tenantId: z.string(),
          kind: z.string(),
          description: z.string(),
          amountPence: z.number(),
          periodEnd: z.string(),
          status: z.string(),
        }),
      ),
    }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const rows = await practiceDb(c).all<{
      id: string;
      tenant_id: string;
      kind: string;
      description: string;
      amount_pence: number;
      period_end: string;
      status: string;
    }>(
      `select id, tenant_id, kind, description, amount_pence, period_end, status from billing_records where practice_id = ?1 and tenant_id in (${clientScopeSql(c.get("practice").role)})${q.clientId ? " and tenant_id = ?3" : ""} order by created_at desc limit 1000`,
      ...(q.clientId ? [q.clientId] : []),
    );
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          kind: r.kind,
          description: r.description,
          amountPence: r.amount_pence,
          periodEnd: r.period_end,
          status: r.status,
        })),
      },
      200,
    );
  },
);

// ---------------- practice-side import (bank statements the client sent the firm) ----------------
work.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/imports/bank-csv",
    tag: "Practice workflow",
    summary: "Import a client's bank statement CSV (text/csv body); de-duplicated, then the AI first pass runs",
    params: z.object({ id: Id }),
    response: z.object({ documentId: z.string(), jobId: z.string(), inserted: z.number(), duplicates: z.number(), rejectedRows: z.array(z.unknown()) }),
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, id);
    const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
    if (!["text/csv", "text/plain", "application/csv"].includes(ct))
      throw new AppError(415, "unsupported_media_type", "Send the CSV with content-type text/csv");
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new AppError(413, "payload_too_large", "CSV larger than 2 MB");
    const r = await ingestBankCsv(c.env, new TenantDb(c.env.DB, id), pdb.email, bytes, c.req.header("x-filename"));
    const audit = new PracticeAudit(pdb);
    await pdb.batch([await audit.stmt("client.bank_csv_imported", r.documentId, id, { inserted: r.inserted, duplicates: r.duplicates })]);
    return c.json(r, 201);
  },
);
