/**
 * Seeds the local SQLite DB (autopilot/.local) with SYNTHETIC data only: two tenants, a reviewer,
 * a bank statement run through the real pipeline, invoices and a VAT draft. Idempotent: re-running skips existing tenants.
 * Usage: npm run seed   (AUTOPILOT_DATA_DIR overrides the data directory)
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../apps/api/src/app.js";
import { makeLocalEnv } from "../apps/api/dev/local-env.js";
import { runPipeline } from "../apps/api/src/services/pipeline.js";

const HERE = fileURLToPath(import.meta.url).replace(/[\\/][^\\/]*$/, "");
const dataDir = resolve(process.env.AUTOPILOT_DATA_DIR ?? join(HERE, "../.local"));
const { env, raw } = makeLocalEnv(dataDir);
env.PIPELINE = { send: async () => {} } as never; // seed runs the pipeline synchronously below
const app = createApp();

async function call(user: string, method: string, path: string, body?: unknown, ct = "application/json") {
  const res = await app.request(path, { method, headers: { "x-dev-user": user, "content-type": ct }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) }, env);
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json!;
}

export const SEED_CSV = `Date,Description,Amount
01/07/2026,STRIPE PAYOUT REF 8821,1200.00
03/07/2026,CARD PAYMENT TRAINLINE LONDON,-45.60
05/07/2026,STAPLES OFFICE SUPPLIES,-23.99
08/07/2026,VODAFONE UK DD,-30.00
10/07/2026,INVOICE 1043 ACME DESIGN LTD,850.00
12/07/2026,GITHUB INC,-3.20
18/07/2026,SHELL FUEL A40,-62.10
21/07/2026,MONTHLY ACCOUNT FEE,-5.00
24/07/2026,WHOLESALE SUPPLIER LTD STOCK,-400.00
28/07/2026,MYSTERY PAYEE 99,-80.00
30/07/2026,TRANSFER TO SAVINGS,-500.00
04/08/2026,REFUND STAPLES OFFICE SUPPLIES,23.99
14/08/2026,AMAZON MARKETPLACE,-64.50
`;

const OWNER = "demo.owner@example.test";
const exists = raw.prepare("select 1 from users where email = ?").get(OWNER);
if (exists) {
  console.log("seed: already seeded (delete .local/ to reset)");
} else {
  const t = await call(OWNER, "POST", "/v1/tenants", { name: "Demo Design Studio (synthetic)", vatRegistered: true, vatScheme: "standard" });
  await call(OWNER, "POST", "/v1/users", { email: "demo.reviewer@example.test", role: "reviewer", displayName: "Demo Reviewer" });
  const up = await call(OWNER, "POST", "/v1/uploads/bank-csv", SEED_CSV, "text/csv");
  const sum = await runPipeline(env, t.id as string, up.jobId as string, undefined);
  const inv = { customerName: "Acme Design Ltd (synthetic)", issueDate: "2026-07-02", dueDate: "2026-08-01", lines: [{ description: "Brand refresh", quantity: 1, unitPence: 70833, vatRateCode: "STD" }] };
  const i1 = await call(OWNER, "POST", "/v1/invoices", inv);
  await call(OWNER, "POST", `/v1/invoices/${i1.id}/status`, { status: "sent" });
  await call(OWNER, "POST", "/v1/invoices", { ...inv, issueDate: "2026-08-10", dueDate: "2026-09-09" });
  await call(OWNER, "POST", "/v1/vat/drafts", { periodStart: "2026-07-01", periodEnd: "2026-09-30" });
  await call("demo.other@example.test", "POST", "/v1/tenants", { name: "Other Tenant (synthetic)" });
  console.log(`seed: tenant ${t.id}, ${up.inserted} transactions, ${sum.exceptions} exceptions, QA ${sum.qaScore}. Sign in locally as ${OWNER}`);
}
raw.close();
