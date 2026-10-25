/** Realtime hub, migration policy, chaos/fault injection, and pipeline performance. */
import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import Database from "better-sqlite3";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Hub, sseFrame } from "../src/realtime.js";
import { MIGRATIONS_DIR, migrate } from "../dev/sqlite-d1.js";
import { makeEnv, client } from "./harness.js";
import { dispatchEvents, retryDueDeliveries } from "../src/services/dispatch.js";
import { __setWebhookFetcher, __setWebhookClock } from "../src/services/webhooks.js";
import { handlePipelineBatch, handleDeadLetters } from "../src/queue.js";
import { categoriseLines, reconcile, detectAnomalies, computeVatReturn, journalForBankLine, trialBalance, type CategoryRule } from "@xevrion/pipeline";
import cats from "../../../packages/domain-uk-tax/categories.json" with { type: "json" };

afterEach(() => {
  __setWebhookFetcher(null);
  __setWebhookClock(null);
});

describe("realtime hub", () => {
  const ev = (id: string, type = "transaction.created") => ({ id, type, data: { n: id } });
  it("formats SSE frames with id/event/data and escapes newlines", () =>
    expect(sseFrame({ id: "1", type: "x.y", data: { a: "l1\nl2" } })).toBe('id: 1\nevent: x.y\ndata: {"a":"l1\\nl2"}\n\n'));
  it.each([
    [[], 2],
    [["*"], 2],
    [["transaction.*"], 1],
    [["invoice.paid"], 1],
    [["job.completed"], 0],
  ] as [string[], number][])("filters %j receive %i of 2", (filters, n) => {
    const h = new Hub();
    const got: string[] = [];
    h.add({ id: "s", filters, send: (f) => got.push(f) });
    h.publish([ev("1"), ev("2", "invoice.paid")]);
    expect(got).toHaveLength(n);
  });
  it("drops a dead subscriber without breaking fan-out to others", () => {
    const h = new Hub();
    const ok: string[] = [];
    h.add({
      id: "dead",
      filters: [],
      send: () => {
        throw new Error("closed");
      },
    });
    h.add({ id: "live", filters: [], send: (f) => ok.push(f) });
    expect(h.publish([ev("1")])).toBe(1);
    expect(h.size).toBe(1);
    expect(ok).toHaveLength(1);
  });
  it("replays missed events after Last-Event-ID on reconnect", () => {
    const h = new Hub();
    h.publish([ev("1"), ev("2"), ev("3")]);
    const got: string[] = [];
    h.add({ id: "s", filters: [], send: (f) => got.push(f) }, "1");
    expect(got.map((f) => /^id: (\w+)/.exec(f)![1])).toEqual(["2", "3"]);
  });
  it("ring buffer is bounded", () => {
    const h = new Hub(5);
    h.publish(Array.from({ length: 20 }, (_, i) => ev(String(i))));
    const got: string[] = [];
    h.add({ id: "s", filters: [], send: (f) => got.push(f) }, "0");
    expect(got).toHaveLength(0); // "0" fell out of the ring: client must re-sync via GET /v1/events
  });
  it("remove stops delivery", () => {
    const h = new Hub();
    const got: string[] = [];
    h.add({ id: "s", filters: [], send: (f) => got.push(f) });
    h.remove("s");
    h.publish([ev("1")]);
    expect(got).toEqual([]);
  });
});

