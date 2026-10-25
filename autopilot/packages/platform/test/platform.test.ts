import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  makeEvent,
  EVENT_TYPES,
  EventValidationError,
  matchesFilter,
  catalogDocument,
  isEventType,
  signPayload,
  verifySignature,
  backoffSeconds,
  isRetryable,
  shouldDisable,
  validateWebhookUrl,
  isPrivateAddress,
  parseIpv4,
  RETRY_POLICY,
  parseAutomation,
  planAutomation,
  evaluateCondition,
  getPath,
  TEMPLATES,
  LOOP_LIMIT,
  type AutomationDefinition,
  generateApiKey,
  parseApiKey,
  hashApiKey,
  hasScope,
  isKeyUsable,
  etagFor,
  ifNoneMatchHits,
  ifMatchFails,
  takeToken,
  selectFields,
  orderBy,
  ftsQuery,
  contentEtag,
  parseFlags,
  isEnabled,
  bucketOf,
  quotaCheck,
  timingSafeEqual,
  hmacSha256Hex,
  sha256,
  randomToken,
} from "../src/index.js";

const ctx = { id: "ev1", tenantId: "t1", occurredAt: "2026-07-01T00:00:00Z", actor: "pipeline" };
const txnCreated = (data: Partial<{ description: string; amountPence: number }> = {}, extra: Partial<typeof ctx & { causationChain: string[] }> = {}) =>
  makeEvent(
    "transaction.created",
    { transactionId: "tx1", jobId: null, date: "2026-07-01", description: "AMAZON MARKETPLACE", amountPence: -2500, currency: "GBP", ...data },
    { ...ctx, ...extra },
  );

