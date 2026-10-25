/**
 * Practice co-pilot API, part 5: integrations (ADR 0027). Honest catalogue of what is real vs mock, plus a per-client
 * ledger sync that runs a MOCK Xero/QuickBooks/FreeAgent adapter through the same dedupe + categorisation pipeline as
 * a real CSV import. No network calls are made.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import * as B from "@xevrion/books";
import type { AppEnv } from "../env.js";
import { TenantDb } from "../lib/db.js";
import { badRequest } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import { PracticeAudit, accessibleClient, practiceDb, requirePracticeRole } from "../lib/practice.js";
import { Outbox } from "../services/events.js";
import { ingestBankCsv } from "../services/ingest.js";
import { MANAGERS } from "./practice.js";

export const integrations = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TAG = "Practice integrations";

integrations.openapi(
  def({
    method: "get",
    path: "/practice/integrations",
    tag: TAG,
    summary: "What integrations exist and how real each one is (real / mock / interface)",
    response: z.object({ items: z.array(z.object({ id: z.string(), kind: z.string(), status: z.enum(["real", "mock", "interface"]), note: z.string() })) }),
  }),
  (c) => c.json({ items: B.INTEGRATION_CATALOG.map((x) => ({ ...x })) }, 200),
);

/** Renders mapped transactions as the bank CSV the ingest pipeline already understands (quoted, dd/mm/yyyy). */
export function toBankCsv(txns: B.ExtTransaction[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
  const d = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const amt = (p: number) => `${p < 0 ? "-" : ""}${(Math.abs(p) / 100).toFixed(2)}`;
  return ["Date,Description,Amount", ...txns.map((t) => `${d(t.date)},${q(t.description)},${amt(t.amountPence)}`)].join("\n") + "\n";
}
integrations.use("/practice/clients/:id/integrations/*", requirePracticeRole(...MANAGERS));
integrations.openapi(
  def({
    method: "post",
    path: "/practice/clients/{id}/integrations/{provider}/sync",
    tag: TAG,
    summary: "Pull transactions from a client's ledger (MOCK adapter) into Autopilot via the normal dedupe + categorisation pipeline",
    params: z.object({ id: z.string().min(1).max(64), provider: z.enum(["xero", "quickbooks", "freeagent"]) }),
    body: z.object({ since: Day, until: Day }),
    response: z.object({
      provider: z.string(),
      mode: z.enum(["mock", "live"]),
      fetched: z.number(),
      inserted: z.number(),
      duplicates: z.number(),
      jobId: z.string().nullable(),
    }),
  }),
  async (c) => {
    const { id, provider } = c.req.valid("param");
    const { since, until } = c.req.valid("json");
    if (since > until) throw badRequest("since must be on or before until");
    const pdb = practiceDb(c);
    await accessibleClient(pdb, c.get("practice").role, id);
    const adapter = B.ledgerAdapterFor(provider);
    const txns = await adapter.transactions(since, until);
    const tdb = new TenantDb(c.env.DB, id);
    let r = { inserted: 0, duplicates: 0, jobId: null as string | null, documentId: null as string | null };
    if (txns.length) {
      const res = await ingestBankCsv(
        c.env,
        tdb,
        pdb.email,
        new TextEncoder().encode(toBankCsv(txns)).buffer as ArrayBuffer,
        `${provider}-${adapter.mode}-sync-${since}-${until}.csv`,
      );
      r = { inserted: res.inserted, duplicates: res.duplicates, jobId: res.jobId ?? null, documentId: res.documentId ?? null };
    }
    const outbox = new Outbox(tdb);
    outbox.add("integration.synced", { provider, mode: adapter.mode, jobId: r.jobId, inserted: r.inserted, duplicates: r.duplicates }, pdb.email);
    await pdb.batch([
      await new PracticeAudit(pdb).stmt("integration.synced", provider, id, { mode: adapter.mode, fetched: txns.length, inserted: r.inserted }),
      ...outbox.stmts,
    ]);
    await outbox.publish(c.env);
    return c.json({ provider, mode: adapter.mode, fetched: txns.length, inserted: r.inserted, duplicates: r.duplicates, jobId: r.jobId }, 200);
  },
);
