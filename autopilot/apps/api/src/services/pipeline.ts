import {
  categoriseLines,
  reconcile,
  detectAnomalies,
  qaScore,
  isBillableOutcome,
  vatFromGross,
  VAT_RATES,
  type BankLine,
  type CategoryRule,
  type ExceptionItem,
  type LlmClient,
  type Receipt,
  type InvoiceRef,
  type Stage,
} from "@xevrion/pipeline";
import type { Env } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { log } from "../lib/log.js";
import { postTransactionJournal } from "./ledger.js";

export function llmFromEnv(env: Env): LlmClient | undefined {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) return undefined;
  return {
    async complete(prompt) {
      const r = await fetch(env.LLM_BASE_URL!.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.LLM_API_KEY}` },
        body: JSON.stringify({ model: env.LLM_MODEL ?? "llama-3.3-70b-fp8-fast", temperature: 0, messages: [{ role: "user", content: prompt }] }),
      });
      if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      return j.choices?.[0]?.message?.content ?? "";
    },
  };
}

/** Idempotent stage marker: returns false if this stage already completed for the job (safe re-delivery). */
async function begin(db: TenantDb, jobId: string, stage: Stage): Promise<boolean> {
  const done = await db.first(
    "select e.id from job_events e join jobs j on j.id = e.job_id where j.tenant_id = ?1 and e.job_id = ?2 and e.stage = ?3 and e.status = 'done'",
    jobId,
    stage,
  );
  return !done;
}
function eventStmt(db: TenantDb, jobId: string, stage: Stage, status: "done" | "failed", detail: unknown) {
  // job_events has no tenant_id column; scope through the parent job row.
  return db.stmt(
    "insert or ignore into job_events (id, job_id, stage, status, detail) select ?2, ?3, ?4, ?5, ?6 from jobs where tenant_id = ?1 and id = ?3",
    newId(),
    jobId,
    stage,
    status,
    JSON.stringify(detail),
  );
}

export interface PipelineSummary {
  jobId: string;
  processed: number;
  exceptions: number;
  qaScore: number;
  billable: boolean;
}

/**
 * Runs categorise -> reconcile -> anomaly -> ledger -> qa -> outcome for all 'new' transactions of a tenant.
 * Every stage is idempotent (job_events unique on job/stage/status), so queue retries are safe.
 */
export async function runPipeline(env: Env, tenantId: string, jobId: string, llm = llmFromEnv(env)): Promise<PipelineSummary> {
  const db = new TenantDb(env.DB, tenantId);
  const job = await db.first<{ id: string; status: string }>("select id, status from jobs where tenant_id = ?1 and id = ?2", jobId);
  if (!job) throw new Error(`job ${jobId} not found for tenant`);
  await db.run("update jobs set status = 'running', updated_at = datetime('now') where tenant_id = ?1 and id = ?2", jobId);

  const txns = await db.all<{ id: string; txn_date: string; description: string | null; amount_pence: number; currency: string | null }>(
    "select id, txn_date, description, amount_pence, currency from transactions where tenant_id = ?1 and job_id = ?2 and status = 'new' order by txn_date, id",
    jobId,
  );
  const lines: BankLine[] = txns.map((t) => ({
    id: t.id,
    date: t.txn_date,
    description: t.description ?? "",
    amountPence: t.amount_pence,
    currency: t.currency ?? "GBP",
  }));
  const exceptions: ExceptionItem[] = [];

  // categorise
  const rules = (
    await db.all<{ id: string; pattern: string; match_type: CategoryRule["matchType"]; category_code: string; vat_rate_code: string | null; priority: number }>(
      "select id, pattern, match_type, category_code, vat_rate_code, priority from category_rules where tenant_id = ?1",
    )
  ).map((r) => ({
    id: r.id,
    pattern: r.pattern,
    matchType: r.match_type,
    categoryCode: r.category_code,
    vatRateCode: r.vat_rate_code,
    priority: r.priority,
  }));
  const codes = new Set((await db.all<{ code: string }>("select code from categories where tenant_id = ?1")).map((c) => c.code));
  const cat = await categoriseLines(lines, rules, codes, llm);
  exceptions.push(...cat.exceptions);
  if (await begin(db, jobId, "categorise"))
    await db.batch([eventStmt(db, jobId, "categorise", "done", { lines: lines.length, methods: tally(cat.items.map((i) => i.method)) })]);

  // reconcile against receipts (documents with extracted totals) and open invoices
  const receipts: Receipt[] = (
    await db.all<{ id: string; extracted_json: string | null }>(
      "select id, extracted_json from documents where tenant_id = ?1 and kind = 'receipt' and extracted_json is not null",
    )
  ).flatMap((d) => {
    try {
      const x = JSON.parse(d.extracted_json!);
      return [{ id: d.id, date: x.date, merchant: x.merchant ?? "", totalPence: x.totalPence, vatPence: x.vatPence ?? 0 }];
    } catch {
      return [];
    }
  });
  const invRows = await db.all<{
    id: string;
    number: string;
    customer_name: string;
    gross_pence: number;
    vat_pence: number;
    issue_date: string;
    due_date: string;
  }>("select id, number, customer_name, gross_pence, vat_pence, issue_date, due_date from invoices where tenant_id = ?1 and status = 'sent'");
  const invoices: InvoiceRef[] = invRows.map((i) => ({
    id: i.id,
    number: i.number,
    customerName: i.customer_name,
    grossPence: i.gross_pence,
    issueDate: i.issue_date,
    dueDate: i.due_date,
  }));
  const invVat = new Map(invRows.map((i) => [i.id, i.vat_pence]));
  const matches = reconcile(lines, receipts, invoices);
  // A receipt matched to one of our invoices is a sale: it overrides the categoriser and clears "unknown category".
  for (const m of matches.filter((x) => x.kind === "invoice")) {
    const c = cat.items.find((i) => i.lineId === m.lineId);
    if (c) Object.assign(c, { categoryCode: "4000", vatRateCode: "STD", confidence: Math.max(c.confidence, m.score), method: "invoice_match" });
    for (let k = exceptions.length - 1; k >= 0; k--)
      if (exceptions[k]!.subjectId === m.lineId && exceptions[k]!.reasonCode === "UNKNOWN_CATEGORY") exceptions.splice(k, 1);
  }
  const rcptById = new Map(receipts.map((r) => [r.id, r]));
  if (await begin(db, jobId, "reconcile")) await db.batch([eventStmt(db, jobId, "reconcile", "done", { matches: matches.length })]);

  // anomalies + missing receipts for larger purchases
  exceptions.push(...detectAnomalies(lines));
  const matchedLines = new Set(matches.map((m) => m.lineId));
  const catByLine = new Map(cat.items.map((c) => [c.lineId, c]));
  for (const l of lines) {
    const c = catByLine.get(l.id);
    if (l.amountPence < -5000 && !matchedLines.has(l.id) && c && !["8000", "9999"].includes(c.categoryCode))
      exceptions.push({ reasonCode: "NO_RECEIPT", severity: "low", subjectId: l.id, message: "Purchase over £50 without a matched receipt" });
  }

  // draft: write categorisations + journals atomically per transaction
  const writes: D1PreparedStatement[] = [];
  for (const t of txns) {
    const c = catByLine.get(t.id)!;
    const m = matches.find((x) => x.lineId === t.id);
    let vat = 0;
    if (m?.kind === "receipt") vat = rcptById.get(m.refId)?.vatPence ?? 0;
    else if (m?.kind === "invoice") vat = invVat.get(m.refId) ?? 0;
    else if (t.amount_pence > 0 && c.categoryCode === "4000") vat = vatFromGross(t.amount_pence, VAT_RATES.STD ?? 0);
    const vatCode = c.vatRateCode ?? (c.categoryCode === "4000" ? "STD" : null);
    writes.push(
      db.stmt(
        "update transactions set status = ?3, category_code = ?4, confidence = ?5, vat_pence = ?6, vat_rate_code = ?7, document_id = coalesce(document_id, ?8) where tenant_id = ?1 and id = ?2",
        t.id,
        c.categoryCode === "9999" ? "needs_review" : m ? "reconciled" : "categorised",
        c.categoryCode,
        c.confidence,
        vat,
        vatCode,
        m?.kind === "receipt" ? m.refId : null,
      ),
    );
    if (m?.kind === "invoice")
      writes.push(db.stmt("update invoices set status = 'paid', paid_transaction_id = ?3 where tenant_id = ?1 and id = ?2 and status = 'sent'", m.refId, t.id));
    writes.push(...(await postTransactionJournal(db, t, c.categoryCode, vat, vatCode, "pipeline")));
  }
  for (const e of exceptions.filter((x) => x.severity !== "low" || x.reasonCode === "NO_RECEIPT" || x.reasonCode === "TRANSFER_CHECK")) {
    writes.push(
      db.stmt(
        "insert into exceptions (tenant_id, id, job_id, stage, reason, reason_code, subject_type, subject_id, payload_json) values (?1, ?2, ?3, ?4, ?5, ?6, 'transaction', ?7, ?8)",
        newId(),
        jobId,
        "qa",
        e.message,
        e.reasonCode,
        e.subjectId ?? null,
        JSON.stringify({ severity: e.severity }),
      ),
    );
  }
  if (await begin(db, jobId, "draft")) {
    writes.push(eventStmt(db, jobId, "draft", "done", { journals: txns.length }));
    await db.batch(writes);
  }

  // qa + outcome
  const score = qaScore(lines.length, exceptions);
  const billable = isBillableOutcome(score, exceptions);
  if (await begin(db, jobId, "qa")) {
    await db.batch([
      eventStmt(db, jobId, "qa", "done", { score, exceptions: tally(exceptions.map((e) => e.reasonCode)) }),
      db.stmt(
        "update jobs set status = ?3, qa_score = ?4, updated_at = datetime('now') where tenant_id = ?1 and id = ?2",
        jobId,
        exceptions.some((e) => e.severity !== "low") ? "needs_review" : "completed",
        score,
      ),
      db.stmt(
        "insert into billing_events (tenant_id, id, job_id, event, amount_pence) values (?1, ?2, ?3, ?4, ?5)",
        newId(),
        jobId,
        billable ? "outcome.billable" : "outcome.not_billable",
        null,
      ),
      eventStmt(db, jobId, "outcome", "done", { billable }),
      auditStmt(db, "pipeline", "job.processed", jobId, { processed: lines.length, score }),
    ]);
  }
  log("info", "pipeline.done", { tenantId, jobId, processed: lines.length, exceptions: exceptions.length, score });
  return { jobId, processed: lines.length, exceptions: exceptions.length, qaScore: score, billable };
}

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
