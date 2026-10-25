/**
 * Performance guards: N+1 detection (query count must not grow with data), 10k-row tenant budgets, streaming export
 * correctness, and per-API-key rate limits. 100k budgets run only with PERF=1 (isolated CI perf job / manual).
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { __setRateLimitClock } from "../src/lib/ratelimit.js";

const A = "owner-a@example.test";
const STRICT = process.env.PERF === "1";

async function world(nTx: number, nInv = 0, over = {}) {
  const h = makeEnv(over);
  let queries = 0;
  const prep = h.env.DB.prepare.bind(h.env.DB);
  h.env.DB.prepare = ((sql: string) => {
    queries++;
    return prep(sql);
  }) as typeof h.env.DB.prepare;
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Perf (synthetic)" } });
  const tid = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  const ins = h.raw.prepare(
    "insert into transactions (tenant_id, id, source, txn_date, description, amount_pence, currency, fingerprint, status, created_at) values (?, ?, 'csv', ?, ?, ?, 'GBP', ?, 'new', ?)",
  );
  h.raw.transaction(() => {
    for (let i = 0; i < nTx; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + (i % 365) * 86400000).toISOString().slice(0, 10);
      ins.run(
        tid,
        `t${i}`,
        d,
        `SYNTHETIC MERCHANT ${i % 97}`,
        i % 3 ? -(100 + (i % 5000)) : 25000 + i,
        `fp${i}`,
        `2026-01-01 00:00:${String(i % 60).padStart(2, "0")}`,
      );
    }
  })();
  for (let i = 0; i < nInv; i++) {
    const inv = (
      await call("POST", "/v1/invoices", {
        user: A,
        body: {
          customerName: `C${i}`,
          issueDate: "2026-01-01",
          dueDate: "2026-01-31",
          lines: [{ description: "d", quantity: 1, unitPence: 1000, vatRateCode: "STD" }],
        },
      })
    ).json;
    await call("POST", `/v1/invoices/${inv.id}/status`, { user: A, body: { status: "sent" } });
  }
  const count = async (path: string) => {
    queries = 0;
    const r = await call("GET", path, { user: A });
    expect(r.status, path).toBe(200);
    return queries;
  };
  return { ...h, call, tid, count };
}
afterEach(() => __setRateLimitClock(null));

describe("N+1 detection: query count is independent of data size", () => {
  it.each(["/v1/transactions?limit=100", "/v1/invoices", "/v1/receivables/aged", "/v1/onboarding", "/v1/ops/summary", "/v1/exceptions", "/v1/books/recurring"])(
    "%s",
    async (path) => {
      const small = await (await world(20, 2)).count(path);
      const large = await (await world(400, 12)).count(path);
      expect(large).toBe(small);
    },
  );
});

describe("10k-transaction tenant budgets", () => {
  it("list, report, assistant and streamed export stay within budget; export is complete and ordered", async () => {
    const w = await world(10_000);
    const budget = STRICT ? 1 : 4; // relaxed in the parallel suite (CPU contention)
    const time = async (method: string, path: string, body?: unknown) => {
      const t = performance.now();
      const r = await w.call(method, path, { user: A, ...(body ? { body } : {}) });
      expect(r.status, path).toBe(200);
      return { ms: performance.now() - t, r };
    };
    expect((await time("GET", "/v1/transactions?limit=200")).ms).toBeLessThan(250 * budget);
    expect((await time("GET", "/v1/books/reports/pnl?from=2026-01-01&to=2026-12-31")).ms).toBeLessThan(1500 * budget);
    expect((await time("POST", "/v1/assistant/ask", { question: "What did I spend in 2026?", today: "2026-12-31" })).ms).toBeLessThan(1500 * budget);
    const ex = await time("GET", "/v1/export/transactions.csv");
    expect(ex.ms).toBeLessThan(2500 * budget);
    const rows = ex.r.text.trimEnd().split("\n");
    expect(rows).toHaveLength(10_001);
    const dates = rows.slice(1).map((l) => l.slice(0, 10));
    expect([...dates].sort()).toEqual(dates);
  }, 120_000);
  it.skipIf(!STRICT)(
    "100k transactions: first page < 300 ms, export < 20 s",
    async () => {
      const w = await world(100_000);
      let t = performance.now();
      expect((await w.call("GET", "/v1/transactions?limit=200", { user: A })).status).toBe(200);
      expect(performance.now() - t).toBeLessThan(300);
      t = performance.now();
      const r = await w.call("GET", "/v1/export/transactions.csv", { user: A });
      expect(r.text.trimEnd().split("\n")).toHaveLength(100_001);
      expect(performance.now() - t).toBeLessThan(20_000);
    },
    300_000,
  );
});

describe("rate limits per API key", () => {
  it("each key has its own bucket and the interactive user is unaffected", async () => {
    __setRateLimitClock(() => 1_000_000);
    const w = await world(1, 0, { RATE_LIMIT_API_KEY_PER_MINUTE: "3", RATE_LIMIT_PER_MINUTE: "1000" });
    const mk = async (name: string) => (await w.call("POST", "/v1/api-keys", { user: A, body: { name, scopes: ["transactions:read"] } })).json.key as string;
    const [k1, k2] = [await mk("k1"), await mk("k2")];
    const get = (k: string) => w.call("GET", "/v1/transactions", { headers: { authorization: `Bearer ${k}` } });
    const s1 = [await get(k1), await get(k1), await get(k1), await get(k1)].map((r) => r.status);
    expect(s1).toEqual([200, 200, 200, 429]);
    expect((await get(k2)).status).toBe(200);
    expect((await w.call("GET", "/v1/transactions", { user: A })).status).toBe(200);
    const r = await get(k1);
    expect(r.headers.get("ratelimit-limit")).toBe("3");
    expect(r.headers.get("retry-after")).toBeTruthy();
  });
});

describe("global body limit", () => {
  it("rejects oversized JSON bodies with 413 before parsing, and allows normal bodies", async () => {
    const w = await world(0);
    const huge = { customerName: "x".repeat(3 * 1024 * 1024), issueDate: "2026-01-01", dueDate: "2026-01-31", lines: [] };
    const r = await w.call("POST", "/v1/invoices", { user: A, body: huge });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("payload_too_large");
    expect(r.json.error.requestId).toBeTruthy();
    expect(JSON.stringify(r.json)).not.toMatch(/stack|at \w+ \(/);
  });
});

describe("dev identity header fails closed", () => {
  it.each(["production", "staging", "", undefined])("ENVIRONMENT=%s ignores x-dev-user", async (e) => {
    const h = makeEnv({ ENVIRONMENT: e as never });
    const r = await client(h.env)("GET", "/v1/me", { user: A });
    expect(r.status).toBe(401);
  });
});

describe("log redaction", () => {
  it("masks credential-shaped keys and values", async () => {
    const { log } = await import("../src/lib/log.js");
    const lines: string[] = [];
    const orig = console.error;
    console.error = (l: string) => void lines.push(l);
    try {
      log("error", "x", {
        apiKey: "ap_live_abcdef123",
        err: "fetch https://h/x?token=s3cr3t failed Bearer abc.def ap_test_zzz eyJhbGciOiJIUzI1.eyJzdWIi.sig",
        ok: "fine",
      });
    } finally {
      console.error = orig;
    }
    expect(lines[0]).not.toMatch(/s3cr3t|abcdef123|abc\.def|ap_test_zzz|eyJzdWIi/);
    expect(lines[0]).toContain('"ok":"fine"');
  });
});

describe("maintenance write freeze", () => {
  it("MAINTENANCE=1 returns 503 on writes but keeps reads working", async () => {
    const h = makeEnv();
    const call = client(h.env);
    await call("POST", "/v1/tenants", { user: A, body: { name: "M (synthetic)" } });
    h.env.MAINTENANCE = "1";
    const w = await call("POST", "/v1/invoices", { user: A, body: { customerName: "C", issueDate: "2026-01-01", dueDate: "2026-01-31", lines: [] } });
    expect(w.status).toBe(503);
    expect(w.json.error.code).toBe("maintenance");
    expect((await call("GET", "/v1/me", { user: A })).status).toBe(200);
  });
});