describe("event catalog", () => {
  it("has the documented v1 events", () =>
    expect(EVENT_TYPES.sort()).toEqual([
      "checklist.completed",
      "document_request.fulfilled",
      "engagement.accepted",
      "exception.opened",
      "exception.resolved",
      "invoice.created",
      "invoice.credit_note_issued",
      "invoice.paid",
      "invoice.payment_recorded",
      "invoice.recurring_issued",
      "invoice.reminder_due",
      "job.completed",
      "portal.invited",
      "practice.client_added",
      "query.answered",
      "query.raised",
      "review.approved",
      "transaction.categorised",
      "transaction.created",
      "trigger.received",
      "vat_draft.ready",
      "working_paper.signed_off",
    ]));
  it.each(EVENT_TYPES)("%s is versioned and documented", (t) => {
    const d = catalogDocument().find((x) => x.type === t)!;
    expect(d.version).toBeGreaterThanOrEqual(1);
    expect(d.description.length).toBeGreaterThan(10);
    expect(d.fields.length).toBeGreaterThan(0);
  });
  it("builds a valid envelope", () => expect(txnCreated()).toMatchObject({ type: "transaction.created", version: 1, tenantId: "t1", causationChain: [] }));
  it.each([
    ["missing field", { transactionId: "tx1" }],
    ["float pence", { transactionId: "tx1", jobId: null, date: "d", description: "x", amountPence: 1.5, currency: "GBP" }],
    ["empty id", { transactionId: "", jobId: null, date: "d", description: "x", amountPence: 1, currency: "GBP" }],
  ])("rejects payload: %s", (_n, data) => expect(() => makeEvent("transaction.created", data as never, ctx)).toThrow(EventValidationError));
  it("rejects unknown event types", () => expect(() => makeEvent("user.deleted" as never, {} as never, ctx)).toThrow(EventValidationError));
  it.each([
    ["transaction.created", true],
    ["toString", false],
    ["__proto__", false],
    ["invoice.paid", true],
    ["", false],
  ])("isEventType(%j)=%s", (t, ok) => expect(isEventType(t)).toBe(ok));
  it("strips unknown payload keys (no accidental data leakage)", () => expect(Object.keys(txnCreated({ secret: "x" } as never).data)).not.toContain("secret"));
  it.each([
    ["transaction.created", ["*"], true],
    ["transaction.created", ["transaction.*"], true],
    ["transaction.created", ["invoice.*"], false],
    ["invoice.paid", ["invoice.paid"], true],
    ["invoice.paid", ["invoice.created"], false],
    ["invoice.paid", [], false],
    ["transactionx.created", ["transaction.*"], false],
  ] as [string, string[], boolean][])("matchesFilter(%s, %j)=%s", (t, f, ok) => expect(matchesFilter(t, f)).toBe(ok));
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ hello: "world" });
  it("verifies its own signature", async () => expect(await verifySignature(["s1"], await signPayload("s1", body, 1000), body, 1000)).toEqual({ ok: true }));
  it.each([
    ["tampered body", async () => verifySignature(["s1"], await signPayload("s1", body, 1000), body + " ", 1000), "mismatch"],
    ["wrong secret", async () => verifySignature(["s2"], await signPayload("s1", body, 1000), body, 1000), "mismatch"],
    ["stale (replay)", async () => verifySignature(["s1"], await signPayload("s1", body, 1000), body, 1301), "stale"],
    ["future", async () => verifySignature(["s1"], await signPayload("s1", body, 2000), body, 1000), "stale"],
    ["missing header", async () => verifySignature(["s1"], null, body, 1000), "malformed"],
    ["garbage header", async () => verifySignature(["s1"], "nonsense", body, 1000), "malformed"],
    ["no v1", async () => verifySignature(["s1"], "t=1000", body, 1000), "malformed"],
    ["tampered timestamp", async () => verifySignature(["s1"], (await signPayload("s1", body, 1000)).replace("t=1000", "t=1001"), body, 1000), "mismatch"],
  ] as [string, () => Promise<{ ok: boolean; reason?: string }>, string][])("rejects %s", async (_n, f, reason) =>
    expect(await f()).toEqual({ ok: false, reason }),
  );
  it("accepts old or new secret during rotation", async () => {
    expect((await verifySignature(["new", "old"], await signPayload("old", body, 5), body, 5)).ok).toBe(true);
    expect((await verifySignature(["new", "old"], await signPayload("new", body, 5), body, 5)).ok).toBe(true);
  });
  it("tolerance boundary is inclusive at 300s", async () => expect((await verifySignature(["s"], await signPayload("s", body, 0), body, 300)).ok).toBe(true));
  it("HMAC matches the RFC 4231 test vector 2", async () =>
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"));
  it("any body round-trips sign/verify", () =>
    fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string({ minLength: 1 }),
        fc.integer({ min: 0, max: 2e9 }),
        async (b, s, t) => (await verifySignature([s], await signPayload(s, b, t), b, t)).ok,
      ),
    ));
  it.each([
    ["abc", "abc", true],
    ["abc", "abd", false],
    ["abc", "ab", false],
    ["", "", true],
  ])("timingSafeEqual(%j,%j)=%s", (a, b, ok) => expect(timingSafeEqual(a, b)).toBe(ok));
});

describe("retry policy", () => {
  it.each([
    [1, 15, 30],
    [2, 30, 60],
    [3, 60, 120],
    [5, 240, 480],
    [10, 7680, 15360],
    [11, 10800, 21600],
    [30, 10800, 21600],
  ])("attempt %i within [%i, %i]s", (a, lo, hi) => {
    expect(backoffSeconds(a, () => 0)).toBe(lo);
    expect(backoffSeconds(a, () => 1)).toBe(hi);
  });
  it.each([0, -1, 1.5, NaN])("rejects attempt %d", (a) => expect(() => backoffSeconds(a)).toThrow(RangeError));
  it("never exceeds the cap and is non-decreasing in its ceiling", () =>
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.double({ min: 0, max: 1, noNaN: true }), (a, r) => {
        const s = backoffSeconds(a, () => r);
        return s >= 1 && s <= RETRY_POLICY.capSeconds && backoffSeconds(a, () => 1) <= backoffSeconds(a + 1, () => 1);
      }),
    ));
  it.each([
    [null, true],
    [500, true],
    [502, true],
    [503, true],
    [429, true],
    [408, true],
    [409, true],
    [425, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [410, false],
    [422, false],
    [200, false],
    [301, false],
  ] as [number | null, boolean][])("isRetryable(%s)=%s", (s, ok) => expect(isRetryable(s)).toBe(ok));
  it.each([
    [0, null, false],
    [19, "2026-07-01T00:00:00Z", false],
    [20, "2026-07-01T00:00:00Z", true],
    [3, "2026-06-28T00:00:00Z", true],
    [2, "2026-06-28T00:00:00Z", false],
    [5, "2026-06-29T00:00:01Z", false],
  ] as [number, string | null, boolean][])("shouldDisable(%i failures since %s)=%s", (n, since, ok) =>
    expect(shouldDisable(n, since, "2026-07-01T00:00:00Z")).toBe(ok),
  );
});

