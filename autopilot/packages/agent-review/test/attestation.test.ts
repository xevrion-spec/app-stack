import { describe, expect, it } from "vitest";
import { evaluateControls, loadSigningKey, MIN_LOG_RETENTION_DAYS, sealPack, verifyPack, type PackFacts } from "../src/index.js";

const facts = (o: Partial<PackFacts> = {}): PackFacts => ({
  requests: 10,
  humanRouted: 7,
  humanDecisions: 8,
  autoDecided: 3,
  integrityChecked: 10,
  integrityFailed: 0,
  integrityTruncated: false,
  retentionDays: 365,
  policyVersions: 2,
  criticalAutoApproved: 0,
  legalHolds: 1,
  redactions: 2,
  ...o,
});
const byId = (f: PackFacts) => Object.fromEntries(evaluateControls(f).map((c) => [c.id, c]));
async function newKey(kid: string) {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return loadSigningKey(JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", kp.privateKey)), kid }));
}

describe("evaluateControls (D7)", () => {
  it("all evidenced on healthy facts, with details and framework refs", () => {
    const c = byId(facts());
    expect(Object.values(c).map((x) => x.status)).toEqual(["evidenced", "evidenced", "evidenced", "evidenced"]);
    expect(c["record-keeping"]!.detail).toBe("10 trails verified");
    expect(c["record-keeping"]!.refs).toContain("EU AI Act Art. 12");
    expect(c["human-oversight"]!.detail).toBe("7 of 10 routed to people (8 decisions); 3 decided by policy");
    expect(c["log-retention"]!.detail).toBe("retention 365 days; 1 on legal hold; 2 redacted");
    expect(c["policy-governance"]!.detail).toBe("2 policy versions in force during the period");
  });
  it("reports gaps honestly", () => {
    expect(byId(facts({ integrityFailed: 2 }))["record-keeping"]).toMatchObject({ status: "gap", detail: "2 of 10 trails failed verification" });
    expect(byId(facts({ integrityTruncated: true }))["record-keeping"]!.status).toBe("gap");
    expect(byId(facts({ criticalAutoApproved: 1 }))["human-oversight"]).toMatchObject({ status: "gap", detail: "1 critical requests were auto-approved" });
    expect(byId(facts({ retentionDays: null }))["log-retention"]!.status).toBe("gap");
    expect(byId(facts({ retentionDays: MIN_LOG_RETENTION_DAYS - 1 }))["log-retention"]).toMatchObject({
      status: "gap",
      detail: "retention 182 days is below 183",
    });
    expect(byId(facts({ retentionDays: MIN_LOG_RETENTION_DAYS }))["log-retention"]!.status).toBe("evidenced");
  });
  it("empty periods are not applicable, not evidenced", () => {
    const c = byId(facts({ requests: 0, integrityChecked: 0, humanRouted: 0, humanDecisions: 0, autoDecided: 0, policyVersions: 0 }));
    expect(c["record-keeping"]!.status).toBe("not_applicable");
    expect(c["human-oversight"]!.status).toBe("not_applicable");
    expect(c["policy-governance"]!.detail).toMatch(/default policy/);
  });
});

describe("sealPack / verifyPack", () => {
  it("signs and verifies offline; tampering, wrong key, unknown kid, unsigned and malformed all fail", async () => {
    const k = await newKey("k1");
    const s = await sealPack({ b: 2, a: [1, "x"] }, k);
    expect(s.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyPack(s, [k.publicJwk])).toEqual({ ok: true });
    expect(await verifyPack({ ...s, pack: { b: 3, a: [1, "x"] } }, [k.publicJwk])).toEqual({ ok: false, reason: "manifest_mismatch" });
    const other = await newKey("k1");
    expect(await verifyPack(s, [other.publicJwk])).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyPack(s, [{ ...k.publicJwk, kid: "nope" }])).toEqual({ ok: false, reason: "unknown_kid" });
    expect(await verifyPack({ ...s, signature: { ...s.signature!, value: "!!" } }, [k.publicJwk])).toEqual({ ok: false, reason: "malformed" });
    const unsigned = await sealPack({ a: 1 }, null);
    expect(unsigned.signature).toBeNull();
    expect(await verifyPack(unsigned, [k.publicJwk])).toEqual({ ok: false, reason: "unsigned" });
    // canonical: key order does not change the manifest
    expect((await sealPack({ a: [1, "x"], b: 2 }, null)).manifestSha256).toBe(s.manifestSha256);
  });
});

describe("control wording is stable (auditors diff packs)", () => {
  it("snapshots every control in healthy, gap and empty states", () => {
    expect(evaluateControls(facts())).toMatchSnapshot();
    expect(evaluateControls(facts({ integrityTruncated: true, criticalAutoApproved: 2, retentionDays: null }))).toMatchSnapshot();
    expect(evaluateControls(facts({ requests: 0, integrityChecked: 0, policyVersions: 0 }))).toMatchSnapshot();
  });
});
