/**
 * Spec-driven authz matrix: EVERY OpenAPI operation x {anonymous, non-member, reviewer, accountant, owner} plus
 * cross-tenant access to another business's resource ids, and error-message leakage checks on every response.
 * Role outcomes are snapshotted so any permission change shows up in review.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";

const spec = JSON.parse(readFileSync(join(__dirname, "../../../openapi/openapi.json"), "utf8")) as { paths: Record<string, Record<string, unknown>> };
const OPS = Object.entries(spec.paths).flatMap(([p, ms]) => Object.keys(ms).map((m) => [m.toUpperCase(), p] as const));
const A = "owner-a@example.test",
  B = "owner-b@example.test",
  R = "reviewer-a@example.test",
  ACC = "accountant-a@example.test",
  NOBODY = "nobody@example.test";
// Things an error body must never contain (stack frames, SQL, driver names, file paths, secrets).
const LEAKS = /\bat \S+ \(|SQLITE|sqlite3|select .* from|insert into|node_modules|\/src\/|D1_ERROR|Bearer ap_|key_hash|\bsecret\b.*[a-f0-9]{24}/i;

const ID_SEGMENTS = new Set(["invoices", "transactions", "jobs", "exceptions", "webhooks", "api-keys"]);
let call: ReturnType<typeof client>;
let ids: Record<string, string>;
beforeAll(async () => {
  const h = makeEnv();
  call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha", vatRegistered: true, vatScheme: "standard" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Beta" } });
  await call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } });
  await call("POST", "/v1/users", { user: A, body: { email: ACC, role: "accountant" } });
  await call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
  const m = h.sent.at(-1)!;
  await runPipeline(h.env, m.tenantId, m.jobId);
  const inv = (
    await call("POST", "/v1/invoices", {
      user: A,
      body: {
        customerName: "Acme",
        issueDate: "2026-07-01",
        dueDate: "2026-07-31",
        lines: [{ description: "d", quantity: 1, unitPence: 100, vatRateCode: "STD" }],
      },
    })
  ).json;
  const txn = (await call("GET", "/v1/transactions?limit=1", { user: A })).json.items[0];
  const job = (await call("GET", "/v1/jobs", { user: A })).json.items[0];
  const ex = (await call("GET", "/v1/exceptions", { user: A })).json.items[0];
  const hook = (await call("POST", "/v1/webhooks", { user: A, body: { url: "https://example.test/hook", events: ["transaction.categorised"] } })).json;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["transactions:read"] } })).json;
  ids = { invoices: inv.id, transactions: txn.id, jobs: job.id, exceptions: ex?.id ?? "x", webhooks: hook.id ?? "x", "api-keys": key.id ?? "x" };
});
function concrete(path: string) {
  const seg = path.split("/")[2] ?? "";
  return path.replace(/\{deliveryId\}/g, "nope").replace(/\{id\}/g, ids[seg] ?? "nonexistent-id");
}
const send = (method: string, path: string, user?: string) =>
  call(method, concrete(path), { ...(user ? { user } : {}), ...(method === "GET" || method === "DELETE" ? {} : { body: {} }) });

describe("authz matrix over every OpenAPI operation", () => {
  it("covers the whole spec", () => expect(OPS.length).toBeGreaterThanOrEqual(130));
  it.each(OPS)("%s %s: anonymous is 401, non-member never succeeds, nothing 5xx, no leaks", async (m, p) => {
    if (p === "/v1/tenants") return; // sign-up endpoint: any authenticated identity may create a business
    const anon = await send(m, p);
    expect(anon.status).toBe(401);
    const nob = await send(m, p, NOBODY);
    expect(nob.status).toBeGreaterThanOrEqual(400);
    for (const u of [R, ACC, A]) {
      const r = await send(m, p, u);
      if (p === "/v1/realtime" && r.status === 503) continue; // realtime DO not bound in tests: documented 503
      expect(r.status, `${u} ${m} ${p}`).toBeLessThan(500);
      if (r.status >= 400) expect(r.text).not.toMatch(LEAKS);
    }
  });
  it.each(OPS.filter(([, p]) => p.includes("{id}") && ID_SEGMENTS.has(p.split("/")[2] ?? "")))(
    "%s %s: another business cannot touch this resource",
    async (m, p) => {
      const r = await send(m, p, B);
      expect(r.status, `${m} ${p} as other tenant`).toBeGreaterThanOrEqual(400);
      expect(r.text).not.toContain("Acme");
    },
  );
  it("role outcomes are stable (snapshot)", async () => {
    const out: Record<string, string> = {};
    for (const [m, p] of OPS) {
      if (m !== "GET") continue; // reads only: writes with empty bodies mostly report validation
      const [r, acc] = [await send(m, p, R), await send(m, p, ACC)];
      out[`${m} ${p}`] = `reviewer=${r.status} accountant=${acc.status}`;
    }
    expect(out).toMatchSnapshot();
  });
});
