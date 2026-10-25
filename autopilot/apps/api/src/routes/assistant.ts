/**
 * "Ask your books" (grounded; ADR 0021) and onboarding (checklist + sample-data mode). Every answer is computed from this
 * tenant's ledger/transactions by a named tool and cites the records it used; unknown questions get suggestions.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as B from "@xevrion/books";
import type { AppEnv } from "../env.js";
import { requireRole } from "../lib/auth.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { conflict } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import { requireFeature } from "../lib/entitlements.js";
import { chart, ledger } from "./books.js";
import { sha256Hex } from "../services/csv.js";

type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const me = (c: C) => c.get("principal").email;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
let router: B.LlmRouter | null = null;
export const __setAssistantRouter = (r: B.LlmRouter | null) => void (router = r);

export const assistant = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
assistant.use("/assistant/*", requireRole("owner", "reviewer"), requireFeature("assistant"));
assistant.use("/onboarding", requireRole("owner", "reviewer"));
assistant.use("/onboarding/sample-data", requireRole("owner"));

type Tx = { id: string; txn_date: string; description: string | null; amount_pence: number; category_code: string | null; sa_box: string | null };
const cite = (t: Tx): B.Citation => ({ type: "transaction", id: t.id, label: `${t.txn_date} ${t.description ?? ""} ${B.gbp(t.amount_pence)}`.trim() });

type Ctx = {
  db: TenantDb;
  q: B.Question;
  today: string;
  base: Omit<B.Answer, "answer" | "figures" | "citations">;
  period: B.Answer["period"];
  txns: () => Promise<Tx[]>;
  reportCite: (path: string, label: string) => B.Citation;
};
async function flow(x: Ctx): Promise<B.Answer> {
  const { db, q, today, base, period, txns, reportCite } = x;
  void [db, q, today, base, period, txns, reportCite];
  let rows = (await txns()).filter((t) => (q.intent === "spend" ? t.amount_pence < 0 : t.amount_pence > 0));
  if (q.category) rows = rows.filter((t) => t.sa_box === q.category);
  if (q.merchant) rows = rows.filter((t) => (t.description ?? "").toLowerCase().includes(q.merchant!));
  const total = Math.abs(rows.reduce((a, t) => a + t.amount_pence, 0));
  const what = [q.category, q.merchant].filter(Boolean).join(", ");
  return {
    ...base,
    answer: `${q.intent === "spend" ? "You spent" : "You received"} ${B.gbp(total)}${what ? ` on ${what}` : ""} (${period.label}, ${rows.length} transaction${rows.length === 1 ? "" : "s"}).`,
    figures: { totalPence: total, count: rows.length },
    citations: rows.slice(0, 5).map(cite),
  };
}

async function profit(x: Ctx): Promise<B.Answer> {
  const { db, q, today, base, period, txns, reportCite } = x;
  void [db, q, today, base, period, txns, reportCite];
  const pnl = B.profitAndLoss(await ledger(db, q.to), await chart(db), q.from, q.to);
  return {
    ...base,
    answer: `Profit for ${period.label}: ${B.gbp(pnl.netProfitPence)} (income ${B.gbp(pnl.totalIncomePence)}, expenses ${B.gbp(pnl.totalExpensesPence)}).`,
    figures: { netProfitPence: pnl.netProfitPence, incomePence: pnl.totalIncomePence, expensesPence: pnl.totalExpensesPence },
    citations: [reportCite(`/v1/books/reports/pnl?from=${q.from}&to=${q.to}`, "Profit and loss")],
  };
}

async function top(x: Ctx): Promise<B.Answer> {
  const { db, q, today, base, period, txns, reportCite } = x;
  void [db, q, today, base, period, txns, reportCite];
  const by = new Map<string, { pence: number; ids: Tx[] }>();
  for (const t of (await txns()).filter((x) => x.amount_pence < 0)) {
    const k = B.merchantKey(t.description ?? "") || "(unknown)";
    const e = by.get(k) ?? { pence: 0, ids: [] };
    e.pence += -t.amount_pence;
    e.ids.push(t);
    by.set(k, e);
  }
  const top = [...by].sort((a, b) => b[1].pence - a[1].pence || a[0].localeCompare(b[0])).slice(0, 5);
  return {
    ...base,
    answer: top.length
      ? `Biggest suppliers (${period.label}): ${top.map(([k, v]) => `${k} ${B.gbp(v.pence)}`).join("; ")}.`
      : `No spending found for ${period.label}.`,
    figures: Object.fromEntries(top.map(([k, v]) => [k, v.pence])),
    citations: top.map(([, v]) => cite(v.ids[0]!)),
  };
}

async function outstanding(x: Ctx): Promise<B.Answer> {
  const { db, q, today, base, period, txns, reportCite } = x;
  void [db, q, today, base, period, txns, reportCite];
  const inv = await db.all<{ id: string; number: string; customer_name: string; due_date: string; outstanding: number }>(
    `select i.id, i.number, i.customer_name, i.due_date, i.gross_pence - coalesce((select sum(amount_pence) from invoice_payments p where p.tenant_id = i.tenant_id and p.invoice_id = i.id), 0) - coalesce((select sum(gross_pence) from credit_notes n where n.tenant_id = i.tenant_id and n.invoice_id = i.id), 0) outstanding
         from invoices i where i.tenant_id = ?1 and i.status = 'sent' and i.deleted_at is null order by i.due_date`,
  );
  const open = inv.filter((i) => i.outstanding > 0);
  const total = open.reduce((a, i) => a + i.outstanding, 0);
  const overdue = open.filter((i) => i.due_date < today);
  return {
    ...base,
    period: { from: q.from, to: today, label: "now" },
    answer: open.length ? `${open.length} invoice(s) unpaid, ${B.gbp(total)} in total; ${overdue.length} overdue.` : "Nobody owes you anything right now.",
    figures: { outstandingPence: total, count: open.length, overdue: overdue.length },
    citations: open
      .slice(0, 10)
      .map((i) => ({ type: "invoice" as const, id: i.id, label: `${i.number} ${i.customer_name} ${B.gbp(i.outstanding)} due ${i.due_date}` })),
  };
}

async function recRun(x: Ctx): Promise<B.Answer> {
  const { db, q, today, base, period, txns, reportCite } = x;
  void [db, q, today, base, period, txns, reportCite];
  const hist = await db.all<{ id: string; txn_date: string; description: string | null; amount_pence: number }>(
    "select id, txn_date, description, amount_pence from transactions where tenant_id = ?1 and txn_date >= ?2",
    B.addDays(today, -730),
  );
  const rec = B.detectRecurring(hist.map((h) => ({ id: h.id, date: h.txn_date, description: h.description ?? "", amountPence: h.amount_pence })));
  if (q.intent === "recurring") {
    const out = rec.filter((r) => r.direction === "out");
    const monthly = out.reduce(
      (a, r) =>
        a +
        (r.cadence === "monthly"
          ? r.typicalAmountPence
          : r.cadence === "weekly"
            ? Math.round((r.typicalAmountPence * 52) / 12)
            : r.cadence === "yearly"
              ? Math.round(r.typicalAmountPence / 12)
              : r.cadence === "quarterly"
                ? Math.round(r.typicalAmountPence / 3)
                : Math.round((r.typicalAmountPence * 26) / 12)),
      0,
    );
    return {
      ...base,
      answer: out.length
        ? `${out.length} recurring payment(s), about ${B.gbp(monthly)} a month: ${out
            .slice(0, 5)
            .map((r) => `${r.key} (${r.cadence})`)
            .join(", ")}.`
        : "No recurring payments detected yet.",
      figures: { count: out.length, monthlyPence: monthly },
      citations: out.slice(0, 5).map((r) => ({
        type: "series" as const,
        id: r.transactionIds[r.transactionIds.length - 1]!,
        label: `${r.key} ${r.cadence} ${B.gbp(r.typicalAmountPence)}`,
      })),
    };
  }
  const cash = (await ledger(db, today))
    .filter((l) => l.accountCode === "1200" || l.accountCode === "1210")
    .reduce((a, l) => a + l.debitPence - l.creditPence, 0);
  const ids = new Set(rec.flatMap((r) => r.transactionIds));
  const f = B.forecastCash({
    today,
    balancePence: cash,
    recurring: rec,
    history: hist.map((h) => ({ date: h.txn_date, amountPence: h.amount_pence, recurring: ids.has(h.id) })),
  });
  return {
    ...base,
    period: { from: today, to: B.addDays(today, 180), label: "next 180 days" },
    answer:
      f.runwayDays === null
        ? `On current patterns your cash stays positive for the next 180 days (lowest ${B.gbp(f.lowestBalancePence)}).`
        : `On current patterns cash runs out in about ${f.runwayDays} days (balance now ${B.gbp(cash)}).`,
    figures: { runwayDays: f.runwayDays, balancePence: cash, lowestBalancePence: f.lowestBalancePence },
    citations: [reportCite("/v1/books/forecast", "Cash forecast")],
  };
}

async function tax(x: Ctx): Promise<B.Answer> {
  const { db, q, today, base, period, txns, reportCite } = x;
  void [db, q, today, base, period, txns, reportCite];
  const ty = B.taxYearOf(today);
  const s = Number(ty.slice(0, 4));
  const accounts = await chart(db);
  const sum = B.taxSummary(B.profitAndLoss(await ledger(db, `${s + 1}-04-05`), accounts, `${s}-04-06`, `${s + 1}-04-05`), accounts);
  const est = B.estimateTax({ turnoverPence: Math.max(0, sum.turnoverPence), expensesPence: Math.max(0, sum.allowableExpensesPence) });
  return {
    ...base,
    period: { from: `${s}-04-06`, to: `${s + 1}-04-05`, label: `tax year ${ty}` },
    answer: `Rough estimate for ${ty} so far: ${B.gbp(est.totalPence)} (income tax ${B.gbp(est.incomeTaxPence)} + Class 4 ${B.gbp(est.class4Pence)}); consider setting aside about ${est.setAsidePercent}% of income. ${B.UNVERIFIED_NOTICE}`,
    figures: { totalPence: est.totalPence, setAsidePercent: est.setAsidePercent, verified: "false" },
    citations: [reportCite(`/v1/books/tax-estimate?taxYear=${ty}`, "Tax estimate (unverified)")],
  };
}

async function vat(x: Ctx): Promise<B.Answer> {
  const { db, q, today, base, period, txns, reportCite } = x;
  void [db, q, today, base, period, txns, reportCite];
  const v = await db.all<{ id: string; vat_pence: number; amount_pence: number }>(
    "select id, vat_pence, amount_pence from transactions where tenant_id = ?1 and txn_date between ?2 and ?3 and coalesce(vat_pence, 0) != 0",
    q.from,
    q.to,
  );
  const output = v.filter((x) => x.amount_pence > 0).reduce((a, x) => a + x.vat_pence, 0);
  const input = v.filter((x) => x.amount_pence < 0).reduce((a, x) => a + x.vat_pence, 0);
  return {
    ...base,
    answer: `VAT on your books for ${period.label}: output ${B.gbp(output)}, input ${B.gbp(input)}, net ${B.gbp(output - input)}. Check the VAT draft before filing.`,
    figures: { outputPence: output, inputPence: input, netPence: output - input },
    citations: [reportCite(`/v1/vat`, "VAT returns")],
  };
}

const HANDLERS: Partial<Record<B.Intent, (x: Ctx) => Promise<B.Answer>>> = {
  spend: flow,
  income: flow,
  profit,
  top_merchants: top,
  outstanding_invoices: outstanding,
  recurring: recRun,
  runway: recRun,
  tax_estimate: tax,
  vat,
};

async function answer(db: TenantDb, q: B.Question, question: string, today: string): Promise<B.Answer> {
  const period = { from: q.from, to: q.to, label: q.periodLabel };
  const base = { question, intent: q.intent, period, grounded: true };
  const txns = () =>
    db.all<Tx>(
      "select t.id, t.txn_date, t.description, t.amount_pence, t.category_code, c.sa_box from transactions t left join categories c on c.tenant_id = t.tenant_id and c.code = t.category_code where t.tenant_id = ?1 and t.txn_date between ?2 and ?3 and coalesce(t.status, 'new') != 'excluded' order by abs(t.amount_pence) desc",
      q.from,
      q.to,
    );
  const reportCite = (path: string, label: string): B.Citation => ({ type: "report", id: path, label });
  const h = HANDLERS[q.intent];
  if (h) return h({ db, q, today, base, period, txns, reportCite });
  return {
    ...base,
    grounded: false,
    answer: "I can only answer questions about your own books. Try one of these:",
    figures: {},
    citations: [],
    suggestions: B.SUGGESTIONS,
  };
}

const AnswerOut = z
  .object({
    question: z.string(),
    intent: z.string(),
    answer: z.string(),
    figures: z.record(z.string(), z.unknown()),
    citations: z.array(z.object({ type: z.string(), id: z.string(), label: z.string() })),
    period: z.object({ from: z.string(), to: z.string(), label: z.string() }),
    grounded: z.boolean(),
    suggestions: z.array(z.string()).optional(),
    router: z.string(),
  })
  .openapi("AssistantAnswer");
assistant.openapi(
  def({
    method: "post",
    path: "/assistant/ask",
    tag: "Assistant",
    summary: "Ask a question about your books; grounded answer with citations",
    body: z.object({ question: z.string().min(2).max(500), today: Day.optional() }),
    response: AnswerOut,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const today = b.today ?? new Date().toISOString().slice(0, 10);
    const q = B.parseQuestion(b.question, today);
    let used = "rules";
    if (q.intent === "unknown" && router) {
      const i = await router.route(b.question);
      if (i !== "unknown") {
        q.intent = i;
        used = router.name;
      }
    }
    const db = scope(c);
    const a = await answer(db, q, b.question, today);
    await db.batch([auditStmt(db, me(c), "assistant.ask", "assistant", { intent: a.intent, grounded: a.grounded, citations: a.citations.length })]);
    return c.json({ ...a, router: used }, 200);
  },
);
assistant.openapi(def({ method: "get", path: "/assistant/suggestions", tag: "Assistant", summary: "Example questions", response: z.array(z.string()) }), (c) =>
  c.json(B.SUGGESTIONS, 200),
);

// ---------- onboarding ----------
const Step = z.object({ id: z.string(), title: z.string(), done: z.boolean(), href: z.string() });
assistant.openapi(
  def({
    method: "get",
    path: "/onboarding",
    tag: "Onboarding",
    summary: "Setup checklist computed from your data",
    response: z.object({ steps: z.array(Step), done: z.number(), total: z.number(), sampleData: z.boolean() }),
  }),
  async (c) => {
    const db = scope(c);
    const n = async (sql: string) => (await db.first<{ n: number }>(sql))?.n ?? 0;
    const tx = await n("select count(*) n from transactions where tenant_id = ?1 and source != 'sample'");
    const cat = await n(
      "select count(*) n from transactions where tenant_id = ?1 and category_code is not null and category_code != '9999' and source != 'sample'",
    );
    const t = await db.tenantRowStmt("vat_registered, vat_scheme").first<{ vat_registered: number; vat_scheme: string | null }>();
    const steps = [
      { id: "import", title: "Import a bank statement", done: tx > 0, href: "/upload" },
      { id: "categorise", title: "Get 80% of transactions categorised", done: tx > 0 && cat / tx >= 0.8, href: "/review" },
      { id: "vat", title: "Confirm your VAT settings", done: !!t && (t.vat_registered === 0 || !!t.vat_scheme), href: "/settings" },
      { id: "invoice", title: "Create your first invoice", done: (await n("select count(*) n from invoices where tenant_id = ?1")) > 0, href: "/invoices" },
      {
        id: "accountant",
        title: "Invite your accountant",
        done: (await n("select count(*) n from users where tenant_id = ?1 and role in ('accountant','reviewer')")) > 0,
        href: "/settings",
      },
      {
        id: "rules",
        title: "Teach Autopilot a rule",
        done: (await n("select count(*) n from category_rules where tenant_id = ?1 and created_by is not null")) > 0,
        href: "/review",
      },
      {
        id: "close",
        title: "Close your first month",
        done: (await n("select count(*) n from period_closes where tenant_id = ?1 and status = 'approved'")) > 0,
        href: "/periods",
      },
    ];
    return c.json(
      {
        steps,
        done: steps.filter((s) => s.done).length,
        total: steps.length,
        sampleData: (await n("select count(*) n from transactions where tenant_id = ?1 and source = 'sample'")) > 0,
      },
      200,
    );
  },
);
const SAMPLE: [number, string, number][] = [
  [-60, "SAMPLE CLIENT LTD INVOICE PAYMENT", 240000],
  [-58, "SAMPLE SOFTWARE CO SUBSCRIPTION", -1999],
  [-50, "SAMPLE RAIL TICKETS", -4560],
  [-45, "SAMPLE STATIONERS", -2399],
  [-30, "SAMPLE CLIENT LTD INVOICE PAYMENT", 240000],
  [-28, "SAMPLE SOFTWARE CO SUBSCRIPTION", -1999],
  [-20, "SAMPLE FUEL STATION", -6210],
  [-10, "SAMPLE MOBILE NETWORK", -3000],
  [-2, "SAMPLE SOFTWARE CO SUBSCRIPTION", -1999],
];
assistant.openapi(
  def({
    method: "post",
    path: "/onboarding/sample-data",
    tag: "Onboarding",
    summary: "Load clearly-labelled synthetic sample transactions (only into an empty account)",
    response: z.object({ inserted: z.number() }),
    status: 201,
  }),
  async (c) => {
    const db = scope(c);
    if ((await db.first<{ n: number }>("select count(*) n from transactions where tenant_id = ?1"))!.n > 0)
      throw conflict("Sample data can only be loaded into an empty account");
    const today = new Date().toISOString().slice(0, 10);
    const stmts = [];
    for (const [off, d, p] of SAMPLE) {
      const date = B.addDays(today, off);
      stmts.push(
        db.stmt(
          "insert into transactions (tenant_id, id, source, txn_date, description, amount_pence, currency, fingerprint, status) values (?1, ?2, 'sample', ?3, ?4, ?5, 'GBP', ?6, 'new')",
          newId(),
          date,
          d,
          p,
          await sha256Hex(`sample|${date}|${p}|${d}`),
        ),
      );
    }
    await db.batch([...stmts, auditStmt(db, me(c), "onboarding.sample_loaded", db.tenantId, { rows: SAMPLE.length })]);
    return c.json({ inserted: SAMPLE.length }, 201);
  },
);
assistant.openapi(
  def({
    method: "delete",
    path: "/onboarding/sample-data",
    tag: "Onboarding",
    summary: "Remove sample transactions (and anything linked to them)",
    response: z.object({ removed: z.number() }),
  }),
  async (c) => {
    const db = scope(c);
    const ids = (await db.all<{ id: string }>("select id from transactions where tenant_id = ?1 and source = 'sample'")).map((r) => r.id);
    if (ids.length) {
      const stmts = ids.flatMap((id) => [
        db.stmt(
          "delete from journal_lines where tenant_id = ?1 and journal_id in (select id from journals where tenant_id = ?1 and source_type in ('transaction','reversal') and source_id = ?2)",
          id,
        ),
        db.stmt("delete from journals where tenant_id = ?1 and source_type in ('transaction','reversal') and source_id = ?2", id),
        db.stmt("delete from ledger_entries where tenant_id = ?1 and transaction_id = ?2", id),
        db.stmt("delete from exceptions where tenant_id = ?1 and subject_type = 'transaction' and subject_id = ?2", id),
        db.stmt("delete from transaction_tags where tenant_id = ?1 and transaction_id = ?2", id),
      ]);
      await db.batch([
        ...stmts,
        db.stmt("delete from transactions where tenant_id = ?1 and source = 'sample'"),
        auditStmt(db, me(c), "onboarding.sample_removed", db.tenantId, { rows: ids.length }),
      ]);
    }
    return c.json({ removed: ids.length }, 200);
  },
);
