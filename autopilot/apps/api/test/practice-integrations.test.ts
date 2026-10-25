/** Practice co-pilot M5: integration catalogue + mock ledger sync through the real ingest pipeline. Synthetic. */
import { describe, it, expect, beforeEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";
import { toBankCsv } from "../src/routes/practice-integrations.js";

const M = "manager@firm-a.test",
  PREP = "preparer@firm-a.test",
  PB = "partner@firm-b.test";
let h: ReturnType<typeof makeEnv>, call: ReturnType<typeof client>, tid: string;
beforeEach(async () => {
  h = makeEnv();
  call = client(h.env);
  await call("POST", "/v1/practices", { user: M, body: { name: "Firm A" } });
  await call("POST", "/v1/practice/staff", { user: M, body: { email: PREP, role: "preparer" } });
  await call("POST", "/v1/practices", { user: PB, body: { name: "Firm B" } });
  tid = (await call("POST", "/v1/practice/clients", { user: M, body: { name: "Client (synthetic)" } })).json.tenantId;
});

describe("integrations", () => {
  it("catalogue is honest: only file imports are real", async () => {
    const items = (await call("GET", "/v1/practice/integrations", { user: PREP })).json.items;
    expect(items.find((x: { id: string }) => x.id === "hmrc_mtd_vat").status).toBe("mock");
    expect(items.filter((x: { status: string }) => x.status === "real").map((x: { id: string }) => x.id)).toEqual(["csv_imports"]);
  });
  it.each(["xero", "quickbooks", "freeagent"])("%s mock sync imports, de-duplicates on re-sync, emits integration.synced", async (provider) => {
    const r = await call("POST", `/v1/practice/clients/${tid}/integrations/${provider}/sync`, { user: M, body: { since: "2026-01-01", until: "2026-12-31" } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ provider, mode: "mock" });
    expect(r.json.inserted).toBe(r.json.fetched);
    await runPipeline(h.env, tid, r.json.jobId);
    const again = (
      await call("POST", `/v1/practice/clients/${tid}/integrations/${provider}/sync`, { user: M, body: { since: "2026-01-01", until: "2026-12-31" } })
    ).json;
    expect(again).toMatchObject({ inserted: 0, duplicates: r.json.fetched });
    expect((h.raw.prepare("select count(*) n from events where tenant_id = ? and type = 'integration.synced'").get(tid) as { n: number }).n).toBe(2);
    expect((h.raw.prepare("select count(*) n from transactions where tenant_id = ?").get(tid) as { n: number }).n).toBe(r.json.fetched);
  });
  it("empty window, bad window, roles and isolation", async () => {
    expect(
      (await call("POST", `/v1/practice/clients/${tid}/integrations/xero/sync`, { user: M, body: { since: "2020-01-01", until: "2020-01-31" } })).json,
    ).toMatchObject({ fetched: 0, inserted: 0, jobId: null });
    expect(
      (await call("POST", `/v1/practice/clients/${tid}/integrations/xero/sync`, { user: M, body: { since: "2026-02-01", until: "2026-01-01" } })).status,
    ).toBe(400);
    expect(
      (await call("POST", `/v1/practice/clients/${tid}/integrations/xero/sync`, { user: PREP, body: { since: "2026-01-01", until: "2026-12-31" } })).status,
    ).toBe(403);
    expect(
      (await call("POST", `/v1/practice/clients/${tid}/integrations/xero/sync`, { user: PB, body: { since: "2026-01-01", until: "2026-12-31" } })).status,
    ).toBe(404);
    expect(
      (await call("POST", `/v1/practice/clients/${tid}/integrations/sage/sync`, { user: M, body: { since: "2026-01-01", until: "2026-12-31" } })).status,
    ).toBe(400);
  });
  it("toBankCsv quotes and formats", () => {
    expect(
      toBankCsv([
        { externalId: "x", date: "2026-07-01", description: 'A "quoted", line\nbreak', amountPence: -5, accountCode: null, vatRateCode: null, contact: null },
      ]),
    ).toBe('Date,Description,Amount\n01/07/2026,"A ""quoted"", line break",-0.05\n');
  });
});