describe("SSRF-safe webhook URLs", () => {
  it.each([
    "https://hooks.example.com/x",
    "https://example.com:8443/hook",
    "https://a.b.example.co.uk/p?q=1",
    "https://93.184.216.34/hook",
    "https://[2606:4700::1111]/x",
  ])("allows %s", (u) => expect(validateWebhookUrl(u).ok).toBe(true));
  it.each([
    "http://hooks.example.com",
    "ftp://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pw@example.com",
    "https://example.com:22",
    "https://localhost/x",
    "https://foo.local/x",
    "https://api.internal/x",
    "https://intranet/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/",
    "https://172.16.3.4/",
    "https://172.31.255.255/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/",
    "https://0.0.0.0/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://0177.0.0.1/",
    "https://127.1/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[fd00::1]/",
    "https://[fe80::1]/",
    "https://224.0.0.1/",
    "not a url",
    "https://" + "a".repeat(2050) + ".com",
  ])("blocks %s", (u) => expect(validateWebhookUrl(u).ok).toBe(false));
  it("allows http only for explicitly allowed dev hosts", () => {
    expect(validateWebhookUrl("http://127.0.0.1:8787/hook", { allowHttpHosts: ["127.0.0.1"] }).ok).toBe(true);
    expect(validateWebhookUrl("http://127.0.0.1:8787/hook").ok).toBe(false);
  });
  it.each([
    ["1.2.3.4", [1, 2, 3, 4]],
    ["2130706433", [127, 0, 0, 1]],
    ["0x7f.1", [127, 0, 0, 1]],
    ["10.1", [10, 0, 0, 1]],
    ["256.1.1.1", null],
    ["1.2.3.4.5", null],
    ["example", null],
    ["1..2", null],
  ] as [string, number[] | null][])("parseIpv4(%s)", (h, v) => expect(parseIpv4(h)).toEqual(v));
  it.each([
    ["8.8.8.8", false],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["192.169.0.1", false],
    ["198.18.0.1", true],
    ["::ffff:8.8.8.8", false],
    ["2001:db8::1", false],
  ])("isPrivateAddress(%s)=%s", (h, ok) => expect(isPrivateAddress(h)).toBe(ok));
  it("every 10.x / 127.x / 192.168.x literal is blocked", () =>
    fc.assert(
      fc.property(fc.constantFrom(10, 127), fc.nat(255), fc.nat(255), fc.nat(255), (a, b, c, d) => !validateWebhookUrl(`https://${a}.${b}.${c}.${d}/`).ok),
    ));
});

const def = (over: Partial<AutomationDefinition> = {}) => {
  const r = parseAutomation({
    name: "a",
    trigger: { event: "transaction.created" },
    conditions: [{ op: "contains", path: "data.description", value: "amazon" }],
    actions: [{ type: "categorise_transaction", categoryCode: "6200" }],
    ...over,
  });
  if (!r.ok) throw new Error(r.errors.join());
  return r.value;
};

