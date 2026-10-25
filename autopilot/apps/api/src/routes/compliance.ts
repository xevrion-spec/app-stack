/**
 * Document extraction and MTD ITSA (MOCK gateway only; ADR 0017/0018). Nothing here contacts HMRC: submissions go to
 * `MockMtdGateway`, are stored with sandbox=1 and are labelled as mock in every response.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as B from "@xevrion/books";
import type { AppEnv } from "../env.js";
import { requireRole } from "../lib/auth.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { badRequest, conflict, tooLarge } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import { chart, ledger } from "./books.js";

type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const actor = (c: C) => c.get("principal").email;
let extractor: B.DocumentExtractor = new B.TextReceiptExtractor();
let gatewayFactory: () => B.MtdGateway = () => new B.MockMtdGateway();
export const __setComplianceProviders = (p: { extractor?: B.DocumentExtractor; gateway?: () => B.MtdGateway }) => {
  if (p.extractor) extractor = p.extractor;
  if (p.gateway) gatewayFactory = p.gateway;
};

export const compliance = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
compliance.use("/extract/*", requireRole("owner", "reviewer"));
compliance.use("/mtd/*", requireRole("owner"));

const ExtractionOut = z
  .object({
    extractor: z.string(),
    vendor: z.string().nullable(),
    date: z.string().nullable(),
    totalPence: z.number().nullable(),
    vatPence: z.number().nullable(),
    currency: z.string(),
    invoiceNumber: z.string().nullable(),
    confidence: z.number(),
    fields: z.record(z.string(), z.number()),
    needsReview: z.boolean(),
  })
  .openapi("Extraction");
compliance.openapi(
  def({
    method: "post",
    path: "/extract/text",
    tag: "Extraction",
    summary: "Extract receipt/invoice fields from text (OCR/PDF text). Low confidence → needsReview",
    response: ExtractionOut,
  }),
  async (c) => {
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > 512 * 1024) throw tooLarge("Text larger than 512 KB");
    if (!bytes.byteLength) throw badRequest("Empty body");
    const r = await extractor.extract({ text: new TextDecoder().decode(bytes) });
    return c.json({ extractor: extractor.name, ...r }, 200);
  },
);

const Ob = z
  .object({ periodKey: z.string(), start: z.string(), end: z.string(), due: z.string(), status: z.string(), submissionId: z.string().nullable() })
  .openapi("MtdObligation");
async function obligations(db: TenantDb, taxYear: string) {
  let ob: B.MtdObligation[];
  try {
    ob = await gatewayFactory().obligations(taxYear);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const subs = new Map(
    (await db.all<{ period_key: string; id: string }>("select period_key, id from mtd_submissions where tenant_id = ?1")).map((s) => [s.period_key, s.id]),
  );
  return ob.map((o) => ({ ...o, status: subs.has(o.periodKey) ? "fulfilled" : "open", submissionId: subs.get(o.periodKey) ?? null }));
}
compliance.openapi(
  def({
    method: "get",
    path: "/mtd/obligations",
    tag: "MTD (mock)",
    summary: "Quarterly obligations for a tax year (MOCK gateway)",
    query: z.object({ taxYear: z.string() }),
    response: z.object({ gateway: z.string(), sandbox: z.literal(true), obligations: z.array(Ob) }),
  }),
  async (c) => c.json({ gateway: gatewayFactory().name, sandbox: true as const, obligations: await obligations(scope(c), c.req.valid("query").taxYear) }, 200),
);
compliance.openapi(
  def({
    method: "post",
    path: "/mtd/quarterly-updates/preview",
    tag: "MTD (mock)",
    summary: "Build the quarterly update from the ledger without submitting",
    body: z.object({ periodKey: z.string().regex(/^\d{4}-\d{2}-Q[1-4]$/) }),
    response: z.record(z.string(), z.unknown()),
  }),
  async (c) => c.json((await build(c, c.req.valid("json").periodKey)) as unknown as Record<string, unknown>, 200),
);
async function build(c: C, periodKey: string) {
  const db = scope(c);
  const ob = (await obligations(db, periodKey.slice(0, 7))).find((o) => o.periodKey === periodKey);
  if (!ob) throw badRequest("Unknown period");
  const accounts = await chart(db);
  const s = B.taxSummary(B.profitAndLoss(await ledger(db, ob.end), accounts, ob.start, ob.end), accounts);
  return {
    obligation: ob,
    update: B.buildQuarterlyUpdate(periodKey, s.turnoverPence, s.boxes),
    unmappedAccounts: s.unmapped,
    verified: false as const,
    notice: B.UNVERIFIED_NOTICE,
  };
}
compliance.openapi(
  def({
    method: "post",
    path: "/mtd/quarterly-updates",
    tag: "MTD (mock)",
    summary: "Submit a quarterly update to the MOCK gateway (owner; confirm required). Never reaches HMRC",
    body: z.object({ periodKey: z.string().regex(/^\d{4}-\d{2}-Q[1-4]$/), confirm: z.literal(true) }),
    response: z.record(z.string(), z.unknown()),
    status: 201,
  }),
  async (c) => {
    const db = scope(c);
    const b = await build(c, c.req.valid("json").periodKey);
    if (b.obligation.status === "fulfilled") throw conflict("Period already submitted");
    const gw = gatewayFactory();
    let receipt: B.MtdReceipt;
    try {
      receipt = await gw.submitQuarterlyUpdate(b.update);
    } catch (e) {
      if (e instanceof B.MtdValidationError) throw badRequest(e.message);
      throw e;
    }
    const id = newId();
    try {
      await db.batch([
        db.stmt(
          "insert into mtd_submissions (tenant_id, id, period_key, payload_json, receipt_json, gateway, sandbox, created_by) values (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
          id,
          b.update.periodKey,
          JSON.stringify(b.update),
          JSON.stringify(receipt),
          gw.name,
          actor(c),
        ),
        auditStmt(db, actor(c), "mtd.quarterly_update.mock", id, { periodKey: b.update.periodKey, gateway: gw.name }),
      ]);
    } catch {
      throw conflict("Period already submitted");
    }
    return c.json(
      { id, gateway: gw.name, sandbox: true, receipt, update: b.update, verified: false, notice: "MOCK submission: nothing was sent to HMRC." },
      201,
    );
  },
);
compliance.openapi(
  def({
    method: "get",
    path: "/mtd/submissions",
    tag: "MTD (mock)",
    summary: "Mock submissions history",
    response: z.array(z.record(z.string(), z.unknown())),
  }),
  async (c) => {
    const rows = await scope(c).all<{ id: string; period_key: string; receipt_json: string; gateway: string; created_at: string }>(
      "select id, period_key, receipt_json, gateway, created_at from mtd_submissions where tenant_id = ?1 order by created_at desc",
    );
    return c.json(
      rows.map((r) => ({ id: r.id, periodKey: r.period_key, gateway: r.gateway, sandbox: true, receipt: JSON.parse(r.receipt_json), createdAt: r.created_at })),
      200,
    );
  },
);
