/** M6 ops: backup/restore drill (row counts + checksums + audit chain on the restored copy) and practice perf budgets
 * with index checks. 25 API-created clients (trial cap); default 2k bulk txns, PERF=1 250k. Not a 500-client load test. Synthetic. */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeEnv, client } from "./harness.js";
import { verifyAuditChain, type AuditRow } from "../src/lib/practice.js";

const M = "partner@firm-a.test";
type Db = InstanceType<typeof Database>;
const tables = (db: Db) =>
  (
    db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '%_fts%' order by name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
const fingerprint = (db: Db) =>
  Object.fromEntries(
    tables(db).map((t) => {
      const rows = (db.prepare(`select * from "${t}"`).all() as unknown[]).map((r) => JSON.stringify(r)).sort();
      return [t, { n: rows.length, sha: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }];
    }),
  );

async function seedFirm(clients: number) {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/practices", { user: M, body: { name: "Firm A" } });
  const ids: string[] = [];
  for (let i = 0; i < clients; i++)
    ids.push((await call("POST", "/v1/practice/clients", { user: M, body: { name: `Client ${i} (synthetic)` } })).json.tenantId);
  return { h, call, ids };
}

describe("backup/restore drill", () => {
  it("restored copy is identical and its audit chain verifies", async () => {
    const { h, call, ids } = await seedFirm(3);
    await call("POST", `/v1/practice/clients/${ids[0]}/integrations/xero/sync`, { user: M, body: { since: "2026-01-01", until: "2026-12-31" } });
    const dir = mkdtempSync(join(tmpdir(), "drill-"));
    try {
      const t0 = performance.now();
      await (h.raw as Db).backup(join(dir, "backup.db"));
      const restored = new Database(join(dir, "backup.db"), { readonly: true });
      const rto = performance.now() - t0;
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(fingerprint(restored)).toEqual(fingerprint(h.raw as Db));
      const rows = restored.prepare("select * from practice_audit order by seq").all() as AuditRow[];
      expect(rows.length).toBeGreaterThan(3);
      expect((await verifyAuditChain(rows)).ok).toBe(true);
      // Tampering with the restored copy must be detectable.
      expect((await verifyAuditChain(rows.map((r, i) => (i === 1 ? { ...r, action: "forged" } : r)))).brokenAt).toBe(2);
      restored.close();
      expect(rto).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const BIG = process.env.PERF === "1";
describe("practice perf budgets", () => {
  it(
    `practice queries stay within budget (25 clients, ${BIG ? "250k" : "2k"} txns) and use indexes`,
    async () => {
      const [nClients, nTx] = BIG ? [500, 5000] : [100, 200];
      const { h, call, ids } = await seedFirm(Math.min(nClients, 25)); // API-created (trial cap 25); rest bulk-inserted below
      const db = h.raw as Db;
      const pid = (db.prepare("select id from practices").get() as { id: string }).id;
      const insTx = db.prepare(
        "insert into transactions (id, tenant_id, source, txn_date, description, amount_pence) values (?, ?, 'perf', '2026-07-01', 'synthetic', ?)",
      );
      db.transaction(() => {
        for (const [ci, t] of ids.entries()) for (let i = 0; i < Math.ceil((nTx * nClients) / ids.length / 10); i++) insTx.run(`tx_${ci}_${i}`, t, i);
      })();
      const t0 = performance.now();
      const list = await call("GET", "/v1/practice/clients", { user: M });
      const t1 = performance.now();
      const anomalies = await call("GET", "/v1/practice/anomalies", { user: M });
      const t2 = performance.now();
      expect(list.status).toBe(200);
      expect(anomalies.status).toBe(200);
      expect(t1 - t0).toBeLessThan(BIG ? 5_000 : 1_500);
      expect(t2 - t1).toBeLessThan(BIG ? 20_000 : 5_000);
      const plan = (sql: string) => (db.prepare(`explain query plan ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
      expect(plan(`select * from document_requests where practice_id = '${pid}' and status = 'open'`)).toMatch(/USING (COVERING )?INDEX/);
      expect(plan(`select * from portal_users where practice_id = '${pid}'`)).toMatch(/USING (COVERING )?INDEX/);
      expect(plan(`select * from engagements where practice_id = '${pid}' and status = 'sent'`)).toMatch(/USING (COVERING )?INDEX/);
      expect(plan(`select * from practice_rules where practice_id = '${pid}' and status = 'active'`)).toMatch(/USING (COVERING )?INDEX/);
      expect(plan(`select * from transactions where tenant_id = 'x'`)).toMatch(/USING (COVERING )?INDEX/);
    },
    BIG ? 600_000 : 60_000,
  );
});
