/**
 * Invoicing upgrades: partial payments, credit notes, aged debtors, recurring invoices, reminders (events only) and
 * payment links / FX via provider interfaces with MOCK adapters only (ADR 0017). Nothing here emails or charges anyone.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as B from "@xevrion/books";
import { vatOnNet, VAT_RATES } from "@xevrion/pipeline";
import type { AppEnv } from "../env.js";
import { requireRole } from "../lib/auth.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { Outbox } from "../services/events.js";

type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const actor = (c: C) => c.get("principal").email;
const owner = requireRole("owner");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);

let paymentLinks: B.PaymentLinkProvider = new B.MockPaymentLinks();
let fx: B.FxRateProvider = new B.MockFxRates();
/** Test/adapter seam. Production wiring of a real provider is a separate, approved change. */
export const __setInvoiceProviders = (p: { paymentLinks?: B.PaymentLinkProvider; fx?: B.FxRateProvider }) => {
  if (p.paymentLinks) paymentLinks = p.paymentLinks;
  if (p.fx) fx = p.fx;
};

export const invoicing = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
invoicing.use("/recurring-invoices/*", owner);
invoicing.use("/recurring-invoices", owner);
invoicing.use("/receivables/*", owner);

type Inv = {
  id: string;
  number: string;
  status: string;
  customer_name: string;
  customer_email: string | null;
  due_date: string;
  net_pence: number;
  vat_pence: number;
  gross_pence: number;
  currency: string | null;
};
async function loadBalance(db: TenantDb, id: string) {
  const inv = await db.first<Inv>(
    "select id, number, status, customer_name, customer_email, due_date, net_pence, vat_pence, gross_pence, currency from invoices where tenant_id = ?1 and id = ?2 and deleted_at is null",
    id,
  );
  if (!inv) throw notFound("Invoice");
  const pays = await db.all<{ id: string; amount_pence: number; paid_date: string; method: string | null }>(
    "select id, amount_pence, paid_date, method from invoice_payments where tenant_id = ?1 and invoice_id = ?2 order by paid_date, created_at",
    id,
  );
  const cns = await db.all<{ id: string; number: string; gross_pence: number; vat_pence: number; issue_date: string; reason: string | null }>(
    "select id, number, gross_pence, vat_pence, issue_date, reason from credit_notes where tenant_id = ?1 and invoice_id = ?2 order by created_at",
    id,
  );
  const bal = B.invoiceBalance(
    inv.gross_pence,
    pays.map((p) => p.amount_pence),
    cns.map((n) => n.gross_pence),
  );
  return { inv, pays, cns, bal };
}
const BalanceOut = z
  .object({
    invoiceId: z.string(),
    number: z.string(),
    status: z.string(),
    grossPence: z.number(),
    paidPence: z.number(),
    creditedPence: z.number(),
    outstandingPence: z.number(),
    state: z.string(),
    payments: z.array(z.record(z.string(), z.unknown())),
    creditNotes: z.array(z.record(z.string(), z.unknown())),
  })
  .openapi("InvoiceBalance");
const out = (r: Awaited<ReturnType<typeof loadBalance>>, status = r.inv.status) => ({
  invoiceId: r.inv.id,
  number: r.inv.number,
  status,
  ...r.bal,
  payments: r.pays,
  creditNotes: r.cns,
});

invoicing.openapi(
  def({
    method: "get",
    path: "/invoices/{id}/balance",
    tag: "Invoices",
    summary: "Balance with payments and credit notes",
    params: IdParam,
    response: BalanceOut,
  }),
  async (c) => c.json(out(await loadBalance(scope(c), c.req.valid("param").id)), 200),
);

/** Settles the invoice (status paid + invoice.paid) when nothing is outstanding. */
function settleStmts(db: TenantDb, outbox: Outbox, inv: Inv, outstanding: number, who: string): D1PreparedStatement[] {
  if (outstanding > 0 || inv.status === "paid") return [];
  outbox.add("invoice.paid", { invoiceId: inv.id, number: inv.number, grossPence: inv.gross_pence, transactionId: null }, who);
  return [
    db.stmt("update invoices set status = 'paid', version = version + 1 where tenant_id = ?1 and id = ?2", inv.id),
    auditStmt(db, who, "invoice.status", inv.id, { from: inv.status, to: "paid" }),
  ];
}