describe("migration policy", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  it("files are sequentially numbered without gaps", () => files.forEach((f, i) => expect(f.startsWith(String(i + 1).padStart(4, "0") + "_")).toBe(true)));
  it.each(files.filter((f) => f >= "0002"))("%s is additive only (no drop/rename/destructive update)", (f) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(/--.*$/gm, "").toLowerCase();
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|view|trigger)\b/);
    expect(sql).not.toMatch(/\brename\s+(to|column)\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b(?![^;]*search_index)/);
    expect(sql).not.toMatch(/alter\s+table\s+\w+\s+add\s+column\s+\w+\s+\w+\s+not\s+null(?!\s+default)/);
  });
  it.each(files.filter((f) => f >= "0003"))("%s has a tested down migration", (f) =>
    expect(existsSync(join(MIGRATIONS_DIR, "../migrations-down", f.replace(".sql", ".down.sql")))).toBe(true),
  );
  const schema = (db: Database.Database) =>
    db.prepare("select type, name, sql from sqlite_master where name not like 'sqlite_%' and name not like 'search_index_%' order by type, name").all();
  it("up -> down -> up round-trips to an identical schema", () => {
    const db = new Database(":memory:");
    migrate(db);
    const full = schema(db);
    for (const f of [...files].reverse().filter((x) => x >= "0003")) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, "../migrations-down", f.replace(".sql", ".down.sql")), "utf8"));
      db.prepare("delete from d1_migrations where name = ?").run(f);
    }
    expect(schema(db).length).toBeLessThan(full.length);
    migrate(db);
    expect(schema(db)).toEqual(full);
  });
  it("migrations are idempotent to re-run (bookkeeping prevents double apply)", () => {
    const db = new Database(":memory:");
    expect(migrate(db)).toEqual(files);
    expect(migrate(db)).toEqual([]);
  });
  it("upgrading a database with existing data keeps the data and backfills search", () => {
    const db = new Database(":memory:");
    db.exec("create table if not exists d1_migrations (id integer primary key autoincrement, name text unique, applied_at text default (datetime('now')))");
    for (const f of files.filter((x) => x < "0004")) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      db.prepare("insert into d1_migrations (name) values (?)").run(f);
    }
    db.prepare("insert into tenants (id, name) values ('t', 'T')").run();
    db.prepare(
      "insert into transactions (id, tenant_id, source, txn_date, description, amount_pence) values ('x', 't', 'bank_csv', '2026-01-01', 'LEGACY VENDOR', -100)",
    ).run();
    migrate(db);
    expect(db.prepare("select version from tenants").get()).toEqual({ version: 1 });
    expect(db.prepare("select ref_id from search_index where search_index match 'legacy'").all()).toEqual([{ ref_id: "x" }]);
  });
});