describe("automation definitions", () => {
  it("applies defaults", () => expect(def()).toMatchObject({ enabled: true, maxRunsPerHour: 500, actions: [{ vatRateCode: null }] }));
  it.each([
    ["no actions", { actions: [] }],
    ["unknown trigger", { trigger: { event: "user.created" } }],
    ["unknown op", { conditions: [{ op: "regex", path: "data.x", value: "x" }] }],
    ["bad path", { conditions: [{ op: "eq", path: "data..x", value: 1 }] }],
    ["proto path", { conditions: [{ op: "eq", path: "__proto__.x", value: 1 }] }],
    ["gt with string", { conditions: [{ op: "gt", path: "data.amountPence", value: "5" }] }],
    ["bad category code", { actions: [{ type: "categorise_transaction", categoryCode: "abc" }] }],
    ["email action (not supported)", { actions: [{ type: "send_email", to: "x@y.z" }] }],
    ["too many actions", { actions: Array(11).fill({ type: "tag_transaction", tag: "x" }) }],
    ["too many conditions", { conditions: Array(21).fill({ op: "exists", path: "data.x" }) }],
    ["txn action on invoice trigger", { trigger: { event: "invoice.paid" }, conditions: [] }],
    ["self-retrigger without condition", { trigger: { event: "transaction.categorised" }, conditions: [] }],
    ["rate cap 0", { maxRunsPerHour: 0 }],
    ["bad tag", { actions: [{ type: "tag_transaction", tag: "Has Spaces" }] }],
    ["name too long", { name: "x".repeat(81) }],
  ])("rejects %s", (_n, over) => {
    const r = parseAutomation({
      name: "a",
      trigger: { event: "transaction.created" },
      conditions: [],
      actions: [{ type: "categorise_transaction", categoryCode: "6200" }],
      ...over,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
  it.each(TEMPLATES.map((t) => [t.id, t] as const))("template %s builds a valid automation", (_id, t) =>
    expect(parseAutomation(t.build({ merchant: "TRAINLINE", categoryCode: "6100", pounds: "500" })).ok).toBe(true),
  );
  it("template 'flag-large-outflow' fires only above the threshold", () => {
    const t = TEMPLATES.find((x) => x.id === "flag-large-outflow")!;
    const r = parseAutomation(t.build({ pounds: "500" }));
    if (!r.ok) throw new Error();
    const a = { id: "a1", def: r.value };
    expect(planAutomation(a, txnCreated({ amountPence: -50001 }), 0).actions).toHaveLength(1);
    expect(planAutomation(a, txnCreated({ amountPence: -50000 }), 0).actions).toHaveLength(0);
  });
});

describe("condition evaluation", () => {
  const c = {
    data: { amountPence: -2500, description: "Amazon Marketplace", categoryCode: "6200", nested: { x: 1 }, nil: null },
    event: { type: "transaction.created", actor: "pipeline" },
  };
  it.each([
    [{ op: "eq", path: "data.categoryCode", value: "6200" }, true],
    [{ op: "eq", path: "data.categoryCode", value: 6200 }, false],
    [{ op: "neq", path: "data.categoryCode", value: "6100" }, true],
    [{ op: "gt", path: "data.amountPence", value: -3000 }, true],
    [{ op: "gt", path: "data.amountPence", value: -2500 }, false],
    [{ op: "gte", path: "data.amountPence", value: -2500 }, true],
    [{ op: "lt", path: "data.amountPence", value: 0 }, true],
    [{ op: "lte", path: "data.amountPence", value: -2501 }, false],
    [{ op: "gt", path: "data.description", value: 1 }, false],
    [{ op: "contains", path: "data.description", value: "MARKET" }, true],
    [{ op: "contains", path: "data.description", value: "ebay" }, false],
    [{ op: "contains", path: "data.amountPence", value: "25" }, false],
    [{ op: "in", path: "data.categoryCode", value: ["6100", "6200"] }, true],
    [{ op: "in", path: "data.categoryCode", value: ["6100"] }, false],
    [{ op: "exists", path: "data.nested.x" }, true],
    [{ op: "exists", path: "data.nil" }, false],
    [{ op: "exists", path: "data.missing.deep" }, false],
    [{ op: "eq", path: "event.actor", value: "pipeline" }, true],
    [{ op: "eq", path: "data.constructor", value: null }, false],
  ] as [never, boolean][])("%j -> %s", (cond, ok) => expect(evaluateCondition(cond, c)).toBe(ok));
  it.each([
    ["a.b", { a: { b: 2 } }, 2],
    ["a", { a: 0 }, 0],
    ["a.b", { a: null }, undefined],
    ["toString", {}, undefined],
    ["a.length", { a: "xyz" }, undefined],
  ])("getPath(%s)", (p, o, v) => expect(getPath(o, p)).toBe(v));
});

describe("planAutomation", () => {
  const a = { id: "a1", def: def() };
  it("plans actions with stable idempotency keys", () => {
    const p = planAutomation(a, txnCreated(), 0);
    expect(p.matched).toBe(true);
    expect(p.actions).toEqual([{ index: 0, idempotencyKey: "a1:ev1:0", action: { type: "categorise_transaction", categoryCode: "6200", vatRateCode: null } }]);
    expect(planAutomation(a, txnCreated(), 0)).toEqual(p);
  });
  it.each([
    ["disabled", { id: "a1", def: def({ enabled: false }) }, txnCreated(), 0, "disabled"],
    ["other event", a, makeEvent("invoice.paid", { invoiceId: "i", number: "INV-1", grossPence: 1, transactionId: null }, ctx), 0, "trigger_mismatch"],
    ["condition false", a, txnCreated({ description: "TESCO" }), 0, "conditions_false"],
    ["rate capped", a, txnCreated(), 500, "rate_capped"],
    ["own output", a, txnCreated({}, { actor: "automation:a1", causationChain: ["automation:a1:x", "automation:a1:y"] }), 0, "loop_detected"],
    ["deep chain", a, txnCreated({}, { causationChain: Array.from({ length: 10 }, (_, i) => `e${i}`) }), 0, "loop_detected"],
  ] as const)("skips when %s", (_n, auto, ev, runs, why) => {
    const p = planAutomation(auto as never, ev as never, runs);
    expect(p.skipped).toBe(why);
    expect(p.actions).toEqual([]);
  });
  it("allows chains from other automations below the limit", () =>
    expect(planAutomation(a, txnCreated({}, { actor: "automation:other", causationChain: ["automation:other:1"] }), 0).actions).toHaveLength(1));
  it(`loop limit is ${LOOP_LIMIT}`, () => {
    expect(planAutomation(a, txnCreated({}, { causationChain: ["automation:a1:1"] }), 0).skipped).toBeUndefined();
    expect(planAutomation(a, txnCreated({}, { causationChain: ["automation:a1:1", "automation:a1:2", "automation:a1:3"] }), 0).skipped).toBe("loop_detected");
  });
  it("reports which condition failed", () => {
    const b = {
      id: "b",
      def: def({
        conditions: [
          { op: "exists", path: "data.description" },
          { op: "gt", path: "data.amountPence", value: 0 },
        ],
      }),
    };
    expect(planAutomation(b, txnCreated(), 0).failedCondition).toBe(1);
  });
  it("rate cap boundary", () => {
    expect(planAutomation(a, txnCreated(), 499).actions).toHaveLength(1);
    expect(planAutomation(a, txnCreated(), 500).actions).toHaveLength(0);
  });
  it("never plans more actions than defined, for any event", () =>
    fc.assert(
      fc.property(fc.string(), fc.integer(), fc.nat(1000), (d, amt, runs) => {
        const p = planAutomation(a, txnCreated({ description: d, amountPence: amt }), runs);
        return p.actions.length <= a.def.actions.length && (p.actions.length === 0 || (p.matched && !p.skipped));
      }),
    ));
});

describe("API keys", () => {
  it("generates parseable keys and stores only the hash", async () => {
    const k = await generateApiKey();
    expect(parseApiKey(k.key)).toEqual({ env: "live", prefix: k.prefix });
    expect(k.hash).toBe(await hashApiKey(k.key));
    expect(k.hash).not.toContain(k.key.slice(-10));
  });
  it("keys are unique", async () => {
    const ks = await Promise.all(Array.from({ length: 50 }, () => generateApiKey("test")));
    expect(new Set(ks.map((k) => k.key)).size).toBe(50);
    expect(ks.every((k) => k.key.startsWith("ap_test_"))).toBe(true);
  });
  it.each([
    "",
    "ap_live_short_x",
    "sk_live_abcdefgh_" + "x".repeat(32),
    "ap_prod_abcdefgh_" + "x".repeat(32),
    "ap_live_ABCDEFGH_" + "x".repeat(32),
    "ap_live_abcdefgh_" + "x".repeat(10),
    "ap_live_abcdefgh_" + "x".repeat(32) + "!",
  ])("rejects malformed key %j", (k) => expect(parseApiKey(k)).toBeNull());
  it.each([
    [["transactions:read"], "transactions:read", true],
    [["transactions:write"], "transactions:read", true],
    [["transactions:read"], "transactions:write", false],
    [["invoices:write"], "transactions:read", false],
    [[], "events:read", false],
    [["reports:read"], "reports:read", true],
    [["webhooks:write"], "webhooks:write", true],
  ] as [string[], never, boolean][])("hasScope(%j, %s)=%s", (g, n, ok) => expect(hasScope(g, n)).toBe(ok));
  it.each([
    [{ revoked_at: null, expires_at: null }, true],
    [{ revoked_at: "2026-01-01", expires_at: null }, false],
    [{ revoked_at: "2027-01-01", expires_at: null }, true],
    [{ revoked_at: null, expires_at: "2026-06-30" }, false],
    [{ revoked_at: null, expires_at: "2026-07-02" }, true],
  ])("isKeyUsable(%j)=%s", (k, ok) => expect(isKeyUsable(k, "2026-07-01")).toBe(ok));
  it("randomToken is url-safe", () => expect(randomToken(64)).toMatch(/^[A-Za-z0-9_-]+$/));
  it("sha256 of empty", async () => expect(await sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
});

describe("HTTP semantics", () => {
  const e = etagFor("inv1", 3);
  it.each([
    [null, false],
    ['W/"inv1.3"', true],
    ['"inv1.3"', true],
    ['W/"inv1.2"', false],
    ['W/"x", W/"inv1.3"', true],
    ["*", true],
  ] as [string | null, boolean][])("If-None-Match %j hits=%s", (h, ok) => expect(ifNoneMatchHits(h, e)).toBe(ok));
  it.each([
    [null, false],
    ["*", false],
    ['W/"inv1.3"', false],
    ['W/"inv1.2"', true],
    ["garbage", true],
  ] as [string | null, boolean][])("If-Match %j fails=%s", (h, bad) => expect(ifMatchFails(h, e)).toBe(bad));
  it("content etags are stable and differ by content", async () => {
    expect(await contentEtag("a")).toBe(await contentEtag("a"));
    expect(await contentEtag("a")).not.toBe(await contentEtag("b"));
  });
  it("token bucket: burst then throttle then refill", () => {
    let b = null;
    const allowed: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const r = takeToken(b, 0, 5, 1);
      b = r.bucket;
      allowed.push(r.allowed);
    }
    expect(allowed).toEqual([true, true, true, true, true, false]);
    expect(takeToken(b, 1000, 5, 1).allowed).toBe(true);
  });
  it("token bucket never exceeds capacity and remaining is non-negative", () =>
    fc.assert(
      fc.property(fc.array(fc.nat(5000), { maxLength: 50 }), (gaps) => {
        let b = null,
          t = 0;
        for (const g of gaps) {
          t += g;
          const r = takeToken(b, t, 10, 2);
          if (r.bucket.tokens > 10 || r.remaining < 0) return false;
          b = r.bucket;
        }
        return true;
      }),
    ));
  it("clock going backwards does not mint tokens", () => {
    const r1 = takeToken({ tokens: 0, updatedMs: 10_000 }, 5_000, 5, 1);
    expect(r1.allowed).toBe(false);
  });
  const row = { id: "1", amount_pence: 5, description: "x", secret: "s" };
  it.each([
    [undefined, ["id", "amount_pence", "description", "secret"]],
    ["amount_pence", ["id", "amount_pence"]],
    ["description,amount_pence", ["id", "amount_pence", "description"]],
    ["secret", ["id"]],
    ["", ["id", "amount_pence", "description", "secret"]],
  ] as [string | undefined, string[]][])("fields=%j", (f, keys) =>
    expect(Object.keys(selectFields(row, f, ["amount_pence", "description"])).sort()).toEqual(keys.sort()),
  );
  const allowed = { date: "txn_date", amount: "amount_pence" };
  it.each([
    [undefined, "created_at desc"],
    ["date", "txn_date asc, id asc"],
    ["-amount", "amount_pence desc, id desc"],
    ["-x; drop table", "created_at desc"],
    ["__proto__", "created_at desc"],
  ] as [string | undefined, string][])("orderBy(%j)", (s, sql) => expect(orderBy(s, allowed, "created_at desc")).toBe(sql));
  it.each([
    ["amazon", '"amazon"*'],
    ["AMAZON  prime", '"amazon"* AND "prime"*'],
    ['x" OR 1=1 --', '"x"* AND "or"* AND "1"* AND "1"*'],
    ["", null],
    ["***", null],
    ["café", '"café"*'],
  ] as [string, string | null][])("ftsQuery(%j)", (q, out) => expect(ftsQuery(q)).toBe(out));
  it("ftsQuery output never contains unbalanced quotes or operators", () =>
    fc.assert(
      fc.property(fc.string(), (s) => {
        const q = ftsQuery(s);
        return q === null || ((q.match(/"/g)?.length ?? 0) % 2 === 0 && !/[()^:]/.test(q));
      }),
    ));
});

describe("feature flags and quotas", () => {
  const flags = parseFlags(
    JSON.stringify({
      realtime: { default: false, tenants: { t1: true } },
      newVat: { default: true, tenants: { t2: false } },
      half: { default: false, rolloutPercent: 50 },
    }),
  );
  it.each([
    ["realtime", "t1", true],
    ["realtime", "t2", false],
    ["newVat", "t1", true],
    ["newVat", "t2", false],
    ["unknown", "t1", false],
  ])("%s for %s = %s", (f, t, ok) => expect(isEnabled(flags, f, t)).toBe(ok));
  it.each([null, "", "{bad", "[]", "42", "null"])("bad flag JSON %j fails safe", (j) => expect(parseFlags(j)).toEqual({}));
  it("rollout is deterministic and roughly proportional", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `tenant-${i}`);
    const on = ids.filter((id) => isEnabled(flags, "half", id)).length;
    expect(on).toBeGreaterThan(850);
    expect(on).toBeLessThan(1150);
    expect(ids.every((id) => isEnabled(flags, "half", id) === isEnabled(flags, "half", id))).toBe(true);
  });
  it("bucketOf in [0,100)", () => fc.assert(fc.property(fc.string(), (s) => bucketOf(s) >= 0 && bucketOf(s) < 100)));
  it.each([
    ["free", "transactions", 499, 1, true],
    ["free", "transactions", 500, 1, false],
    ["starter", "transactions", 4999, 1, true],
    [null, "api_requests", 0, 10_001, false],
    ["unknown-plan", "transactions", 0, 1, true],
    ["pro", "nope", 1e12, 1, true],
  ] as [string | null, string, number, number, boolean][])("quota %s/%s used=%i +%i allowed=%s", (p, m, used, add, ok) =>
    expect(quotaCheck(p, m, used, add).allowed).toBe(ok),
  );
});

import { hasFeature, PLAN_FEATURES, FEATURES, PLAN_SEATS } from "../src/flags.js";
describe("plan entitlements", () => {
  it("free is minimal, pro and trial have everything, unknown plans fall back to free", () => {
    expect(hasFeature("free", "forecast")).toBe(true);
    expect(hasFeature("free", "mtd")).toBe(false);
    expect(hasFeature("starter", "recurring_invoices")).toBe(true);
    expect(hasFeature("starter", "mtd")).toBe(false);
    for (const f of FEATURES) expect(hasFeature("pro", f) && hasFeature("trial", f)).toBe(true);
    expect(hasFeature("nope", "mtd")).toBe(false);
    expect(hasFeature(null, "forecast")).toBe(true);
  });
  it("plans are nested (each higher plan includes the lower)", () => {
    const order = ["free", "starter", "pro"];
    for (let i = 1; i < order.length; i++) for (const f of PLAN_FEATURES[order[i - 1]!]!) expect(PLAN_FEATURES[order[i]!]).toContain(f);
    expect(PLAN_SEATS.free).toBeLessThan(PLAN_SEATS.starter!);
  });
});