invoicing.openapi(
  def({
    method: "post",
    path: "/invoices/{id}/payments",
    tag: "Invoices",
    summary: "Record a full or partial payment (overpayment rejected)",
    params: IdParam,
    body: z.object({
      amountPence: z.number().int().positive(),
      paidDate: Day,
      transactionId: z.string().max(64).optional(),
      method: z.enum(["bank_transfer", "card", "cash", "cheque", "other"]).optional(),
    }),
    response: BalanceOut,
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = scope(c);
    const r = await loadBalance(db, id);
    if (r.inv.status !== "sent") throw conflict(`Payments can only be recorded on sent invoices (this one is ${r.inv.status})`);
    if (b.amountPence > r.bal.outstandingPence) throw conflict(`Payment exceeds outstanding ${r.bal.outstandingPence}p`);
    const outstanding = r.bal.outstandingPence - b.amountPence;
    const outbox = new Outbox(db);
    outbox.add("invoice.payment_recorded", { invoiceId: id, number: r.inv.number, amountPence: b.amountPence, outstandingPence: outstanding }, actor(c));
    const pid = newId();
    await db.batch([
      db.stmt(
        "insert into invoice_payments (tenant_id, id, invoice_id, amount_pence, paid_date, transaction_id, method, created_by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        pid,
        id,
        b.amountPence,
        b.paidDate,
        b.transactionId ?? null,
        b.method ?? null,
        actor(c),
      ),
      auditStmt(db, actor(c), "invoice.payment", id, { paymentId: pid, amountPence: b.amountPence, outstanding }),
      ...settleStmts(db, outbox, r.inv, outstanding, actor(c)),
      ...outbox.stmts,
    ]);
    await outbox.publish(c.env);
    return c.json(out(await loadBalance(db, id)), 201);
  },
);

invoicing.openapi(
  def({
    method: "post",
    path: "/invoices/{id}/credit-notes",
    tag: "Invoices",
    summary: "Issue a credit note (≤ outstanding; VAT reversed proportionally)",
    params: IdParam,
    body: z.object({ grossPence: z.number().int().positive(), reason: z.string().max(200).optional(), issueDate: Day.optional() }),
    response: BalanceOut,
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = scope(c);
    const r = await loadBalance(db, id);
    if (r.inv.status !== "sent") throw conflict(`Credit notes need a sent invoice (this one is ${r.inv.status}); void drafts instead`);
    if (b.grossPence > r.bal.outstandingPence) throw conflict(`Credit exceeds outstanding ${r.bal.outstandingPence}p`);
    const split = B.creditNoteSplit(b.grossPence, r.inv.net_pence, r.inv.vat_pence);
    const cnId = newId();
    const number = `CN-${r.inv.number}-${r.cns.length + 1}`;
    const outstanding = r.bal.outstandingPence - b.grossPence;
    const outbox = new Outbox(db);
    outbox.add("invoice.credit_note_issued", { invoiceId: id, creditNoteId: cnId, number, grossPence: b.grossPence }, actor(c));
    await db.batch([
      db.stmt(
        "insert into credit_notes (tenant_id, id, invoice_id, number, issue_date, net_pence, vat_pence, gross_pence, reason, created_by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        cnId,
        id,
        number,
        b.issueDate ?? today(),
        split.netPence,
        split.vatPence,
        b.grossPence,
        b.reason ?? null,
        actor(c),
      ),
      auditStmt(db, actor(c), "invoice.credit_note", id, { creditNoteId: cnId, number, ...split }),
      ...settleStmts(db, outbox, r.inv, outstanding, actor(c)),
      ...outbox.stmts,
    ]);
    await outbox.publish(c.env);
    return c.json(out(await loadBalance(db, id)), 201);
  },
);

invoicing.openapi(
  def({
    method: "post",
    path: "/invoices/{id}/payment-link",
    tag: "Invoices",
    summary: "Create a payment link via the configured provider (MOCK only; nothing is charged or sent)",
    params: IdParam,
    response: z.object({ url: z.string(), provider: z.string(), providerRef: z.string(), amountMinor: z.number(), currency: z.string() }),
    status: 201,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = scope(c);
    const r = await loadBalance(db, id);
    if (r.inv.status !== "sent" || r.bal.outstandingPence <= 0) throw conflict("Payment links need a sent invoice with an outstanding balance");
    const link = await paymentLinks.createLink({ invoiceId: id, number: r.inv.number, amountMinor: r.bal.outstandingPence, currency: r.inv.currency ?? "GBP" });
    await db.batch([
      db.stmt("update invoices set payment_link_url = ?3 where tenant_id = ?1 and id = ?2", id, link.url),
      auditStmt(db, actor(c), "invoice.payment_link", id, { provider: paymentLinks.name, ref: link.providerRef }),
    ]);
    return c.json({ ...link, provider: paymentLinks.name }, 201);
  },
);

invoicing.openapi(
  def({
    method: "post",
    path: "/invoices/{id}/currency",
    tag: "Invoices",
    summary: "Set a draft invoice's currency; stores the FX rate to GBP from the provider (MOCK rates)",
    params: IdParam,
    body: z.object({ currency: z.string().regex(/^[A-Za-z]{3}$/) }),
    response: z.object({ currency: z.string(), fxRateToGbp: z.number(), grossInGbpPence: z.number(), provider: z.string() }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const cur = c.req.valid("json").currency.toUpperCase();
    const db = scope(c);
    const inv = await db.first<{ status: string; gross_pence: number; issue_date: string }>(
      "select status, gross_pence, issue_date from invoices where tenant_id = ?1 and id = ?2 and deleted_at is null",
      id,
    );
    if (!inv) throw notFound("Invoice");
    if (inv.status !== "draft") throw conflict("Currency can only change on drafts");
    let rate: number;
    try {
      rate = await fx.rate(cur, "GBP", inv.issue_date);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    await db.batch([
      db.stmt("update invoices set currency = ?3, fx_rate_to_gbp = ?4, version = version + 1 where tenant_id = ?1 and id = ?2", id, cur, rate),
      auditStmt(db, actor(c), "invoice.currency", id, { currency: cur, rate, provider: fx.name }),
    ]);
    return c.json({ currency: cur, fxRateToGbp: rate, grossInGbpPence: B.convertMinor(inv.gross_pence, cur, "GBP", rate), provider: fx.name }, 200);
  },
);

// ---------- receivables ----------
async function receivables(db: TenantDb) {
  const invs = await db.all<{
    id: string;
    customer_name: string;
    due_date: string;
    gross_pence: number;
    number: string;
    customer_email: string | null;
    paid: number;
    credited: number;
  }>(
    `select i.id, i.customer_name, i.due_date, i.gross_pence, i.number, i.customer_email,
       coalesce((select sum(amount_pence) from invoice_payments p where p.tenant_id = i.tenant_id and p.invoice_id = i.id), 0) paid,
       coalesce((select sum(gross_pence) from credit_notes n where n.tenant_id = i.tenant_id and n.invoice_id = i.id), 0) credited
     from invoices i where i.tenant_id = ?1 and i.status = 'sent' and i.deleted_at is null`,
  );
  return invs.map((i) => ({ ...i, outstanding: i.gross_pence - i.paid - i.credited }));
}
invoicing.openapi(
  def({
    method: "get",
    path: "/receivables/aged",
    tag: "Invoices",
    summary: "Aged debtors (current, 1-30, 31-60, 61-90, 90+ days overdue)",
    query: z.object({ today: Day.optional() }),
    response: z.record(z.string(), z.unknown()),
  }),
  async (c) => {
    const rs = await receivables(scope(c));
    return c.json(
      B.agedDebtors(
        rs.map((r) => ({ id: r.id, customer: r.customer_name, dueDate: r.due_date, outstandingPence: r.outstanding })),
        c.req.valid("query").today ?? today(),
      ) as unknown as Record<string, unknown>,
      200,
    );
  },
);
invoicing.openapi(
  def({
    method: "post",
    path: "/receivables/reminders/run",
    tag: "Invoices",
    summary: "Emit invoice.reminder_due events for unpaid invoices (no emails are sent)",
    body: z.object({ today: Day.optional() }),
    response: z.object({ emitted: z.array(z.object({ invoiceId: z.string(), kind: z.string() })) }),
  }),
  async (c) => {
    const db = scope(c);
    const t = c.req.valid("json").today ?? today();
    const rs = (await receivables(db)).filter((r) => r.outstanding > 0);
    const sent = await db.all<{ invoice_id: string; kind: string }>("select invoice_id, kind from invoice_reminders where tenant_id = ?1");
    const outbox = new Outbox(db);
    const stmts: D1PreparedStatement[] = [];
    const emitted: { invoiceId: string; kind: string }[] = [];
    for (const r of rs)
      for (const d of B.dueReminders(
        r.due_date,
        t,
        sent.filter((s) => s.invoice_id === r.id).map((s) => s.kind),
      )) {
        emitted.push({ invoiceId: r.id, kind: d.kind });
        outbox.add(
          "invoice.reminder_due",
          { invoiceId: r.id, number: r.number, kind: d.kind, outstandingPence: r.outstanding, customerEmail: r.customer_email },
          actor(c),
        );
        stmts.push(
          db.stmt(
            "insert or ignore into invoice_reminders (tenant_id, id, invoice_id, kind, due_on, emitted_at) values (?1, ?2, ?3, ?4, ?5, ?6)",
            newId(),
            r.id,
            d.kind,
            d.dueOn,
            new Date().toISOString(),
          ),
        );
      }
    if (stmts.length) {
      await db.batch([...stmts, auditStmt(db, actor(c), "invoice.reminders", "invoices", { count: emitted.length }), ...outbox.stmts]);
      await outbox.publish(c.env);
    }
    return c.json({ emitted }, 200);
  },
);

// ---------- recurring invoices ----------
const Template = z.object({
  customerName: z.string().min(1).max(120),
  customerEmail: z.string().email().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(200),
        quantity: z.number().positive(),
        unitPence: z.number().int().nonnegative(),
        vatRateCode: z.enum(["STD", "RED", "ZERO", "EXEMPT", "OUTSIDE"]),
      }),
    )
    .min(1)
    .max(100),
});
const Schedule = z
  .object({
    id: z.string(),
    cadence: z.string(),
    interval_n: z.number(),
    next_issue_date: z.string(),
    end_date: z.string().nullable(),
    payment_terms_days: z.number(),
    active: z.number(),
    template_json: z.string(),
  })
  .openapi("RecurringInvoice");
invoicing.openapi(
  def({
    method: "post",
    path: "/recurring-invoices",
    tag: "Invoices",
    summary: "Create a recurring invoice schedule (issues drafts; never sends)",
    body: z.object({
      template: Template,
      cadence: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
      interval: z.number().int().min(1).max(12).default(1),
      startDate: Day,
      endDate: Day.optional(),
      paymentTermsDays: z.number().int().min(0).max(120).default(30),
    }),
    response: Schedule,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    if (b.endDate && b.endDate < b.startDate) throw badRequest("endDate must be on or after startDate");
    const db = scope(c);
    const id = newId();
    await db.batch([
      db.stmt(
        "insert into recurring_invoices (tenant_id, id, template_json, cadence, interval_n, next_issue_date, end_date, payment_terms_days, created_by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        id,
        JSON.stringify(b.template),
        b.cadence,
        b.interval,
        b.startDate,
        b.endDate ?? null,
        b.paymentTermsDays,
        actor(c),
      ),
      auditStmt(db, actor(c), "recurring_invoice.created", id, { cadence: b.cadence }),
    ]);
    return c.json(
      (await db.first<z.infer<typeof Schedule>>(
        "select id, cadence, interval_n, next_issue_date, end_date, payment_terms_days, active, template_json from recurring_invoices where tenant_id = ?1 and id = ?2",
        id,
      ))!,
      201,
    );
  },
);
invoicing.openapi(
  def({ method: "get", path: "/recurring-invoices", tag: "Invoices", summary: "Recurring schedules", response: z.array(Schedule) }),
  async (c) =>
    c.json(
      await scope(c).all<z.infer<typeof Schedule>>(
        "select id, cadence, interval_n, next_issue_date, end_date, payment_terms_days, active, template_json from recurring_invoices where tenant_id = ?1 order by created_at",
      ),
      200,
    ),
);
invoicing.openapi(
  def({
    method: "post",
    path: "/recurring-invoices/run",
    tag: "Invoices",
    summary: "Issue any due drafts (idempotent per date; catch-up capped at 12)",
    body: z.object({ today: Day.optional() }),
    response: z.object({ issued: z.array(z.object({ scheduleId: z.string(), invoiceId: z.string(), number: z.string(), issueDate: z.string() })) }),
  }),
  async (c) => {
    const db = scope(c);
    const t = c.req.valid("json").today ?? today();
    const due = await db.all<z.infer<typeof Schedule>>(
      "select id, cadence, interval_n, next_issue_date, end_date, payment_terms_days, active, template_json from recurring_invoices where tenant_id = ?1 and active = 1 and next_issue_date <= ?2",
      t,
    );
    const issued: { scheduleId: string; invoiceId: string; number: string; issueDate: string }[] = [];
    for (const s of due) {
      const tpl = Template.parse(JSON.parse(s.template_json));
      const dates = B.dueIssueDates(s.next_issue_date, s.cadence as B.InvoiceCadence, t, { interval: s.interval_n, endDate: s.end_date });
      const outbox = new Outbox(db);
      const stmts: D1PreparedStatement[] = [];
      for (const d of dates) {
        let net = 0,
          vat = 0;
        for (const l of tpl.lines) {
          const ln = Math.round(l.quantity * l.unitPence);
          net += ln;
          vat += vatOnNet(ln, VAT_RATES[l.vatRateCode] ?? 0);
        }
        const seq = await db.first<{ prefix: string; next_value: number }>(
          "update invoice_sequences set next_value = next_value + 1 where tenant_id = ?1 returning prefix, next_value - 1 as next_value",
        );
        if (!seq) throw badRequest("Invoice numbering not initialised");
        const number = `${seq.prefix}${String(seq.next_value).padStart(4, "0")}`;
        const invId = newId();
        stmts.push(
          db.stmt(
            "insert into invoices (tenant_id, id, number, customer_name, customer_email, issue_date, due_date, status, net_pence, vat_pence, gross_pence, lines_json, recurring_id) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9, ?10, ?11, ?12)",
            invId,
            number,
            tpl.customerName,
            tpl.customerEmail ?? null,
            d,
            B.addDays(d, s.payment_terms_days),
            net,
            vat,
            net + vat,
            JSON.stringify(tpl.lines),
            s.id,
          ),
        );
        outbox.add("invoice.recurring_issued", { invoiceId: invId, scheduleId: s.id, number, grossPence: net + vat }, actor(c));
        issued.push({ scheduleId: s.id, invoiceId: invId, number, issueDate: d });
      }
      const next = dates.length ? B.nextIssueDate(dates[dates.length - 1]!, s.cadence as B.InvoiceCadence, s.interval_n) : s.next_issue_date;
      const finished = s.end_date !== null && next > s.end_date;
      // Guarded by next_issue_date so a concurrent run cannot issue the same period twice.
      stmts.push(
        db.stmt(
          "update recurring_invoices set next_issue_date = ?3, active = ?4 where tenant_id = ?1 and id = ?2 and next_issue_date = ?5",
          s.id,
          next,
          finished ? 0 : 1,
          s.next_issue_date,
        ),
      );
      stmts.push(auditStmt(db, actor(c), "recurring_invoice.run", s.id, { issued: dates.length, next }), ...outbox.stmts);
      await db.batch(stmts);
      await outbox.publish(c.env);
    }
    return c.json({ issued }, 200);
  },
);
