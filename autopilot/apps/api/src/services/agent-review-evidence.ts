import * as R from "@xevrion/agent-review";
import type { Env } from "../env.js";
import type { TenantDb } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { checkIntegrity, loadChain, payloadSha, type Integrity } from "./agent-review-ledger.js";
import { CALLBACK_COLS, type CallbackRow } from "./agent-review-delivery.js";
import { reviewOut, type DecisionRow, type RequestRow } from "./agent-review.js";

type Key = Awaited<ReturnType<typeof R.loadSigningKey>>;
let cached: { src: string; key: Promise<Key> } | null = null;
async function signingKey(env: Env): Promise<Key> {
  const src = env.RECEIPT_SIGNING_JWK;
  if (!src) throw new AppError(503, "receipts_unconfigured", "Decision receipts are not configured (RECEIPT_SIGNING_JWK)");
  if (cached?.src !== src) cached = { src, key: R.loadSigningKey(src) };
  return cached.key;
}

/** Current key first, then retired keys, so receipts signed before a rotation still verify. */
export async function publicKeys(env: Env): Promise<(JsonWebKey & { kid: string })[]> {
  const retired = env.RECEIPT_RETIRED_PUBLIC_JWKS ? (JSON.parse(env.RECEIPT_RETIRED_PUBLIC_JWKS) as (JsonWebKey & { kid: string })[]) : [];
  const current = env.RECEIPT_SIGNING_JWK ? [(await signingKey(env)).publicJwk] : [];
  return [...current, ...retired.map((k) => ({ kty: k.kty, crv: k.crv, x: k.x, kid: k.kid }))];
}

const decisionsOf = (db: TenantDb, id: string) =>
  db.all<DecisionRow>(
    "select id, reviewer, decision, reason, payload_version, created_at from review_decisions where tenant_id = ?1 and request_id = ?2 order by created_at, id",
    id,
  );

export async function integrityOf(db: TenantDb, r: RequestRow): Promise<{ chain: R.LedgerEntry[]; decisions: DecisionRow[]; integrity: Integrity }> {
  const [chain, decisions] = await Promise.all([loadChain(db, r.id), decisionsOf(db, r.id)]);
  return { chain, decisions, integrity: await checkIntegrity(r, chain, decisions) };
}

/** A receipt is only issued for a final request whose trail verifies: we never sign over a broken chain. */
export async function issueReceipt(env: Env, db: TenantDb, r: RequestRow): Promise<R.SignedReceipt> {
  if (!R.FINAL.has(r.status)) throw new AppError(409, "not_final", `Request is ${r.status}; receipts are issued once it is final`);
  const key = await signingKey(env);
  const { decisions, integrity } = await integrityOf(db, r);
  if (!integrity.ok) throw new AppError(409, "version_conflict", `Audit trail failed verification (${integrity.reason}); no receipt issued`);
  const snap = JSON.parse(r.snapshot_json) as R.Snapshot;
  const body: R.ReceiptBody = {
    v: 1,
    requestId: r.id,
    tenantId: db.tenantId,
    projectId: r.project_id,
    action: r.action,
    status: r.status as R.ReceiptBody["status"],
    payloadSha256: await payloadSha(r.current_payload_json),
    payloadVersion: snap.payloadVersion,
    decisions: decisions.map((d) => ({ reviewer: d.reviewer, decision: d.decision, payloadVersion: d.payload_version, at: d.created_at })),
    policy: { version: r.policy_version, ruleId: r.policy_rule_id },
    chain: { length: integrity.length, head: integrity.head },
    decidedAt: r.decided_at,
    issuedAt: new Date().toISOString(),
  };
  return R.signReceipt(body, key.key, key.kid);
}

/** Everything an auditor needs for one decision, self-contained and offline-verifiable. */
export async function evidencePack(env: Env, db: TenantDb, r: RequestRow) {
  const { chain, decisions, integrity } = await integrityOf(db, r);
  const policy = r.policy_version
    ? await db.first<{ version: number; sha256: string; document_json: string; status: string }>(
        "select version, sha256, document_json, status from review_policies where tenant_id = ?1 and project_id = ?2 and version = ?3",
        r.project_id,
        r.policy_version,
      )
    : null;
  const callbacks = await db.all<CallbackRow>(
    `select ${CALLBACK_COLS} from review_callbacks where tenant_id = ?1 and request_id = ?2 order by created_at`,
    r.id,
  );
  let receipt: R.SignedReceipt | null = null;
  if (R.FINAL.has(r.status) && integrity.ok && env.RECEIPT_SIGNING_JWK) receipt = await issueReceipt(env, db, r);
  return {
    format: "xevrion.review-evidence/1",
    generatedAt: new Date().toISOString(),
    request: reviewOut(r, decisions),
    ledger: chain,
    integrity,
    policy: policy ? { version: policy.version, sha256: policy.sha256, status: policy.status, document: JSON.parse(policy.document_json) as unknown } : null,
    callbacks: callbacks.map((cb) => ({ id: cb.id, eventType: cb.event_type, status: cb.status, attempt: cb.attempt, responseStatus: cb.response_status })),
    receipt,
    publicKeys: await publicKeys(env),
    verification:
      "Recompute each ledger hash as sha256(prevHash + '\\n' + canonicalJson({requestId, seq, kind, actor, at, data})) from 64 zeros; the last hash must equal receipt.receipt.chain.head; verify receipt.signature (Ed25519) over canonicalJson(receipt.receipt) with the key whose kid matches.",
  };
}
