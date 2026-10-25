/**
 * Books API: importers (OFX/QIF/MT940/CSV + Xero/QuickBooks/FreshBooks), learned rules, recurring, reports, forecast,
 * spending spikes, calculators, tax pot and deadlines. Mounted under /v1/books. Every tax figure is an ESTIMATE on
 * UNVERIFIED placeholder rates (ADR 0015) and says so in the response.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as B from "@xevrion/books";
import type { AppEnv } from "../env.js";
import { requireRole } from "../lib/auth.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { badRequest, tooLarge } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import { Outbox } from "../services/events.js";
import { enforceQuota, meterStmt } from "../services/usage.js";
import { parseBankCsv, sha256Hex } from "../services/csv.js";

type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const actor = (c: C) => c.get("principal").email;
const reviewer = requireRole("owner", "reviewer");
const owner = requireRole("owner");
export const books = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
books.use("*", reviewer);

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);
const Unverified = { verified: z.literal(false), notice: z.string() };
const Json = z.record(z.string(), z.unknown());

// ---------- data access ----------
async function chart(db: TenantDb): Promise<B.Account[]> {
  const rows = await db.all<{ code: string; name: string; kind: B.AccountType; sa_box: string | null }>(
    "select code, name, kind, sa_box from categories where tenant_id = ?1",
  );
  return rows.map((r) => ({ code: r.code, name: r.name, type: r.kind, ...(r.sa_box ? { sa103: r.sa_box } : {}) }));
}
async function ledger(db: TenantDb, to: string): Promise<B.LedgerLine[]> {
  const rows = await db.all<{ journal_id: string; entry_date: string; account_code: string; debit_pence: number; credit_pence: number }>(
    "select l.journal_id, j.entry_date, l.account_code, l.debit_pence, l.credit_pence from journal_lines l join journals j on j.id = l.journal_id and j.tenant_id = l.tenant_id where l.tenant_id = ?1 and j.entry_date <= ?2",
    to,
  );
  return rows.map((r) => ({
    journalId: r.journal_id,
    date: r.entry_date,
    accountCode: r.account_code,
    debitPence: r.debit_pence,
    creditPence: r.credit_pence,
  }));
}
type TxRow = { id: string; txn_date: string; description: string | null; amount_pence: number; category_code: string | null };
const txns = (db: TenantDb, from: string) =>
  db.all<TxRow>(
    "select id, txn_date, description, amount_pence, category_code from transactions where tenant_id = ?1 and txn_date >= ?2 and coalesce(status, 'new') != 'excluded' order by txn_date",
    from,
  );
const toTx = (r: TxRow) => ({ id: r.id, date: r.txn_date, description: r.description ?? "", amountPence: r.amount_pence });

// ---------- importers ----------
const MAX = 2 * 1024 * 1024;
const ImportResult = z
  .object({
    format: z.string(),
    source: z.string().nullable(),
    dryRun: z.boolean(),
    parsed: z.number().int(),
    inserted: z.number().int(),
    duplicates: z.number().int(),
    probableDuplicates: z.array(z.object({ line: z.number().int(), duplicateOf: z.string(), score: z.number(), reason: z.string() })),
    rejectedRows: z.array(z.object({ row: z.number(), error: z.string() })),
  })
  .openapi("BooksImportResult");

function parseAny(
  text: string,
  source: string,
): {
  format: string;
  source: string | null;
  lines: { date: string; description: string; amountPence: number; externalId?: string }[];
  rejected: { row: number; error: string }[];
} {
  if (source !== "auto" && source !== "bank") {
    const r = B.parseAccountingExport(text, source as B.AccountingSource);
    return { format: "csv", source: r.source, lines: r.lines, rejected: r.rejected };
  }
  const fmt = B.detectFormat(text);
  if (fmt === "ofx") return { ...B.parseOfx(text), source: null };
  if (fmt === "qif") return { ...B.parseQif(text), source: null };
  if (fmt === "mt940") return { ...B.parseMt940(text), source: null };
  const header = (B.readCsv(text.replace(/^\uFEFF/, ""))[0] ?? []).map((h) => h.trim().toLowerCase());
  const acct = B.detectAccountingSource(header);
  if (acct) {
    const r = B.parseAccountingExport(text, acct);
    return { format: "csv", source: r.source, lines: r.lines, rejected: r.rejected };
  }
  const r = parseBankCsv(text);
  return { format: "csv", source: null, lines: r.lines, rejected: r.rejected };
}

books.openapi(
  def({
    method: "post",
    path: "/imports/statement",
    tag: "Books",
    summary: "Import a bank statement (OFX/QIF/MT940/CSV) or a Xero/QuickBooks/FreshBooks export; exact duplicates skipped, probable ones reported",
    query: z.object({
      source: z.enum(["auto", "bank", "xero", "quickbooks", "freshbooks"]).default("auto"),
      dryRun: z.enum(["true", "false"]).default("false"),
    }),
    response: ImportResult,
    status: 201,
  }),
  async (c) => {
    const q = c.req.valid("query");
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX) throw tooLarge("File larger than 2 MB");
    if (!bytes.byteLength) throw badRequest("Empty file");
    let parsed;
    try {
      parsed = parseAny(new TextDecoder().decode(bytes), q.source);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const db = scope(c);
    const dryRun = q.dryRun === "true";
    const dates = parsed.lines.map((l) => l.date).sort();
    const existing = dates.length
      ? await db.all<TxRow & { fingerprint: string | null }>(
          "select id, txn_date, description, amount_pence, category_code, fingerprint from transactions where tenant_id = ?1 and txn_date between ?2 and ?3",
          B.addDays(dates[0]!, -3),
          B.addDays(dates[dates.length - 1]!, 3),
        )
      : [];
    const fps = new Set(existing.map((e) => e.fingerprint));
    const probable = B.findDuplicates(
      parsed.lines.map((l, i) => ({ id: String(i), date: l.date, description: l.description, amountPence: l.amountPence })),
      existing.map(toTx),
    ).filter((m) => m.kind === "probable");
    const jobId = newId();
    const outbox = new Outbox(db);
    const stmts: D1PreparedStatement[] = [];
    let inserted = 0,
      duplicates = 0;
    for (const l of parsed.lines) {
      const fp = await sha256Hex(`${l.date}|${l.amountPence}|${l.description.toUpperCase()}`);
      if (fps.has(fp)) {
        duplicates++;
        continue;
      }
      fps.add(fp);
      inserted++;
      const id = newId();
      stmts.push(
        db.stmt(
          "insert or ignore into transactions (tenant_id, id, job_id, source, txn_date, description, amount_pence, currency, fingerprint, status) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'GBP', ?8, 'new')",
          id,
          jobId,
          `import_${parsed.source ?? parsed.format}`,
          l.date,
          l.description,
          l.amountPence,
          fp,
        ),
      );
      outbox.add(
        "transaction.created",
        { transactionId: id, jobId, date: l.date, description: l.description, amountPence: l.amountPence, currency: "GBP" },
        actor(c),
      );
    }
    const result = {
      format: parsed.format,
      source: parsed.source,
      dryRun,
      parsed: parsed.lines.length,
      inserted: dryRun ? 0 : inserted,
      duplicates,
      probableDuplicates: probable.map((p) => ({ line: Number(p.id) + 1, duplicateOf: p.duplicateOf, score: p.score, reason: p.reason })),
      rejectedRows: parsed.rejected,
    };
    if (dryRun) return c.json({ ...result, inserted }, 201);
    if (inserted) await enforceQuota(db, "transactions", inserted);
    await db.batch([
      db.stmt("insert into jobs (tenant_id, id, kind, period, status) values (?1, ?2, 'monthly_books', null, ?3)", jobId, inserted ? "queued" : "completed"),
      ...stmts,
      auditStmt(db, actor(c), "books.import", jobId, { format: parsed.format, source: parsed.source, inserted, duplicates, rejected: parsed.rejected.length }),
      ...outbox.stmts,
      ...(inserted ? [meterStmt(db, "transactions", inserted)] : []),
    ]);
    await outbox.publish(c.env);
    if (inserted) await c.env.PIPELINE.send({ jobId, tenantId: db.tenantId });
    return c.json(result, 201);
  },
);

// ---------- learned rules ----------
const Rule = z
  .object({
    pattern: z.string(),
    categoryCode: z.string(),
    vatRateCode: z.string().nullable(),
    confidence: z.number(),
    evidence: z.number(),
    conflicting: z.number(),
    direction: z.string(),
  })
  .openapi("LearnedRule");
async function suggestions(db: TenantDb) {
  const rows = await db.all<{ description: string; category_code: string; vat_rate_code: string | null; amount_pence: number | null; created_at: string }>(
    "select description, category_code, vat_rate_code, amount_pence, created_at from category_corrections where tenant_id = ?1 order by created_at desc limit 5000",
  );
  const learned = B.learnRules(
    rows.map((r) => ({
      description: r.description,
      categoryCode: r.category_code,
      vatRateCode: r.vat_rate_code,
      at: r.created_at,
      ...(r.amount_pence !== null ? { amountPence: r.amount_pence } : {}),
    })),
    new Date().toISOString(),
  );
  // Suppress only when an existing rule already gives the same answer; a rule the user keeps correcting away from is exactly what to learn.
  const have = new Set(
    (await db.all<{ pattern: string; category_code: string }>("select pattern, category_code from category_rules where tenant_id = ?1")).map(
      (r) => `${r.pattern.toUpperCase()}|${r.category_code}`,
    ),
  );
  return learned.filter((r) => !have.has(`${r.pattern}|${r.categoryCode}`));
}
books.openapi(
  def({ method: "get", path: "/rules/suggestions", tag: "Books", summary: "Rules learned from your corrections (not yet applied)", response: z.array(Rule) }),
  async (c) => c.json(await suggestions(scope(c)), 200),
);
books.post("/rules/learn", owner);
books.openapi(
  def({
    method: "post",
    path: "/rules/learn",
    tag: "Books",
    summary: "Apply learned rules (owner); returns the rules created",
    response: z.object({ created: z.array(Rule) }),
    status: 201,
  }),
  async (c) => {
    const db = scope(c);
    const s = await suggestions(db);
    if (s.length)
      await db.batch([
        ...s.map((r) =>
          db.stmt(
            "insert into category_rules (tenant_id, id, pattern, match_type, category_code, vat_rate_code, priority, created_by, source, confidence) values (?1, ?2, ?3, 'contains', ?4, ?5, 20, ?6, 'learned', ?7)",
            newId(),
            r.pattern,
            r.categoryCode,
            r.vatRateCode,
            actor(c),
            r.confidence,
          ),
        ),
        auditStmt(db, actor(c), "rules.learned", "category_rules", { count: s.length, patterns: s.map((r) => r.pattern) }),
      ]);
    return c.json({ created: s }, 201);
  },
);

// ---------- recurring, forecast, spikes ----------
const Series = z
  .object({
    key: z.string(),
    direction: z.string(),
    cadence: z.string(),
    occurrences: z.number(),
    typicalAmountPence: z.number(),
    amountVaries: z.boolean(),
    lastDate: z.string(),
    nextExpectedDate: z.string(),
    transactionIds: z.array(z.string()),
    confidence: z.number(),
  })
  .openapi("RecurringSeries");
const recurringFor = async (db: TenantDb) => B.detectRecurring((await txns(db, B.addDays(today(), -730))).map(toTx));
books.openapi(
  def({ method: "get", path: "/recurring", tag: "Books", summary: "Recurring payments and income (subscriptions, rent, DDs)", response: z.array(Series) }),
  async (c) => c.json(await recurringFor(scope(c)), 200),
);
books.openapi(
  def({
    method: "get",
    path: "/forecast",
    tag: "Books",
    summary: "Cash forecast and runway from recurring flows and recent history",
    query: z.object({ horizonDays: z.coerce.number().int().min(7).max(730).default(180) }),
    response: Json,
  }),
  async (c) => {
    const db = scope(c);
    const t = today();
    const cash = (await ledger(db, t))
      .filter((l) => l.accountCode === "1200" || l.accountCode === "1210")
      .reduce((a, l) => a + l.debitPence - l.creditPence, 0);
    const history = await txns(db, B.addDays(t, -730));
    const rec = B.detectRecurring(history.map(toTx));
    const recIds = new Set(rec.flatMap((r) => r.transactionIds));
    const f = B.forecastCash({
      today: t,
      balancePence: cash,
      recurring: rec,
      history: history.map((h) => ({ date: h.txn_date, amountPence: h.amount_pence, recurring: recIds.has(h.id) })),
      horizonDays: c.req.valid("query").horizonDays,
    });
    return c.json(f as unknown as Record<string, unknown>, 200);
  },
);
books.openapi(
  def({
    method: "get",
    path: "/spikes",
    tag: "Books",
    summary: "Categories whose spend jumped vs the trailing 3-month median",
    query: z.object({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
    }),
    response: z.array(Json),
  }),
  async (c) => {
    const month = c.req.valid("query").month ?? today().slice(0, 7);
    const rows = await txns(scope(c), `${B.monthsBack(month, 3)}-01`);
    return c.json(
      B.detectSpikes(
        rows.filter((r) => r.category_code).map((r) => ({ date: r.txn_date, categoryCode: r.category_code!, amountPence: r.amount_pence })),
        month,
      ) as unknown as Record<string, unknown>[],
      200,
    );
  },
);

// ---------- reports ----------
const Range = z.object({ from: Day, to: Day });
books.openapi(def({ method: "get", path: "/reports/pnl", tag: "Books", summary: "Profit and loss for a period", query: Range, response: Json }), async (c) => {
  const q = c.req.valid("query");
  const db = scope(c);
  return c.json(B.profitAndLoss(await ledger(db, q.to), await chart(db), q.from, q.to) as unknown as Record<string, unknown>, 200);
});
books.openapi(
  def({ method: "get", path: "/reports/balance-sheet", tag: "Books", summary: "Balance sheet at a date", query: z.object({ asAt: Day }), response: Json }),
  async (c) => {
    const db = scope(c);
    const asAt = c.req.valid("query").asAt;
    return c.json(B.balanceSheet(await ledger(db, asAt), await chart(db), asAt) as unknown as Record<string, unknown>, 200);
  },
);
books.openapi(
  def({ method: "get", path: "/reports/cash-flow", tag: "Books", summary: "Cash flow (direct method) for a period", query: Range, response: Json }),
  async (c) => {
    const q = c.req.valid("query");
    const db = scope(c);
    return c.json(B.cashFlow(await ledger(db, q.to), await chart(db), q.from, q.to) as unknown as Record<string, unknown>, 200);
  },
);
books.openapi(
  def({ method: "get", path: "/reports/sa103", tag: "Books", summary: "SA103-style expense summary (UNVERIFIED mapping)", query: Range, response: Json }),
  async (c) => {
    const q = c.req.valid("query");
    const db = scope(c);
    const accounts = await chart(db);
    return c.json(
      { ...B.taxSummary(B.profitAndLoss(await ledger(db, q.to), accounts, q.from, q.to), accounts), verified: false, notice: B.UNVERIFIED_NOTICE },
      200,
    );
  },
);

// ---------- calculators & tax ----------
const Est = z.object({ value: z.unknown(), workings: z.array(z.string()), ...Unverified }).openapi("Estimate");
const wrap = (fn: () => unknown) => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RangeError) throw badRequest(e.message);
    throw e;
  }
};
books.openapi(
  def({
    method: "post",
    path: "/calculators/mileage",
    tag: "Books",
    summary: "Mileage allowance estimate (from body, or this tax year's mileage log)",
    body: z.object({
      miles: z.number().min(0).optional(),
      vehicle: z.enum(["car_van", "motorcycle", "bicycle"]).default("car_van"),
      priorMiles: z.number().min(0).default(0),
    }),
    response: Est,
  }),
  async (c) => {
    const b = c.req.valid("json");
    let miles = b.miles;
    if (miles === undefined) {
      const ty = B.taxYearOf(today());
      const r = await scope(c).first<{ m: number | null }>(
        "select sum(miles) m from mileage_trips where tenant_id = ?1 and vehicle = ?2 and trip_date between ?3 and ?4",
        b.vehicle,
        `${ty.slice(0, 4)}-04-06`,
        `${Number(ty.slice(0, 4)) + 1}-04-05`,
      );
      miles = r?.m ?? 0;
    }
    return c.json(wrap(() => B.mileageAllowance(miles!, b.vehicle, b.priorMiles)) as z.infer<typeof Est>, 200);
  },
);
books.openapi(
  def({
    method: "post",
    path: "/calculators/home-office",
    tag: "Books",
    summary: "Home office: flat rate vs actual proportion",
    body: z.object({
      months: z.array(z.object({ hours: z.number().min(0).max(744) })).max(12),
      actual: z
        .object({
          annualCostsPence: z.number().int().min(0),
          businessRooms: z.number().int().min(0),
          totalRooms: z.number().int().min(1),
          businessUseFraction: z.number().min(0).max(1),
        })
        .optional(),
    }),
    response: Est,
  }),
  (c) => {
    const b = c.req.valid("json");
    return c.json(wrap(() => B.homeOffice(b.months, b.actual)) as z.infer<typeof Est>, 200);
  },
);
books.openapi(
  def({
    method: "post",
    path: "/calculators/aia",
    tag: "Books",
    summary: "Annual Investment Allowance estimate",
    body: z.object({
      items: z
        .array(z.object({ costPence: z.number().int().min(0), isCar: z.boolean().optional(), privateUseFraction: z.number().min(0).max(1).optional() }))
        .max(500),
      periodMonths: z.number().int().min(1).max(18).default(12),
    }),
    response: Est,
  }),
  (c) => {
    const b = c.req.valid("json");
    return c.json(wrap(() => B.annualInvestmentAllowance(b.items, b.periodMonths)) as z.infer<typeof Est>, 200);
  },
);
books.openapi(
  def({
    method: "get",
    path: "/tax-estimate",
    tag: "Books",
    summary: "Tax pot estimate for a tax year from the ledger (UNVERIFIED rates; not advice)",
    query: z.object({
      taxYear: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
      otherIncomePence: z.coerce.number().int().min(0).default(0),
    }),
    response: Json,
  }),
  async (c) => {
    const q = c.req.valid("query");
    const ty = q.taxYear ?? B.taxYearOf(today());
    const start = Number(ty.slice(0, 4));
    const db = scope(c);
    const accounts = await chart(db);
    const pnl = B.profitAndLoss(await ledger(db, `${start + 1}-04-05`), accounts, `${start}-04-06`, `${start + 1}-04-05`);
    const s = B.taxSummary(pnl, accounts);
    const est = wrap(() =>
      B.estimateTax({
        turnoverPence: Math.max(0, s.turnoverPence),
        expensesPence: Math.max(0, s.allowableExpensesPence),
        otherIncomePence: q.otherIncomePence,
      }),
    );
    return c.json(
      { taxYear: ty, turnoverPence: s.turnoverPence, allowableExpensesPence: s.allowableExpensesPence, estimate: est } as Record<string, unknown>,
      200,
    );
  },
);
books.openapi(
  def({
    method: "get",
    path: "/deadlines",
    tag: "Books",
    summary: "Upcoming SA, VAT and MTD deadlines (UNVERIFIED dates; reminders are events only)",
    query: z.object({
      today: Day.optional(),
      days: z.coerce.number().int().min(1).max(400).default(90),
      vatFirstPeriodEnd: Day.optional(),
      paymentsOnAccount: z.enum(["true", "false"]).default("false"),
    }),
    response: z.array(Json),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const t = q.today ?? today();
    const ty = B.taxYearOf(t);
    const prev = `${Number(ty.slice(0, 4)) - 1}-${ty.slice(2, 4)}`;
    const tenant = await scope(c).tenantRowStmt("vat_registered").first<{ vat_registered: number }>();
    const all = [
      ...B.saDeadlines(prev, { paymentsOnAccount: q.paymentsOnAccount === "true" }),
      ...B.saDeadlines(ty, { paymentsOnAccount: q.paymentsOnAccount === "true" }),
      ...B.mtdQuarterlyDeadlines(ty),
      ...(tenant?.vat_registered && q.vatFirstPeriodEnd ? B.vatDeadlines(q.vatFirstPeriodEnd, 8) : []),
    ];
    return c.json(B.upcoming(all, t, q.days) as unknown as Record<string, unknown>[], 200);
  },
);

// ---------- mileage log ----------
const Trip = z.object({ id: z.string(), trip_date: z.string(), miles: z.number(), vehicle: z.string(), purpose: z.string().nullable() }).openapi("MileageTrip");
books.openapi(def({ method: "get", path: "/mileage-trips", tag: "Books", summary: "Mileage log", response: z.array(Trip) }), async (c) =>
  c.json(
    await scope(c).all<z.infer<typeof Trip>>(
      "select id, trip_date, miles, vehicle, purpose from mileage_trips where tenant_id = ?1 order by trip_date desc limit 1000",
    ),
    200,
  ),
);
books.openapi(
  def({
    method: "post",
    path: "/mileage-trips",
    tag: "Books",
    summary: "Log a business trip",
    body: z.object({
      tripDate: Day,
      miles: z.number().positive().max(2000),
      vehicle: z.enum(["car_van", "motorcycle", "bicycle"]),
      purpose: z.string().max(200).optional(),
    }),
    response: Trip,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const db = scope(c);
    const id = newId();
    await db.batch([
      db.stmt(
        "insert into mileage_trips (tenant_id, id, trip_date, miles, vehicle, purpose, created_by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        id,
        b.tripDate,
        b.miles,
        b.vehicle,
        b.purpose ?? null,
        actor(c),
      ),
      auditStmt(db, actor(c), "mileage.logged", id, { miles: b.miles, vehicle: b.vehicle }),
    ]);
    return c.json({ id, trip_date: b.tripDate, miles: b.miles, vehicle: b.vehicle, purpose: b.purpose ?? null }, 201);
  },
);
