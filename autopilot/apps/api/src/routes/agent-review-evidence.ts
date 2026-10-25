/**
 * Agent review A4: tamper-evident audit trail, integrity verification, signed decision receipts, evidence packs
 * and an NDJSON ledger export for SIEM ingestion. Read-only: nothing here changes a request.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import * as R from "@xevrion/agent-review";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import * as S from "../services/agent-review.js";
import * as E from "../services/agent-review-evidence.js";
import { ledgerSince } from "../services/agent-review-ledger.js";
import { scope, boundProject } from "./agent-reviews.js";

export const agentReviewEvidence = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

const Entry = z
  .object({
    requestId: z.string(),
    seq: z.number().int(),
    kind: z.enum(R.LEDGER_KINDS),
    actor: z.string(),
    at: z.string(),
    data: z.record(z.string(), z.unknown()),
    prevHash: z.string(),
    hash: z.string(),
  })
  .openapi("ReviewLedgerEntry");
const Integrity = z
  .object({ ok: z.boolean(), length: z.number().int().optional(), head: z.string().optional(), reason: z.string().optional(), at: z.number().int().optional() })
  .openapi("ReviewIntegrity");
const Jwk = z.object({ kty: z.string().optional(), crv: z.string().optional(), x: z.string().optional(), kid: z.string() }).openapi("ReceiptPublicKey");
const Receipt = z
  .object({ receipt: z.record(z.string(), z.unknown()), alg: z.literal("Ed25519"), kid: z.string(), signature: z.string() })
  .openapi("DecisionReceipt");

agentReviewEvidence.openapi(
  def({
    method: "get",
    path: "/agent-reviews/{id}/audit",
    tag: "Agent review",
    summary: "Hash-chained audit trail for a request, with a full integrity check",
    params: IdParam,
    response: z.object({ entries: z.array(Entry), integrity: Integrity }),
  }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, await boundProject(c));
    const { chain, integrity } = await E.integrityOf(db, r);
    return c.json({ entries: chain, integrity }, 200);
  },
);

agentReviewEvidence.openapi(
  def({
    method: "get",
    path: "/agent-reviews/{id}/receipt",
    tag: "Agent review",
    summary: "Ed25519-signed decision receipt (final requests with a verified trail only); verifiable offline",
    params: IdParam,
    response: Receipt,
  }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, await boundProject(c));
    return c.json(await E.issueReceipt(c.env, db, r), 200);
  },
);

agentReviewEvidence.openapi(
  def({
    method: "get",
    path: "/agent-reviews/{id}/evidence",
    tag: "Agent review",
    summary: "Self-contained evidence pack: request, decisions, ledger, integrity, policy document, callbacks, receipt, public keys",
    params: IdParam,
    response: z.object({ format: z.string() }).passthrough(),
  }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, await boundProject(c));
    c.header("content-disposition", `attachment; filename="review-evidence-${r.id}.json"`);
    return c.json(await E.evidencePack(c.env, db, r), 200);
  },
);

agentReviewEvidence.openapi(
  def({
    method: "get",
    path: "/agent-review/receipt-keys",
    tag: "Agent review",
    summary: "Public keys for verifying decision receipts (current first, then retired)",
    response: z.object({ keys: z.array(Jwk) }),
  }),
  async (c) => c.json({ keys: await E.publicKeys(c.env) }, 200),
);

agentReviewEvidence.get("/agent-review/audit/export", requireRole("owner"));
agentReviewEvidence.openapi(
  def({
    method: "get",
    path: "/agent-review/audit/export",
    tag: "Agent review",
    summary: "Ledger entries after `since` as NDJSON (SIEM ingestion). Content-free: payloads appear only as hashes. Page with the last line's `at`.",
    query: z.object({ since: z.string().max(40).default("1970-01-01T00:00:00.000Z"), limit: z.coerce.number().int().min(1).max(5000).default(1000) }),
    response: z.string(),
    raw: { contentType: "application/x-ndjson" },
  }),
  async (c) => {
    const q = c.req.valid("query");
    const rows = await ledgerSince(scope(c), q.since, q.limit);
    return c.body(rows.map((e) => JSON.stringify(e)).join("\n") + (rows.length ? "\n" : ""), 200, { "content-type": "application/x-ndjson" }) as never;
  },
);
