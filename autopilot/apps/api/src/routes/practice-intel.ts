/**
 * Practice co-pilot API, part 4: intelligence (ADR 0026). Learned rules with provenance (client or firm-wide), explainable
 * anomaly detection, an accuracy harness over accountant corrections, drift alerts, and a practice assistant grounded in
 * ledger data with citations. Every read is scoped through clientScopeSql/accessibleClient: the assistant can never see
 * a client the staff member cannot.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as B from "@xevrion/books";
import type { AppEnv, PracticeRole } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { monotonicIso } from "../lib/audit.js";
import { conflict, notFound } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import {
  CLIENT_COLS,
  PracticeAudit,
  accessibleClient,
  clientScopeSql,
  practiceDb,
  requirePracticeRole,
  type ClientRow,
  type PracticeDb,
} from "../lib/practice.js";
import { mockLlmRouter, type LlmRouter } from "../services/llm-router.js";
import { MANAGERS, clientSummaries, wipByClient } from "./practice.js";

type C = Context<AppEnv>;
export const intel = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
const Id = z.string().min(1).max(64);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TAG = "Practice intelligence";
const today = () => new Date().toISOString().slice(0, 10);
const yearAgo = (d: string) => B.addDays(d, -365);

// ---------------- learned rules ----------------
const Rule = z.object({
  id: z.string(),
  scope: z.enum(["practice", "client"]),
  tenantId: z.string().nullable(),
  pattern: z.string(),
  categoryCode: z.string(),
  direction: z.string(),
  confidence: z.number(),
  evidence: z.number(),
  conflicting: z.number(),
  clients: z.number(),
  provenance: z.array(z.string()),
  status: z.enum(["active", "disabled"]),
  derivedAt: z.string(),
});
type RuleRow = {
  id: string;
  scope: "practice" | "client";
  tenant_id: string | null;
  pattern: string;
  category_code: string;
  direction: string;
  confidence: number;
  evidence: number;
  conflicting: number;
  clients: number;
  provenance_json: string;
  status: "active" | "disabled";
  derived_at: string;
};
const RULE_COLS = "id, scope, tenant_id, pattern, category_code, direction, confidence, evidence, conflicting, clients, provenance_json, status, derived_at";
const ruleOut = (r: RuleRow) => ({
  id: r.id,
  scope: r.scope,
  tenantId: r.tenant_id,
  pattern: r.pattern,
  categoryCode: r.category_code,
  direction: r.direction,
  confidence: r.confidence,
  evidence: r.evidence,
  conflicting: r.conflicting,
  clients: r.clients,
  provenance: JSON.parse(r.provenance_json) as string[],
  status: r.status,
  derivedAt: r.derived_at,
});
intel.use("/practice/learning/derive", requirePracticeRole(...MANAGERS));
intel.openapi(
  def({
    method: "post",
    path: "/practice/learning/derive",
    tag: TAG,
    summary: "Re-derive learned rules from reviewer corrections. Firm-wide rules need 2+ clients to agree. Disabled rules stay disabled.",
    response: z.object({ practiceRules: z.number(), clientRules: z.number(), corrections: z.number(), updated: z.number(), created: z.number() }),
  }),
  async (c) => {
    const pdb = practiceDb(c);
    const cs = await pdb.all<{
      id: string;
      tenant_id: string;
      description: string | null;
      amount_pence: number;
      final_category_code: string;
      reviewed_at: string;
    }>(
      "select r.id, r.tenant_id, t.description, t.amount_pence, r.final_category_code, r.reviewed_at from review_log r join transactions t on t.id = r.transaction_id and t.tenant_id = r.tenant_id where r.practice_id = ?1 and r.method != 'auto_rule' and (r.ai_category_code is null or r.ai_category_code != r.final_category_code) order by r.reviewed_at limit 50000",
    );
    const rules = B.learnPracticeRules(
      cs.map((x) => ({
        reviewId: x.id,
        tenantId: x.tenant_id,
        description: x.description ?? "",
        categoryCode: x.final_category_code,
        amountPence: x.amount_pence,
        at: x.reviewed_at,
      })),
      new Date().toISOString(),
    );
    const existing = new Map(
      (
        await pdb.all<{ id: string; scope: string; tenant_id: string | null; pattern: string }>(
          "select id, scope, tenant_id, pattern from practice_rules where practice_id = ?1",
        )
      ).map((r) => [`${r.scope}|${r.tenant_id ?? ""}|${r.pattern}`, r.id]),
    );
    const at = monotonicIso();
    let created = 0,
      updated = 0;
    const stmts = rules.map((r) => {
      const id = existing.get(`${r.scope}|${r.tenantId ?? ""}|${r.pattern}`);
      const vals = [r.categoryCode, r.direction, r.confidence, r.evidence, r.conflicting, r.clients, JSON.stringify(r.provenance), at] as const;
      if (id) {
        updated++;
        return pdb.stmt(
          "update practice_rules set category_code = ?4, direction = ?5, confidence = ?6, evidence = ?7, conflicting = ?8, clients = ?9, provenance_json = ?10, derived_at = ?11 where practice_id = ?1 and id = ?3",
          id,
          ...vals,
        );
      }
      created++;
      return pdb.stmt(
        "insert into practice_rules (practice_id, id, scope, tenant_id, pattern, category_code, direction, confidence, evidence, conflicting, clients, provenance_json, derived_at) values (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        newId(),
        r.scope,
        r.tenantId,
        r.pattern,
        ...vals,
      );
    });
    await pdb.batch([...stmts, await new PracticeAudit(pdb).stmt("learning.derived", null, null, { rules: rules.length, corrections: cs.length })]);
    return c.json(
      {
        practiceRules: rules.filter((r) => r.scope === "practice").length,
        clientRules: rules.filter((r) => r.scope === "client").length,
        corrections: cs.length,
        updated,
        created,
      },
      200,
    );
  },
);
intel.openapi(
  def({
    method: "get",
    path: "/practice/rules",
    tag: TAG,
    summary: "Learned rules visible to me (firm-wide rules + rules of clients I can see), with provenance",
    query: z.object({ scope: z.enum(["practice", "client"]).optional(), clientId: Id.optional() }),
    response: z.object({ items: z.array(Rule) }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const pdb = practiceDb(c);
    const args: unknown[] = [];
    let f = "";
    if (q.scope) {
      args.push(q.scope);
      f += ` and scope = ?${args.length + 2}`;
    }
    if (q.clientId) {
      args.push(q.clientId);
      f += ` and (tenant_id = ?${args.length + 2} or scope = 'practice')`;
    }
    const rows = await pdb.all<RuleRow>(
      `select ${RULE_COLS} from practice_rules where practice_id = ?1 and (scope = 'practice' or tenant_id in (${clientScopeSql(c.get("practice").role)}))${f} order by scope desc, confidence desc, pattern limit 2000`,
      ...args,
    );
    return c.json({ items: rows.map(ruleOut) }, 200);
  },
);
intel.use("/practice/rules/*", requirePracticeRole(...MANAGERS));
intel.openapi(
  def({
    method: "post",
    path: "/practice/rules/{id}/{action}",
    tag: TAG,
    summary: "Disable or re-enable a learned rule (managers)",
    params: z.object({ id: Id, action: z.enum(["disable", "enable"]) }),
    response: Rule,
  }),
  async (c) => {
    const { id, action } = c.req.valid("param");
    const pdb = practiceDb(c);
    const r = await pdb.first<RuleRow>(`select ${RULE_COLS} from practice_rules where practice_id = ?1 and id = ?3`, id);
    if (!r) throw notFound("Rule");
    const status = action === "disable" ? "disabled" : "active";
    if (r.status === status) throw conflict(`Rule is already ${status}`);
    await pdb.batch([
      pdb.stmt(
        "update practice_rules set status = ?4, disabled_by = ?5 where practice_id = ?1 and id = ?3",
        id,
        status,
        status === "disabled" ? pdb.email : null,
      ),
      await new PracticeAudit(pdb).stmt(`rule.${action}d`, id, r.tenant_id),
    ]);
    return c.json(ruleOut({ ...r, status }), 200);
  },
);
const Suggestion = z.object({
  transactionId: z.string(),
  date: z.string(),
  description: z.string().nullable(),
  amountPence: z.number(),
  current: z.object({ categoryCode: z.string().nullable(), confidence: z.number().nullable() }),
  suggested: z
    .object({ categoryCode: z.string(), confidence: z.number(), reasonCodes: z.array(z.string()), reason: z.string(), evidence: z.array(z.string()) })
    .nullable(),
  agrees: z.boolean().nullable(),
});
intel.openapi(
  def({
    method: "get",
    path: "/practice/clients/{id}/suggestions",
    tag: TAG,
    summary: "Explain unreviewed items: current AI category vs learned-rule suggestion, with reason codes and evidence",
    params: z.object({ id: Id }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
    response: z.object({ items: z.array(Suggestion), rulesConsidered: z.number() }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, id);
    const rules = (
      await pdb.all<RuleRow>(
        `select ${RULE_COLS} from practice_rules where practice_id = ?1 and status = 'active' and (scope = 'practice' or tenant_id = ?3)`,
        id,
      )
    ).map((r) => ({
      pattern: r.pattern,
      categoryCode: r.category_code,
      confidence: r.confidence,
      scope: r.scope,
      direction: r.direction as "in" | "out" | "any",
      provenance: JSON.parse(r.provenance_json) as string[],
    }));
    const tdb = new TenantDb(c.env.DB, id);
    const txns = await tdb.all<{
      id: string;
      txn_date: string;
      description: string | null;
      amount_pence: number;
      category_code: string | null;
      confidence: number | null;
    }>(
      "select id, txn_date, description, amount_pence, category_code, confidence from transactions where tenant_id = ?1 and reviewed_at is null order by txn_date, id limit ?2",
      c.req.valid("query").limit,
    );
    const items = txns.map((t) => {
      const s = B.suggestFromRules(t.description ?? "", t.amount_pence, rules);
      return {
        transactionId: t.id,
        date: t.txn_date,
        description: t.description,
        amountPence: t.amount_pence,
        current: { categoryCode: t.category_code, confidence: t.confidence },
        suggested: s,
        agrees: s ? s.categoryCode === t.category_code : null,
      };
    });
    return c.json({ items, rulesConsidered: rules.length }, 200);
  },
);

// ---------------- anomalies ----------------
const AnomalyOut = z.object({
  code: z.enum(["duplicate_payment", "missing_receipt", "unusual_vat", "round_sum", "weekend_posting"]),
  transactionId: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  confidence: z.number(),
  reason: z.string(),
  evidence: z.array(z.string()),
});
async function anomaliesFor(pdb: PracticeDb, env: AppEnv["Bindings"], tenantId: string, from: string, to: string) {
  const tdb = new TenantDb(env.DB, tenantId);
  const rows = await tdb.all<{
    id: string;
    txn_date: string;
    description: string | null;
    amount_pence: number;
    category_code: string | null;
    vat_rate_code: string | null;
    vat_pence: number | null;
    has_receipt: number;
  }>(
    // document_id on bank-feed rows points at the source statement, so only a document of kind 'receipt' counts.
    "select t.id, t.txn_date, t.description, t.amount_pence, t.category_code, t.vat_rate_code, t.vat_pence, coalesce(d.kind = 'receipt', 0) has_receipt from transactions t left join documents d on d.id = t.document_id and d.tenant_id = t.tenant_id where t.tenant_id = ?1 and t.txn_date >= ?2 and t.txn_date <= ?3 order by t.txn_date, t.id limit 5000",
    from,
    to,
  );
  const dismissed = new Set(
    (
      await pdb.all<{ transaction_id: string; code: string }>(
        "select transaction_id, code from anomaly_dismissals where practice_id = ?1 and tenant_id = ?3",
        tenantId,
      )
    ).map((d) => `${d.transaction_id}|${d.code}`),
  );
  const all = B.detectAnomalies(
    rows.map((r) => ({
      id: r.id,
      date: r.txn_date,
      description: r.description,
      amountPence: r.amount_pence,
      categoryCode: r.category_code,
      vatRateCode: r.vat_rate_code,
      vatPence: r.vat_pence,
      hasReceipt: !!r.has_receipt,
    })),
  );
  return {
    items: all.filter((a) => !dismissed.has(`${a.transactionId}|${a.code}`)),
    dismissed: all.length - all.filter((a) => !dismissed.has(`${a.transactionId}|${a.code}`)).length,
    scanned: rows.length,
  };
}
intel.openapi(
  def({
    method: "get",
    path: "/practice/clients/{id}/anomalies",
    tag: TAG,
    summary: "Explainable anomalies for a client (duplicates, missing receipts, unusual VAT, round sums, weekend postings)",
    params: z.object({ id: Id }),
    query: z.object({ from: Day.optional(), to: Day.optional() }),
    response: z.object({ items: z.array(AnomalyOut), dismissed: z.number(), scanned: z.number() }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, id);
    const to = q.to ?? today();
    return c.json(await anomaliesFor(pdb, c.env, id, q.from ?? yearAgo(to), to), 200);
  },
);
intel.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/anomalies/dismiss",
    tag: TAG,
    summary: "Dismiss one anomaly with a note (audited)",
    params: z.object({ id: Id }),
    body: z.object({ transactionId: Id, code: AnomalyOut.shape.code, note: z.string().min(3).max(500) }),
    response: z.object({ dismissed: z.boolean() }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, id);
    if (!(await new TenantDb(c.env.DB, id).first("select id from transactions where tenant_id = ?1 and id = ?2", b.transactionId)))
      throw notFound("Transaction");
    const n = await pdb.batch([
      pdb.stmt(
        "insert or ignore into anomaly_dismissals (practice_id, tenant_id, transaction_id, code, note, dismissed_by, dismissed_at) values (?1, ?3, ?4, ?5, ?6, ?2, ?7)",
        id,
        b.transactionId,
        b.code,
        b.note,
        monotonicIso(),
      ),
      await new PracticeAudit(pdb).stmt("anomaly.dismissed", b.transactionId, id, { code: b.code }),
    ]);
    if (!n[0]) throw conflict("Already dismissed");
    return c.json({ dismissed: true }, 200);
  },
);
async function visibleClients(c: C, pdb: PracticeDb) {
  return pdb.all<ClientRow>(
    `select ${CLIENT_COLS} from practice_clients where practice_id = ?1 and tenant_id in (${clientScopeSql(c.get("practice").role)}) order by name, tenant_id limit 500`,
  );
}
intel.openapi(
  def({
    method: "get",
    path: "/practice/anomalies",
    tag: TAG,
    summary: "Anomaly counts by client and severity across my clients (last 12 months)",
    query: z.object({ asOf: Day.optional() }),
    response: z.object({
      items: z.array(
        z.object({ tenantId: z.string(), client: z.string(), high: z.number(), medium: z.number(), low: z.number(), byCode: z.record(z.string(), z.number()) }),
      ),
    }),
  }),
  async (c) => {
    const pdb = practiceDb(c);
    const to = c.req.valid("query").asOf ?? today();
    const items = [];
    for (const cl of await visibleClients(c, pdb)) {
      const { items: a } = await anomaliesFor(pdb, c.env, cl.tenant_id, yearAgo(to), to);
      const byCode: Record<string, number> = {};
      for (const x of a) byCode[x.code] = (byCode[x.code] ?? 0) + 1;
      items.push({
        tenantId: cl.tenant_id,
        client: cl.name,
        high: a.filter((x) => x.severity === "high").length,
        medium: a.filter((x) => x.severity === "medium").length,
        low: a.filter((x) => x.severity === "low").length,
        byCode,
      });
    }
    items.sort((a, b) => b.high - a.high || b.medium - a.medium || a.client.localeCompare(b.client));
    return c.json({ items }, 200);
  },
);

// ---------------- accuracy harness + drift ----------------
async function reviewRecords(c: C, pdb: PracticeDb, clientId?: string) {
  const rows = await pdb.all<{
    tenant_id: string;
    ai_category_code: string | null;
    ai_confidence: number | null;
    final_category_code: string;
    method: B.ReviewRecord["method"];
    reviewed_at: string;
  }>(
    `select tenant_id, ai_category_code, ai_confidence, final_category_code, method, reviewed_at from review_log where practice_id = ?1 and tenant_id in (${clientScopeSql(c.get("practice").role)})${clientId ? " and tenant_id = ?3" : ""} order by reviewed_at limit 100000`,
    ...(clientId ? [clientId] : []),
  );
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    aiCategoryCode: r.ai_category_code,
    aiConfidence: r.ai_confidence,
    finalCategoryCode: r.final_category_code,
    method: r.method,
    reviewedAt: r.reviewed_at,
  }));
}
const Bucket = z.object({
  key: z.string(),
  n: z.number(),
  correct: z.number(),
  accuracy: z.number().nullable(),
  meanConfidence: z.number().nullable(),
  calibrationGap: z.number().nullable(),
});
intel.openapi(
  def({
    method: "get",
    path: "/practice/eval",
    tag: TAG,
    summary: "Accuracy harness: how often AI categories survive accountant review, by month, client and confidence band",
    query: z.object({ clientId: Id.optional() }),
    response: z.object({
      overall: Bucket,
      byMonth: z.array(Bucket),
      byClient: z.array(Bucket),
      byConfidenceBand: z.array(Bucket),
      topConfusions: z.array(z.object({ pair: z.string(), n: z.number() })),
      excludedAutoApproved: z.number(),
    }),
  }),
  async (c) => {
    const { clientId } = c.req.valid("query");
    const pdb = practiceDb(c);
    if (clientId) await accessibleClient(pdb, c.get("practice").role, clientId);
    return c.json(B.evaluate(await reviewRecords(c, pdb, clientId)), 200);
  },
);
intel.openapi(
  def({
    method: "get",
    path: "/practice/drift",
    tag: TAG,
    summary: "Drift alerts: accuracy drop vs baseline, overconfidence, QA failure rate",
    query: z.object({ asOf: Day.optional(), minN: z.coerce.number().int().min(5).max(1000).default(20) }),
    response: z.object({
      alerts: z.array(
        z.object({
          code: z.enum(["accuracy_drop", "overconfidence", "qa_failure_rate"]),
          scope: z.string(),
          severity: z.enum(["medium", "high"]),
          reason: z.string(),
          recent: z.number(),
          baseline: z.number().nullable(),
          n: z.number(),
        }),
      ),
    }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const pdb = practiceDb(c);
    return c.json({ alerts: B.driftAlerts(await reviewRecords(c, pdb), q.asOf ?? today(), { minN: q.minN }) }, 200);
  },
);

// ---------------- practice assistant ----------------
const Citation = z.object({ kind: z.string(), id: z.string(), label: z.string(), path: z.string() });
type Cite = z.infer<typeof Citation>;
const clientCite = (id: string, name: string): Cite => ({ kind: "client", id, label: name, path: `/v1/practice/clients/${id}` });
let router: LlmRouter = mockLlmRouter;
/** Test seam / future real adapter. */
export const setLlmRouter = (r: LlmRouter) => void (router = r);
interface AskCtx {
  c: C;
  pdb: PracticeDb;
  role: PracticeRole;
  asOf: string;
  b: { clientId?: string };
  only: <T extends { tenantId: string }>(rows: T[]) => T[];
  sums: () => Promise<Awaited<ReturnType<typeof clientSummaries>>>;
}
async function ans_upcoming_deadlines(x: AskCtx, intent: B.PracticeIntent): Promise<{ answer: string; cites: Cite[] }> {
  const { c, pdb, asOf, b } = x;
  let answer = "";
  const cites: Cite[] = [];

  const overdue = intent === "overdue_deadlines";
  const rows = [];
  for (const cl of await visibleClients(c, pdb)) {
    if (b.clientId && cl.tenant_id !== b.clientId) continue;
    if (cl.status === "archived") continue;
    for (const d of B.clientDeadlines({ vatStagger: cl.vat_stagger, mtdItsa: !!cl.mtd_itsa, saRequired: !!cl.sa_required }, asOf, 30))
      if (overdue ? d.daysLeft < 0 : d.daysLeft >= 0) rows.push({ cl, d });
  }
  rows.sort((x, y) => x.d.daysLeft - y.d.daysLeft);
  answer = rows.length
    ? `${rows.length} ${overdue ? "overdue" : "upcoming (30 days)"} deadline(s). ${rows
        .slice(0, 5)
        .map((r) => `${r.cl.name}: ${r.d.title} due ${r.d.dueDate}`)
        .join("; ")}. Dates are generated from configured obligations and are UNVERIFIED.`
    : `No ${overdue ? "overdue" : "upcoming"} deadlines for the clients you can see.`;
  for (const r of rows.slice(0, 10))
    cites.push(clientCite(r.cl.tenant_id, r.cl.name), { kind: "deadline", id: r.d.id, label: r.d.title, path: `/v1/practice/deadlines` });

  return { answer, cites };
}
async function ans_review_backlog(x: AskCtx, _intent: B.PracticeIntent): Promise<{ answer: string; cites: Cite[] }> {
  const { sums } = x;
  let answer = "";
  const cites: Cite[] = [];

  const s = (await sums()).filter((x) => x.awaitingReview > 0).sort((x, y) => y.awaitingReview - x.awaitingReview);
  const total = s.reduce((a, x) => a + x.awaitingReview, 0);
  answer = total
    ? `${total} item(s) awaiting review across ${s.length} client(s). Largest: ${s
        .slice(0, 5)
        .map((x) => `${x.name} ${x.awaitingReview} (oldest ${x.oldestAwaitingDays}d)`)
        .join("; ")}.`
    : "Nothing is awaiting review.";
  for (const x of s.slice(0, 10))
    cites.push(clientCite(x.tenantId, x.name), {
      kind: "review_queue",
      id: x.tenantId,
      label: `${x.awaitingReview} awaiting`,
      path: `/v1/practice/review-queue?clientId=${x.tenantId}`,
    });

  return { answer, cites };
}
async function ans_worst_health(x: AskCtx, _intent: B.PracticeIntent): Promise<{ answer: string; cites: Cite[] }> {
  const { sums } = x;
  let answer = "";
  const cites: Cite[] = [];

  const s = (await sums()).sort((x, y) => x.health.score - y.health.score).slice(0, 5);
  answer = s.length
    ? `Clients needing attention: ${s.map((x) => `${x.name} ${x.health.score}/100 (${x.health.reasons.slice(0, 2).join(", ") || "no issues"})`).join("; ")}.`
    : "You have no clients yet.";
  for (const x of s) cites.push(clientCite(x.tenantId, x.name));

  return { answer, cites };
}
async function ans_anomalies(x: AskCtx, _intent: B.PracticeIntent): Promise<{ answer: string; cites: Cite[] }> {
  const { c, pdb, asOf, b } = x;
  let answer = "";
  const cites: Cite[] = [];

  const found = [];
  for (const cl of await visibleClients(c, pdb)) {
    if (b.clientId && cl.tenant_id !== b.clientId) continue;
    const { items } = await anomaliesFor(pdb, c.env, cl.tenant_id, yearAgo(asOf), asOf);
    for (const a of items) if (a.severity !== "low") found.push({ cl, a });
  }
  answer = found.length
    ? `${found.length} medium/high anomalies. ${found
        .slice(0, 5)
        .map((f) => `${f.cl.name}: ${f.a.reason}`)
        .join("; ")}.`
    : "No medium or high anomalies in the last 12 months.";
  for (const f of found.slice(0, 10))
    cites.push({
      kind: "transaction",
      id: f.a.transactionId,
      label: `${f.cl.name}: ${f.a.code}`,
      path: `/v1/practice/clients/${f.cl.tenant_id}/anomalies`,
    });

  return { answer, cites };
}
async function ans_open_queries(x: AskCtx, _intent: B.PracticeIntent): Promise<{ answer: string; cites: Cite[] }> {
  const { pdb, role, b } = x;
  let answer = "";
  const cites: Cite[] = [];

  const rows = await pdb.all<{ id: string; tenant_id: string; question: string; status: string; name: string }>(
    `select q.id, q.tenant_id, q.question, q.status, pc.name from client_queries q join practice_clients pc on pc.practice_id = q.practice_id and pc.tenant_id = q.tenant_id where q.practice_id = ?1 and q.status in ('open', 'answered') and q.tenant_id in (${clientScopeSql(role)})${b.clientId ? " and q.tenant_id = ?3" : ""} order by q.asked_at limit 50`,
    ...(b.clientId ? [b.clientId] : []),
  );
  const open = rows.filter((r) => r.status === "open").length;
  answer = rows.length ? `${open} query(ies) waiting on clients and ${rows.length - open} answered awaiting your follow-up.` : "No open client queries.";
  for (const r of rows.slice(0, 10)) cites.push({ kind: "query", id: r.id, label: `${r.name}: ${r.question.slice(0, 60)}`, path: `/v1/practice/queries` });

  return { answer, cites };
}
async function ans_wip(x: AskCtx, _intent: B.PracticeIntent): Promise<{ answer: string; cites: Cite[] }> {
  const { pdb, role, asOf, only } = x;
  let answer = "";
  const cites: Cite[] = [];

  const w = only(await wipByClient(pdb, clientScopeSql(role), asOf))
    .filter((x) => x.wipPence > 0)
    .sort((x, y) => y.wipPence - x.wipPence);
  const total = w.reduce((a, x) => a + x.wipPence, 0);
  answer = w.length
    ? `£${(total / 100).toFixed(2)} WIP across ${w.length} client(s). Top: ${w
        .slice(0, 5)
        .map((x) => `${x.client} £${(x.wipPence / 100).toFixed(2)}`)
        .join("; ")}. Internal records only; nothing is invoiced.`
    : "No billable WIP.";
  for (const x of w.slice(0, 10))
    cites.push(clientCite(x.tenantId, x.client), {
      kind: "wip",
      id: x.tenantId,
      label: `£${(x.wipPence / 100).toFixed(2)}`,
      path: "/v1/practice/billing/wip",
    });

  return { answer, cites };
}
async function ans_missing_documents(x: AskCtx, _intent: B.PracticeIntent): Promise<{ answer: string; cites: Cite[] }> {
  const { pdb, role, asOf, b } = x;
  let answer = "";
  const cites: Cite[] = [];

  const rows = await pdb.all<{ id: string; tenant_id: string; title: string; due_date: string | null; name: string }>(
    `select d.id, d.tenant_id, d.title, d.due_date, pc.name from document_requests d join practice_clients pc on pc.practice_id = d.practice_id and pc.tenant_id = d.tenant_id where d.practice_id = ?1 and d.status = 'open' and d.tenant_id in (${clientScopeSql(role)})${b.clientId ? " and d.tenant_id = ?3" : ""} order by coalesce(d.due_date, '9999') limit 50`,
    ...(b.clientId ? [b.clientId] : []),
  );
  const overdue = rows.filter((r) => r.due_date && r.due_date < asOf).length;
  answer = rows.length
    ? `${rows.length} document request(s) outstanding, ${overdue} overdue. ${rows
        .slice(0, 5)
        .map((r) => `${r.name}: ${r.title}`)
        .join("; ")}.`
    : "No outstanding document requests.";
  for (const r of rows.slice(0, 10)) cites.push({ kind: "document_request", id: r.id, label: `${r.name}: ${r.title}`, path: "/v1/practice/document-requests" });

  return { answer, cites };
}
async function ans_accuracy(x: AskCtx, _intent: B.PracticeIntent): Promise<{ answer: string; cites: Cite[] }> {
  const { c, pdb, b } = x;
  let answer = "";
  const cites: Cite[] = [];

  const e = B.evaluate(await reviewRecords(c, pdb, b.clientId));
  answer =
    e.overall.n > 0
      ? `AI categories survived review ${((e.overall.accuracy ?? 0) * 100).toFixed(1)}% of the time over ${e.overall.n} human-reviewed item(s)${e.topConfusions[0] ? `; most common correction ${e.topConfusions[0].pair}` : ""}.`
      : "No reviewed items yet, so accuracy cannot be measured.";
  cites.push({
    kind: "eval",
    id: b.clientId ?? "all",
    label: "Accuracy harness",
    path: `/v1/practice/eval${b.clientId ? `?clientId=${b.clientId}` : ""}`,
  });

  return { answer, cites };
}
const ANSWERS: Record<B.PracticeIntent, (x: AskCtx, i: B.PracticeIntent) => Promise<{ answer: string; cites: Cite[] }>> = {
  overdue_deadlines: ans_upcoming_deadlines,
  upcoming_deadlines: ans_upcoming_deadlines,
  review_backlog: ans_review_backlog,
  worst_health: ans_worst_health,
  anomalies: ans_anomalies,
  open_queries: ans_open_queries,
  wip: ans_wip,
  missing_documents: ans_missing_documents,
  accuracy: ans_accuracy,
};
intel.openapi(
  def({
    method: "post",
    path: "/practice/assistant",
    tag: TAG,
    summary:
      "Ask about your clients. Rules-based intent routing first, then a MOCK LLM router that may only pick an intent. Answers are computed from ledger data you can see, with citations.",
    body: z.object({ question: z.string().min(3).max(500), clientId: Id.optional(), asOf: Day.optional() }),
    response: z.object({
      intent: z.string().nullable(),
      router: z.enum(["rules", "mock-llm", "none"]),
      answer: z.string(),
      citations: z.array(Citation),
      suggestions: z.array(z.string()),
    }),
  }),
  async (c) => {
    const b = c.req.valid("json");
    const pdb = practiceDb(c);
    const role = c.get("practice").role;
    const asOf = b.asOf ?? today();
    if (b.clientId) await accessibleClient(pdb, role, b.clientId);
    const ruled = B.routeIntent(b.question);
    const intent = ruled?.intent ?? (await router.route(b.question));
    const via = ruled ? ("rules" as const) : intent ? ("mock-llm" as const) : ("none" as const);
    const audit = async () => pdb.batch([await new PracticeAudit(pdb).stmt("assistant.asked", intent ?? "none", b.clientId ?? null, { router: via })]);
    if (!intent) {
      await audit();
      return c.json(
        {
          intent: null,
          router: via,
          answer:
            "I can answer questions about deadlines, the review backlog, client health, anomalies, open queries, WIP, missing documents and categorisation accuracy.",
          citations: [],
          suggestions: ["Which deadlines are overdue?", "Which clients need attention?", "How many items are awaiting review?", "What WIP is ready to bill?"],
        },
        200,
      );
    }
    const only = <T extends { tenantId: string }>(rows: T[]): T[] => (b.clientId ? rows.filter((r) => r.tenantId === b.clientId) : rows);
    const { answer, cites } = await ANSWERS[intent]({ c, pdb, role, asOf, b, only, sums: async () => only(await clientSummaries(pdb, role, asOf)) }, intent);
    await audit();
    const seen = new Set<string>();
    return c.json(
      {
        intent,
        router: via,
        answer,
        citations: cites.filter((x) => (seen.has(`${x.kind}|${x.id}`) ? false : (seen.add(`${x.kind}|${x.id}`), true))),
        suggestions: [],
      },
      200,
    );
  },
);
