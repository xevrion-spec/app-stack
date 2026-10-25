import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { GENESIS, sealAll, verifyChain, LEDGER_KINDS, type UnsignedEntry, type LedgerEntry } from "../src/ledger.js";
import { signReceipt, verifyReceipt, loadSigningKey, type ReceiptBody } from "../src/receipt.js";

const entryArb = (id: string) =>
  fc
    .array(
      fc.record({
        kind: fc.constantFrom(...LEDGER_KINDS),
        actor: fc.string({ minLength: 1, maxLength: 12 }),
        at: fc.date({ min: new Date("2026-01-01"), max: new Date("2027-01-01"), noInvalidDate: true }).map((d) => d.toISOString()),
        data: fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.oneof(fc.integer(), fc.string(), fc.boolean())),
      }),
      { minLength: 1, maxLength: 8 },
    )
    .map((xs) => xs.map((x, i): UnsignedEntry => ({ ...x, requestId: id, seq: i + 1 })));

const mutations: ((e: LedgerEntry) => LedgerEntry)[] = [
  (e) => ({ ...e, actor: e.actor + "x" }),
  (e) => ({ ...e, at: "2030-01-01T00:00:00.000Z" }),
  (e) => ({ ...e, data: { ...e.data, injected: 1 } }),
  (e) => ({ ...e, kind: e.kind === "decided" ? "cancelled" : "decided" }),
  (e) => ({ ...e, hash: e.hash.replace(/^./, (c) => (c === "a" ? "b" : "a")) }),
  (e) => ({ ...e, prevHash: GENESIS.replace(/^0/, "1") }),
];

describe("ledger", () => {
  it("a sealed chain verifies and its head is the last hash", () =>
    fc.assert(
      fc.asyncProperty(entryArb("r1"), async (es) => {
        const chain = await sealAll(GENESIS, es);
        const v = await verifyChain("r1", chain);
        expect(v).toEqual({ ok: true, length: es.length, head: chain[chain.length - 1]!.hash });
      }),
      { numRuns: 60 },
    ));

  it("any single-field tamper is detected at that entry or earlier", () =>
    fc.assert(
      fc.asyncProperty(entryArb("r1"), fc.nat(), fc.nat({ max: mutations.length - 1 }), async (es, pick, m) => {
        const chain = await sealAll(GENESIS, es);
        const i = pick % chain.length;
        const bad = chain.map((e, j) => (j === i ? mutations[m]!(e) : e));
        const v = await verifyChain("r1", bad);
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.at).toBeLessThanOrEqual(i + 1);
      }),
      { numRuns: 120 },
    ));

  it("deletion, reordering, splicing and empty chains are detected", async () => {
    const chain = await sealAll(
      GENESIS,
      [1, 2, 3].map((n) => ({ requestId: "r", seq: n, kind: "decided" as const, actor: "a", at: "t", data: { n } })),
    );
    expect(await verifyChain("r", [chain[0]!, chain[2]!])).toEqual({ ok: false, at: 2, problem: "seq_gap" });
    expect(await verifyChain("r", [chain[1]!, chain[0]!, chain[2]!])).toMatchObject({ ok: false, at: 1 });
    expect(
      await verifyChain(
        "r",
        chain.slice(1).map((e, i) => ({ ...e, seq: i + 1 })),
      ),
    ).toMatchObject({ ok: false, at: 1, problem: "prev_mismatch" });
    expect(await verifyChain("other", chain)).toEqual({ ok: false, at: 1, problem: "wrong_request" });
    expect(await verifyChain("r", [])).toEqual({ ok: false, at: 0, problem: "empty" });
    const truncatedTail = await verifyChain("r", chain.slice(0, 2));
    expect(truncatedTail.ok && truncatedTail.head).toBe(chain[1]!.hash); // tail truncation is caught by pinning the head (receipts / row head)
  });
});

async function newJwk(kid: string) {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", kp.privateKey)), kid });
}
const body: ReceiptBody = {
  v: 1,
  requestId: "r",
  tenantId: "t",
  projectId: "p",
  action: "email.send",
  status: "approved",
  payloadSha256: "ab",
  payloadVersion: 1,
  decisions: [{ reviewer: "x", decision: "approve", payloadVersion: 1, at: "t" }],
  policy: { version: 1, ruleId: null },
  chain: { length: 2, head: "cd" },
  decidedAt: "t",
  issuedAt: "t",
};

describe("receipts", () => {
  it("sign → verify offline; any change to the body, signature or key fails", async () => {
    const k = await loadSigningKey(await newJwk("k1"));
    const other = await loadSigningKey(await newJwk("k2"));
    const r = await signReceipt(body, k.key, k.kid);
    expect(await verifyReceipt(r, [k.publicJwk])).toEqual({ ok: true });
    expect(await verifyReceipt({ ...r, receipt: { ...body, status: "rejected" } }, [k.publicJwk])).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyReceipt(r, [other.publicJwk])).toEqual({ ok: false, reason: "unknown_kid" });
    expect(await verifyReceipt(r, [{ ...other.publicJwk, kid: "k1" }])).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyReceipt({ ...r, alg: "HS256" as "Ed25519" }, [k.publicJwk])).toEqual({ ok: false, reason: "bad_alg" });
    expect(await verifyReceipt({ ...r, signature: "!!" }, [k.publicJwk])).toEqual({ ok: false, reason: "malformed" });
    expect(k.publicJwk).not.toHaveProperty("d");
  });
  it("rejects non-Ed25519 or kid-less signing keys", async () => {
    await expect(loadSigningKey(JSON.stringify({ kty: "RSA" }))).rejects.toThrow(/Ed25519/);
    const j = JSON.parse(await newJwk("k"));
    delete j.kid;
    await expect(loadSigningKey(JSON.stringify(j))).rejects.toThrow(/kid/);
  });
});