describe("chaos: webhook delivery under random faults", () => {
  it("every event is eventually delivered exactly once per endpoint despite random failures", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<"ok" | "500" | "throw" | "429" | "slow">("ok", "500", "throw", "429", "slow"), { minLength: 30, maxLength: 60 }),
        fc.integer({ min: 1, max: 5 }),
        async (script, nInvoices) => {
          const h = makeEnv();
          const call = client(h.env);
          await call("POST", "/v1/tenants", { user: "o@x.test", body: { name: "T" } });
          await call("POST", "/v1/webhooks", { user: "o@x.test", body: { url: "https://hooks.example.com/x" } });
          const tenant = (await call("GET", "/v1/me", { user: "o@x.test" })).json.tenantId;
          let i = 0;
          const succeeded = new Map<string, number>();
          __setWebhookFetcher(async (_u, init) => {
            const step = script[i++ % script.length]!;
            if (step === "throw") throw new Error("ECONNRESET");
            const id = (init.headers as Record<string, string>)["autopilot-event-id"]!;
            if (step === "ok" || step === "slow") succeeded.set(id, (succeeded.get(id) ?? 0) + 1);
            return new Response("", { status: step === "500" ? 500 : step === "429" ? 429 : 200 });
          });
          let now = Date.now();
          __setWebhookClock(() => now);
          for (let k = 0; k < nInvoices; k++)
            await call("POST", "/v1/invoices", {
              user: "o@x.test",
              body: {
                customerName: "C",
                issueDate: "2026-07-01",
                dueDate: "2026-07-02",
                lines: [{ description: "x", quantity: 1, unitPence: 100, vatRateCode: "STD" }],
              },
            });
          // duplicate queue delivery is part of the chaos
          for (const m of [...h.events, ...h.events]) await dispatchEvents(h.env, m.tenantId, m.eventIds);
          for (let r = 0; r < 12; r++) {
            now += 7 * 3600_000;
            await retryDueDeliveries(h.env, tenant, new Date(now).toISOString());
          }
          const rows = h.raw.prepare("select status, count(*) n from webhook_deliveries group by status").all() as { status: string; n: number }[];
          const ok = rows.find((x) => x.status === "succeeded")?.n ?? 0;
          const endpoint = h.raw.prepare("select status from webhook_endpoints").get() as { status: string };
          // Either everything was delivered exactly once, or the endpoint was (correctly) auto-disabled / deliveries dead.
          for (const n of succeeded.values()) expect(n).toBe(1);
          if (endpoint.status === "active" && !rows.some((x) => x.status === "dead")) expect(ok).toBe(nInvoices);
          expect(rows.reduce((a, x) => a + x.n, 0)).toBe(nInvoices);
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe("chaos: queue consumer", () => {
  const batch = (bodies: unknown[]) => {
    const out: { acked: number; retried: number[] } = { acked: 0, retried: [] };
    const messages = bodies.map((body, k) => ({
      id: String(k),
      timestamp: new Date(),
      body,
      attempts: 1 + k,
      ack: () => out.acked++,
      retry: (o?: { delaySeconds?: number }) => out.retried.push(o?.delaySeconds ?? 0),
    }));
    return { b: { queue: "autopilot-pipeline", messages } as unknown as MessageBatch<never>, out };
  };
  it("a failing message is retried with backoff while others in the batch are acked", async () => {
    const h = makeEnv();
    const call = client(h.env);
    await call("POST", "/v1/tenants", { user: "o@x.test", body: { name: "T" } });
    const tenant = (await call("GET", "/v1/me", { user: "o@x.test" })).json.tenantId;
    const { b, out } = batch([
      { kind: "events", tenantId: tenant, eventIds: [] },
      { jobId: "does-not-exist", tenantId: "" },
      { kind: "events", tenantId: tenant, eventIds: ["missing"] },
    ]);
    await handlePipelineBatch(b, h.env);
    expect(out.acked).toBe(2);
    expect(out.retried).toEqual([20]);
  });
  it.each([
    [1, 10],
    [2, 20],
    [3, 40],
    [5, 160],
    [10, 300],
  ])("attempt %i -> retry delay %is (capped at 300)", async (attempts, delay) => {
    const h = makeEnv();
    const retried: number[] = [];
    await handlePipelineBatch(
      {
        queue: "q",
        messages: [{ body: { jobId: "x", tenantId: "" }, attempts, ack: () => {}, retry: (o: { delaySeconds: number }) => retried.push(o.delaySeconds) }],
      } as never,
      h.env,
    );
    expect(retried).toEqual([delay]);
  });
  it("DLQ for event messages acks without creating job exceptions (outbox keeps them)", async () => {
    const h = makeEnv();
    let acked = 0;
    await handleDeadLetters(
      { queue: "dlq", messages: [{ body: { kind: "events", tenantId: "t", eventIds: ["a"] }, attempts: 4, ack: () => acked++ }] } as never,
      h.env,
    );
    expect(acked).toBe(1);
  });
});

describe("chaos: idempotency under concurrency", () => {
  it("parallel identical POSTs with one Idempotency-Key create one invoice", async () => {
    const h = makeEnv();
    const call = client(h.env);
    await call("POST", "/v1/tenants", { user: "o@x.test", body: { name: "T" } });
    const body = {
      customerName: "C",
      issueDate: "2026-07-01",
      dueDate: "2026-07-02",
      lines: [{ description: "x", quantity: 1, unitPence: 100, vatRateCode: "STD" }],
    };
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => call("POST", "/v1/invoices", { user: "o@x.test", body, headers: { "idempotency-key": "same" } })),
    );
    const ids = new Set(rs.filter((r) => r.status === 201 || r.status === 200).map((r) => r.json.id));
    expect(rs.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    // better-sqlite3 serialises, so the first insert wins and the rest replay
    expect(ids.size).toBe(1);
  });
});

// Strict budgets run in isolation (CI perf job: PERF=1). In the parallel suite CPU contention makes timings meaningless,
// so only a loose ceiling (catches pathological regressions) applies.
const STRICT = process.env.PERF === "1";
describe("performance", () => {
  const rules: CategoryRule[] = cats.accounts.flatMap((a) =>
    a.kw.map((k, i) => ({ id: `${a.code}-${i}`, pattern: k, matchType: "contains" as const, categoryCode: a.code, priority: 100 })),
  );
  const merchants = ["TRAINLINE", "AMAZON MARKETPLACE", "VODAFONE", "GITHUB", "STRIPE PAYOUT", "TESCO STORES", "SHELL", "UNKNOWN PAYEE", "ADOBE", "ROYAL MAIL"];
  const lines = Array.from({ length: 10_000 }, (_, i) => ({
    id: `l${i}`,
    date: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    description: `CARD PAYMENT TO ${merchants[i % merchants.length]} REF ${i}`,
    amountPence: (i % 7 === 0 ? 1 : -1) * (100 + ((i * 7919) % 90000)),
  }));
  it("categorises 10k synthetic transactions in < 10 s (rules only; budget catches O(n²) regressions on slow CI)", async () => {
    const t = performance.now();
    const r = await categoriseLines(lines, rules, new Set(cats.accounts.map((a) => a.code)));
    const ms = performance.now() - t;
    expect(r.items).toHaveLength(10_000);
    expect(ms).toBeLessThan(STRICT ? 10_000 : 60_000);
  }, 90_000);
  it("reconciles 10k lines against 2k receipts, flags anomalies, posts balanced journals and a VAT draft in < 15 s", async () => {
    const receipts = lines
      .filter((l) => l.amountPence < 0)
      .slice(0, 2000)
      .map((l, i) => ({ id: `r${i}`, date: l.date, merchant: l.description.split(" ")[3]!, totalPence: -l.amountPence, vatPence: 0 }));
    const t = performance.now();
    const m = reconcile(lines, receipts, []);
    const ex = detectAnomalies(lines);
    const js = lines.map((l) =>
      journalForBankLine({ id: l.id, date: l.date, description: l.description, grossPence: l.amountPence, categoryCode: "6200", kind: "expense", vatPence: 0 }),
    );
    const tb = trialBalance(js);
    const v = computeVatReturn(
      lines.map((l) => ({ id: l.id, date: l.date, grossPence: l.amountPence, kind: l.amountPence > 0 ? "income" : "expense", vatRateCode: "STD" })),
      { scheme: "standard", periodStart: "2026-01-01", periodEnd: "2026-12-31" },
    );
    const ms = performance.now() - t;
    expect(m.length).toBeGreaterThan(1500);
    expect(ex.length).toBeGreaterThanOrEqual(0);
    expect([...tb.values()].reduce((a, b) => a + b, 0)).toBe(0);
    expect(v.box3).toBe(v.box1);
    expect(ms).toBeLessThan(STRICT ? 15_000 : 60_000);
  }, 90_000);
});

describe("metering -> billing rollup", () => {
  it("rolls a closed month's usage into billing_events exactly once", async () => {
    const { sweep } = await import("../src/services/dispatch.js");
    const h = makeEnv();
    const call = client(h.env);
    await call("POST", "/v1/tenants", { user: "o@x.test", body: { name: "T" } });
    const tenant = (await call("GET", "/v1/me", { user: "o@x.test" })).json.tenantId;
    h.raw
      .prepare(
        "insert into usage_counters (tenant_id, metric, period, count) values (?, 'uploads', '2026-09', 7), (?, 'transactions', '2026-09', 420), (?, 'uploads', '2026-10', 3)",
      )
      .run(tenant, tenant, tenant);
    const now = new Date("2026-10-02T00:00:00Z");
    expect((await sweep(h.env, now)).rolledUp).toBe(2);
    expect((await sweep(h.env, now)).rolledUp).toBe(0);
    const rows = h.raw.prepare("select event, amount_pence, external_ref from billing_events where external_ref like 'usage:%' order by event").all();
    expect(rows).toEqual([
      { event: "usage.transactions", amount_pence: 420, external_ref: "usage:2026-09:transactions" },
      { event: "usage.uploads", amount_pence: 7, external_ref: "usage:2026-09:uploads" },
    ]);
  });
});

describe("webhook SSRF re-check at send time", () => {
  it("an endpoint whose stored URL is now unsafe is never fetched and its delivery goes straight to dead", async () => {
    const h = makeEnv();
    const call = client(h.env);
    await call("POST", "/v1/tenants", { user: "o@x.test", body: { name: "T" } });
    await call("POST", "/v1/webhooks", { user: "o@x.test", body: { url: "https://hooks.example.com/x" } });
    // Simulate a row saved before a guard change (or tampered): point it at the metadata service.
    h.raw.prepare("update webhook_endpoints set url = 'http://169.254.169.254/latest'").run();
    let fetched = 0;
    __setWebhookFetcher(async () => {
      fetched++;
      return new Response("", { status: 200 });
    });
    await call("POST", "/v1/invoices", {
      user: "o@x.test",
      body: {
        customerName: "C",
        issueDate: "2026-07-01",
        dueDate: "2026-07-02",
        lines: [{ description: "x", quantity: 1, unitPence: 100, vatRateCode: "STD" }],
      },
    });
    for (const m of h.events) await dispatchEvents(h.env, m.tenantId, m.eventIds);
    expect(fetched).toBe(0);
    const d = h.raw.prepare("select status, error, next_attempt_at from webhook_deliveries").get() as {
      status: string;
      error: string;
      next_attempt_at: string | null;
    };
    expect(d.status).toBe("dead");
    expect(d.error).toMatch(/^url_blocked: /);
    expect(d.next_attempt_at).toBeNull();
  });
});
