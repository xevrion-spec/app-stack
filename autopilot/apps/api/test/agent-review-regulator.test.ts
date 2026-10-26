import { describe, it, expect, beforeAll } from "vitest";
import * as R from "@xevrion/agent-review";
import { makeEnv, client } from "./harness.js";

const A = "owner-reg@example.test",
  R1 = "rev-reg@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
let JWK = "";
beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  JWK = JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", kp.privateKey)), kid: "rk-test" });
});
async function setup(over: Record<string, string> = {}) {
  const h = makeEnv({ RECEIPT_SIGNING_JWK: JWK, ...over });
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Regulator Co (synthetic)" } });
  h.raw.prepare("update tenants set plan = 'pro'").run();
  await call("POST", "/v1/users", { user: A, body: { email: R1, role: "reviewer" } });
  const p = (await call("POST", "/v1/review-projects", { user: A, body: { name: "reg" } })).json;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["reviews:write"], projectId: p.id } })).json.key as string;
  const create = async (body: Record<string, unknown> = {}) =>
    (await call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action: "email.send", payload: { n: 1 }, risk: "low", ...body } })).json
      .id as string;
  return { ...h, call, create, projectId: p.id as string };
}
const period = () =>
  `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`;

describe("D7 regulator-style evidence pack", () => {
  it("builds a signed, offline-verifiable pack with controls, pseudonymised reviewers, holds and redactions; audited", async () => {
    const s = await setup();
    const doc = { rules: [{ id: "auto", when: { action: "noop.*", risk: ["low"], minConfidence: 0.9 }, then: { outcome: "auto_approve" } }] };
    const pol = await s.call("POST", `/v1/review-projects/${s.projectId}/policies`, { user: A, body: { document: doc } });
    await s.call("POST", `/v1/review-projects/${s.projectId}/policies/${pol.json.version}/activate`, { user: A, body: { force: true } });
    await s.call("PUT", `/v1/review-projects/${s.projectId}/retention`, { user: A, body: { retentionDays: 400 } });
    await s.create({ action: "noop.x", confidence: 0.95 });
    const a = await s.create();
    await s.call("POST", `/v1/agent-reviews/${a}/decisions`, { user: R1, body: { decision: "approve" } });
    const b = await s.create();
    await s.call("POST", `/v1/agent-reviews/${b}/legal-hold`, { user: A, body: { reason: "synthetic" } });
    const c = await s.create();
    await s.call("POST", `/v1/agent-reviews/${c}/decisions`, { user: R1, body: { decision: "reject" } });
    await s.call("POST", `/v1/agent-reviews/${c}/redact`, { user: A });
    const r = await s.call("GET", `/v1/review-projects/${s.projectId}/regulator-pack?${period()}`, { user: A });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("regulator-pack-");
    const { pack } = r.json;
    expect(pack.facts).toMatchObject({
      requests: 4,
      autoDecided: 1,
      humanRouted: 3,
      humanDecisions: 2,
      integrityChecked: 4,
      integrityFailed: 0,
      retentionDays: 400,
      policyVersions: 1,
      legalHolds: 1,
      redactions: 1,
    });
    expect(pack.controls.map((x: { status: string }) => x.status)).toEqual(["evidenced", "evidenced", "evidenced", "evidenced"]);
    expect(pack.reviewers[0].reviewer).toMatch(/^reviewer-[0-9a-f]{16}$/);
    expect(JSON.stringify(pack)).not.toContain(R1);
    expect(pack.requests.find((x: { id: string }) => x.id === b).legalHold).toBe(true);
    expect(pack.outcomes.requests).toBe(4);
    expect(await R.verifyPack(r.json, r.json.publicKeys)).toEqual({ ok: true });
    expect(await R.verifyPack({ ...r.json, pack: { ...pack, facts: { ...pack.facts, integrityFailed: 0, requests: 3 } } }, r.json.publicKeys)).toEqual({
      ok: false,
      reason: "manifest_mismatch",
    });
    const audit = s.raw.prepare("select action, subject from audit_log where action = 'agent_review.regulator_pack'").all();
    expect(audit).toEqual([{ action: "agent_review.regulator_pack", subject: s.projectId }]);
    const named = await s.call("GET", `/v1/review-projects/${s.projectId}/regulator-pack?${period()}&pseudonymise=false`, { user: A });
    expect(named.json.pack.reviewers[0].reviewer).toBe(R1);
  });
  it("flags gaps: broken trail, short retention; unsigned when no key; validation, 404, owner-only", async () => {
    const s = await setup({ RECEIPT_SIGNING_JWK: "" });
    await s.call("PUT", `/v1/review-projects/${s.projectId}/retention`, { user: A, body: { retentionDays: 30 } });
    const id = await s.create();
    s.raw.prepare("update review_ledger set actor = 'tampered' where request_id = ?").run(id);
    const r = await s.call("GET", `/v1/review-projects/${s.projectId}/regulator-pack?${period()}`, { user: A });
    expect(r.status).toBe(200);
    expect(r.json.signature).toBeNull();
    const ctl = Object.fromEntries(r.json.pack.controls.map((x: { id: string; status: string }) => [x.id, x.status]));
    expect(ctl).toMatchObject({ "record-keeping": "gap", "log-retention": "gap" });
    expect(r.json.pack.integrity.failedRequestIds).toEqual([id]);
    const base = `/v1/review-projects/${s.projectId}/regulator-pack`;
    expect((await s.call("GET", `${base}?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z`, { user: A })).status).toBe(400);
    expect((await s.call("GET", `${base}?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`, { user: A })).status).toBe(400);
    expect((await s.call("GET", `${base}?from=yesterday&to=2026-01-01T00:00:00Z`, { user: A })).status).toBe(400);
    expect((await s.call("GET", `/v1/review-projects/nope/regulator-pack?${period()}`, { user: A })).status).toBe(404);
    expect((await s.call("GET", `${base}?${period()}`, { user: R1 })).status).toBe(403);
  });
});
