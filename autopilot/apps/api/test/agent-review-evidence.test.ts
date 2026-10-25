import { describe, it, expect, beforeAll } from "vitest";
import { makeEnv, client } from "./harness.js";
import * as R from "@xevrion/agent-review";
import { TenantDb } from "../src/lib/db.js";
import { loadReview, transition } from "../src/services/agent-review.js";

const A = "owner-a@example.test",
  R1 = "reviewer-1@example.test",
  R2 = "reviewer-2@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
let JWK = "";
let OLD_PUBLIC: JsonWebKey & { kid: string };
beforeAll(async () => {
  const mk = async (kid: string) => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return { ...((await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey), kid };
  };
  JWK = JSON.stringify(await mk("rk-2026-10"));
  const old = await mk("rk-2026-01");
  OLD_PUBLIC = { kty: old.kty!, crv: old.crv!, x: old.x!, kid: old.kid };
});

async function setup(over: Record<string, string> = {}) {
  const h = makeEnv({ RECEIPT_SIGNING_JWK: JWK, RECEIPT_RETIRED_PUBLIC_JWKS: JSON.stringify([OLD_PUBLIC]), ...over });
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Evidence Co (synthetic)" } });
  for (const u of [R1, R2]) await call("POST", "/v1/users", { user: A, body: { email: u, role: "reviewer" } });
  const project = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Payments agent" } })).json as { id: string };
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes: ["reviews:write"], projectId: project.id } })).json.key as string;
  const create = (body: Record<string, unknown> = {}) =>
    call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action: "payment.send", payload: { amount: 120, to: "acct-1" }, ...body } });
  const tenantId = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  return { ...h, call, key, project, create, tenantId };
}
const audit = (s: Awaited<ReturnType<typeof setup>>, id: string) => s.call("GET", `/v1/agent-reviews/${id}/audit`, { user: A });

