/**
 * Scale seed for the TEST deployment, SYNTHETIC data only. Builds a practice with N clients x M bank lines by
 * calling the real API in-process against a throwaway local SQLite DB (so every row is valid for the current schema
 * and goes through the real import + pipeline), then writes plain INSERT statements to an .sql file that
 * `wrangler d1 execute <test-db> --remote --file` can load. It never talks to Cloudflare itself.
 *   npx tsx scripts/scale-seed.ts --clients 500 --lines 20 --out /tmp/scale.sql
 * Prints row counts plus an estimate of D1 "rows written" (rows x (1 + indexes)) to check free-plan headroom first.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/api/src/app.js";
import { makeLocalEnv } from "../apps/api/dev/local-env.js";
import { runPipeline } from "../apps/api/src/services/pipeline.js";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const CLIENTS = Number(arg("clients", "500"));
const LINES = Number(arg("lines", "20"));
const OUT = arg("out", "scale.sql");
const OWNER = "scale.partner@example.test";
const VENDORS = ["STRIPE PAYOUT", "TOOLSTATION", "SHELL FUEL", "VODAFONE LTD", "GITHUB INC", "BOOKER WHOLESALE", "AMAZON MARKETPLACE", "MYSTERY PAYEE"];

const { env, raw } = makeLocalEnv(mkdtempSync(join(tmpdir(), "scale-")));
env.PIPELINE = { send: async () => {} } as never;
const app = createApp();
async function call(method: string, path: string, body?: unknown, ct = "application/json") {
  const res = await app.request(
    path,
    {
      method,
      headers: { "x-dev-user": OWNER, "content-type": ct },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    },
    env,
  );
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(j)}`);
  return j!;
}

const t0 = performance.now();
await call("POST", "/v1/practices", { name: "Scale Test Practice (synthetic)" });
raw.prepare("update practices set plan = 'practice'").run(); // 500-client plan; synthetic test only
for (let c = 0; c < CLIENTS; c++) {
  const { tenantId } = (await call("POST", "/v1/practice/clients", { name: `Scale Client ${c + 1} (synthetic)` })) as { tenantId: string };
  const rows = Array.from({ length: LINES }, (_, i) => {
    const v = VENDORS[(c + i) % VENDORS.length]!;
    const amt = v === "STRIPE PAYOUT" ? 100 + ((c * 7 + i) % 900) : -(5 + ((c * 13 + i * 3) % 400));
    return `2026-09-${String((i % 28) + 1).padStart(2, "0")},${v} ${(c * LINES + i) % 997},${amt.toFixed(2)}`;
  });
  const imp = (await call("POST", `/v1/practice/clients/${tenantId}/imports/bank-csv`, `date,description,amount\n${rows.join("\n")}\n`, "text/csv")) as {
    jobId: string;
  };
  await runPipeline(env, tenantId, imp.jobId, undefined);
}
const seedMs = performance.now() - t0;

const q = (v: unknown) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : typeof v === "bigint" ? v.toString() : `'${String(v).replace(/'/g, "''")}'`;
const tables = (
  raw
    .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'd1_%' and name not like 'search_index%'")
    .all() as { name: string }[]
).map((r) => r.name);
const out: string[] = ["PRAGMA defer_foreign_keys = true;"];
let rows = 0;
let est = 0;
const counts: Record<string, number> = {};
for (const t of tables) {
  const all = raw.prepare(`select * from "${t}"`).all() as Record<string, unknown>[];
  if (!all.length) continue;
  const idx = (raw.prepare(`select count(*) n from sqlite_master where type='index' and tbl_name = ?`).get(t) as { n: number }).n;
  counts[t] = all.length;
  rows += all.length;
  est += all.length * (1 + idx);
  const cols = Object.keys(all[0]!);
  for (let i = 0; i < all.length; i += 50)
    out.push(
      `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${all
        .slice(i, i + 50)
        .map((r) => `(${cols.map((c) => q(r[c])).join(",")})`)
        .join(",")};`,
    );
}
writeFileSync(OUT, out.join("\n") + "\n");
console.log(
  JSON.stringify(
    { clients: CLIENTS, linesPerClient: LINES, seedSeconds: +(seedMs / 1000).toFixed(1), rows, estimatedRowsWritten: est, counts, out: OUT },
    null,
    1,
  ),
);