describe("agent review audit trail, receipts and evidence (A4)", () => {
  it("every transition appends a sealed entry; the trail verifies end to end and stays content-free", async () => {
    const s = await setup();
    const r = (await s.create({ risk: "critical", context: { note: "contains PII: Jane" } })).json;
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, {
      user: R1,
      body: { decision: "edit", payload: { amount: 100, to: "acct-1" }, reason: "cap" },
    });
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R2, body: { decision: "approve" } });
    const a = (await audit(s, r.id)).json;
    expect(a.entries.map((e: R.LedgerEntry) => [e.seq, e.kind, e.actor, e.data.decision ?? null])).toEqual([
      [1, "requested", "apikey:agent", null].map((v, i) => (i === 2 ? expect.any(String) : v)),
      [2, "decided", R1, "edit"],
      [3, "decided", R2, "approve"],
    ]);
    expect(a.integrity).toMatchObject({ ok: true, length: 3 });
    const text = JSON.stringify(a.entries);
    expect(text).not.toContain("acct-1");
    expect(text).not.toContain("Jane");
    expect(text).not.toContain("cap");
    expect(await R.verifyChain(r.id, a.entries)).toMatchObject({ ok: true, head: a.integrity.head });
  });

  it.each([
    ["ledger entry edited", "update review_ledger set actor = 'mallory@example.test' where seq = 2", "hash_mismatch"],
    ["ledger tail deleted", "delete from review_ledger where seq = 2", "head_mismatch"],
    ["decision row forged", "update review_decisions set reviewer = 'mallory@example.test'", "decisions_mismatch"],
    ["payload swapped after approval", `update review_requests set current_payload_json = '{"amount":9999,"to":"attacker"}'`, "payload_mismatch"],
    ["head pin rewritten", "update review_requests set chain_head = 'ff'", "head_mismatch"],
  ])("detects tampering: %s, and refuses to sign a receipt", async (_n, sql, reason) => {
    const s = await setup();
    const r = (await s.create()).json;
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve" } });
    expect((await audit(s, r.id)).json.integrity.ok).toBe(true);
    s.raw.exec(sql);
    expect((await audit(s, r.id)).json.integrity).toMatchObject({ ok: false, reason });
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}/receipt`, { user: A })).status).toBe(409);
    const pack = (await s.call("GET", `/v1/agent-reviews/${r.id}/evidence`, { user: A })).json;
    expect([pack.integrity.ok, pack.receipt]).toEqual([false, null]);
  });

  it("receipts: final only, offline-verifiable with published keys, bound to the chain head and approved payload", async () => {
    const s = await setup();
    const r = (await s.create()).json;
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}/receipt`, { headers: bearer(s.key) })).json.error.code).toBe("not_final");
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve" } });
    const rec = (await s.call("GET", `/v1/agent-reviews/${r.id}/receipt`, { headers: bearer(s.key) })).json as R.SignedReceipt;
    const keys = (await s.call("GET", "/v1/agent-review/receipt-keys", { headers: bearer(s.key) })).json.keys;
    expect(keys.map((k: { kid: string }) => k.kid)).toEqual(["rk-2026-10", "rk-2026-01"]);
    expect(JSON.stringify(keys)).not.toContain('"d"');
    expect(await R.verifyReceipt(rec, keys)).toEqual({ ok: true });
    expect(rec.receipt).toMatchObject({
      requestId: r.id,
      tenantId: s.tenantId,
      status: "approved",
      payloadSha256: await R.sha256Hex(R.canonicalJson({ amount: 120, to: "acct-1" })),
      decisions: [{ reviewer: R1, decision: "approve", payloadVersion: 1 }],
    });
    expect(rec.receipt.chain).toEqual({ length: 2, head: (await audit(s, r.id)).json.integrity.head });
    expect(await R.verifyReceipt({ ...rec, receipt: { ...rec.receipt, status: "rejected" } }, keys)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("auto-decided requests are chained too, attributed to the policy", async () => {
    const s = await setup();
    await s.call("POST", `/v1/review-projects/${s.project.id}/policies`, {
      user: A,
      body: { document: { rules: [{ id: "small", when: { risk: ["low"], minConfidence: 0.9 }, then: { outcome: "auto_approve" } }] } },
    });
    await s.call("POST", `/v1/review-projects/${s.project.id}/policies/1/activate`, { user: A, body: {} });
    const r = (await s.create({ risk: "low", confidence: 0.95 })).json;
    const a = (await audit(s, r.id)).json;
    expect(a.entries.map((e: R.LedgerEntry) => [e.kind, e.actor])).toEqual([
      ["requested", expect.any(String)],
      ["decided", "policy:v1:small"],
    ]);
    expect(a.integrity.ok).toBe(true);
    const pack = (await s.call("GET", `/v1/agent-reviews/${r.id}/evidence`, { user: A })).json;
    expect(pack).toMatchObject({ format: "xevrion.review-evidence/1", integrity: { ok: true }, policy: { version: 1, status: "active" } });
    expect(await R.verifyReceipt(pack.receipt, pack.publicKeys)).toEqual({ ok: true });
  });

  it("a stale concurrent writer rolls back completely: no orphan decision, event or audit rows", async () => {
    const s = await setup();
    const r = (await s.create({ minApprovals: 2 })).json;
    const db = new TenantDb(s.env.DB, s.tenantId);
    const stale = await loadReview(db, r.id, null);
    await transition(s.env, db, stale, { type: "decide", decision: "approve", reviewer: R1 }, { actor: R1 });
    const count = (t: string) => (s.raw.prepare(`select count(*) n from ${t}`).get() as { n: number }).n;
    const before = ["review_decisions", "events", "audit_log", "review_ledger"].map(count);
    await expect(transition(s.env, db, stale, { type: "decide", decision: "approve", reviewer: R2 }, { actor: R2 })).rejects.toMatchObject({ status: 409 });
    expect(["review_decisions", "events", "audit_log", "review_ledger"].map(count)).toEqual(before);
    expect((await audit(s, r.id)).json.integrity.ok).toBe(true);
  });

  it("NDJSON export pages by time, needs reviews:audit, and is tenant-isolated", async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) await s.create({ externalId: `x${i}` });
    const res = await s.call("GET", "/v1/agent-review/audit/export?limit=2", { user: A });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = res.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as R.LedgerEntry);
    expect(lines).toHaveLength(2);
    const next = (await s.call("GET", `/v1/agent-review/audit/export?since=${encodeURIComponent(lines[1]!.at)}`, { user: A })).text.trim().split("\n");
    expect(next.length).toBeGreaterThanOrEqual(1);
    expect((await s.call("GET", "/v1/agent-review/audit/export", { headers: bearer(s.key) })).status).toBe(403);
    const siem = (await s.call("POST", "/v1/api-keys", { user: A, body: { name: "siem", scopes: ["reviews:audit"] } })).json.key;
    expect((await s.call("GET", "/v1/agent-review/audit/export", { headers: bearer(siem) })).status).toBe(200);
    expect((await s.call("GET", "/v1/agent-review/audit/export", { user: R1 })).status).toBe(403);
    await s.call("POST", "/v1/tenants", { user: "other@example.test", body: { name: "Other (synthetic)" } });
    expect((await s.call("GET", "/v1/agent-review/audit/export", { user: "other@example.test" })).text).toBe("");
  });

  it("receipts return 503 when no signing key is configured; evidence still works without one", async () => {
    const s = await setup({ RECEIPT_SIGNING_JWK: "", RECEIPT_RETIRED_PUBLIC_JWKS: "" });
    const r = (await s.create()).json;
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "reject" } });
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}/receipt`, { user: A })).json.error.code).toBe("receipts_unconfigured");
    const pack = (await s.call("GET", `/v1/agent-reviews/${r.id}/evidence`, { user: A })).json;
    expect([pack.integrity.ok, pack.receipt, pack.publicKeys]).toEqual([true, null, []]);
  });
});
