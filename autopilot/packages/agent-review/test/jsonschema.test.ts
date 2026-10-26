import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { SchemaLite, validateJson, schemaDepth } from "../src/jsonschema.js";

const refund = SchemaLite.parse({
  type: "object",
  required: ["orderId", "amount"],
  additionalProperties: false,
  properties: {
    orderId: { type: "string", pattern: "^SYN-[0-9]+$" },
    amount: { type: "number", minimum: 0.01, maximum: 500 },
    currency: { enum: ["GBP", "EUR"] },
    email: { type: "string", format: "email", maxLength: 80 },
    lines: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "object", required: ["sku"], properties: { sku: { type: "string", minLength: 2 }, qty: { type: "integer" } } },
    },
    kind: { const: "refund" },
    when: { type: "string", format: "date" },
    at: { type: "string", format: "date-time" },
    link: { type: "string", format: "uri" },
  },
});

describe("schema-lite validator", () => {
  it("accepts a valid payload", () => {
    expect(
      validateJson(refund, {
        orderId: "SYN-1",
        amount: 20,
        currency: "GBP",
        email: "a@b.co",
        lines: [{ sku: "ab", qty: 2 }],
        kind: "refund",
        when: "2026-10-26",
        at: "2026-10-26T10:00:00Z",
        link: "https://x.test/a",
      }),
    ).toEqual([]);
  });
  it("reports precise errors", () => {
    expect(
      validateJson(refund, {
        orderId: "X",
        amount: 900,
        currency: "USD",
        email: "nope",
        lines: [],
        kind: "x",
        when: "2026-13-45",
        at: "26/10",
        link: "x",
        extra: 1,
      }),
    ).toEqual([
      "orderId: does not match the required pattern",
      "amount: must be <= 500",
      'currency: must be one of "GBP", "EUR"',
      "email: must be a valid email",
      "lines: must have at least 1 items",
      'kind: must be "refund"',
      "when: must be a valid date",
      "at: must be a valid date-time",
      "link: must be a valid uri",
      "extra: is not allowed",
    ]);
    expect(validateJson(refund, { amount: 0 })).toEqual(["orderId: is required", "amount: must be >= 0.01"]);
    expect(validateJson(refund, { orderId: "SYN-1", amount: 1, lines: [{ qty: 1.5 }, { sku: "a" }, {}, {}] })).toEqual([
      "lines: must have at most 3 items",
      "lines[0].sku: is required",
      "lines[0].qty: must be integer",
      "lines[1].sku: must be at least 2 characters",
      "lines[2].sku: is required",
      "lines[3].sku: is required",
    ]);
    expect(validateJson(refund, [])).toEqual(["$: must be object"]);
    expect(validateJson(refund, null)).toEqual(["$: must be object"]);
    expect(validateJson({ type: "string", maxLength: 2 }, "abc")).toEqual(["$: must be at most 2 characters"]);
    expect(validateJson({ type: "integer" }, 2)).toEqual([]);
    expect(validateJson({ type: "number" }, 2)).toEqual([]);
    expect(validateJson({ type: "number" }, "2")).toEqual(["$: must be number"]);
    expect(validateJson({ type: "boolean" }, true)).toEqual([]);
    expect(validateJson({ type: "null" }, null)).toEqual([]);
    expect(validateJson({ type: "array" }, {})).toEqual(["$: must be array"]);
    expect(validateJson({ properties: { a: { type: "string" } } }, { a: 1, b: 2 })).toEqual(["a: must be string"]);
    expect(validateJson({ minimum: 1 }, "x")).toEqual([]);
    expect(validateJson({ minLength: 1 }, 5)).toEqual([]);
    expect(validateJson({ minItems: 1 }, "x")).toEqual([]);
    expect(validateJson({ required: ["a"] }, "x")).toEqual([]);
    expect(validateJson({ type: "object", properties: { o: { type: "object", required: ["x"] } } }, { o: {} })).toEqual(["o.x: is required"]);
    expect(validateJson({ type: "object", properties: { o: { additionalProperties: false } } }, { o: { z: 1 } })).toEqual(["o.z: is not allowed"]);
  });
  it("caps errors and depth", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 1]));
    expect(validateJson({ type: "object", additionalProperties: false }, many)).toHaveLength(20);
    expect(validateJson({ type: "object", additionalProperties: false }, many, 3)).toHaveLength(3);
    let s: Record<string, unknown> = { type: "string" };
    let v: unknown = 1;
    for (let i = 0; i < 12; i++) {
      s = { type: "object", properties: { n: s } };
      v = { n: v };
    }
    expect(validateJson(SchemaLite.parse(s), v)).toEqual([]);
    expect(schemaDepth(SchemaLite.parse(s))).toBe(13);
    expect(schemaDepth({ type: "array", items: { type: "string" } })).toBe(2);
    expect(schemaDepth({})).toBe(1);
  });
  it("refuses unsafe or unknown schema keywords", () => {
    const bad = (s: unknown) => SchemaLite.safeParse(s).success;
    expect(bad({ $ref: "#/x" })).toBe(false);
    expect(bad({ pattern: "(a+)+$" })).toBe(false);
    expect(bad({ pattern: "(a*)*" })).toBe(false);
    expect(bad({ pattern: "(a)\\1" })).toBe(false);
    expect(bad({ pattern: "[" })).toBe(false);
    expect(bad({ pattern: "^[a-z]+$" })).toBe(true);
    expect(bad({ type: "date" })).toBe(false);
    expect(bad({ enum: [] })).toBe(false);
    expect(bad({ properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, {}])) })).toBe(false);
    expect(bad({ properties: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`p${i}`, {}])) })).toBe(true);
  });
  it("property: never throws on arbitrary JSON", () =>
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(Array.isArray(validateJson(refund, v))).toBe(true);
      }),
    ));
});

describe("schema-lite boundaries and formats", () => {
  const v = (s: Record<string, unknown>, x: unknown) => validateJson(SchemaLite.parse(s), x);
  it("inclusive bounds", () => {
    expect(v({ minimum: 1, maximum: 3 }, 1)).toEqual([]);
    expect(v({ minimum: 1, maximum: 3 }, 3)).toEqual([]);
    expect(v({ minLength: 2, maxLength: 2 }, "ab")).toEqual([]);
    expect(v({ minLength: 2 }, "a")).toEqual(["$: must be at least 2 characters"]);
    expect(v({ minItems: 1, maxItems: 1 }, [0])).toEqual([]);
    expect(v({ maxItems: 1 }, [0, 1])).toEqual(["$: must have at most 1 items"]);
    expect(v({ enum: [0] }, false)).toEqual(["$: must be one of 0"]);
    expect(v({ const: null }, null)).toEqual([]);
    expect(v({ const: 0 }, false)).toEqual(["$: must be 0"]);
    expect(v({ type: "integer" }, 1.5)).toEqual(["$: must be integer"]);
    expect(v({ type: "integer" }, "1")).toEqual(["$: must be integer"]);
    expect(v({ type: "string" }, null)).toEqual(["$: must be string"]);
    expect(v({ type: "object" }, [])).toEqual(["$: must be object"]);
    expect(v({ items: { type: "string" } }, ["a", 1])).toEqual(["[1]: must be string"]);
    expect(v({ pattern: "^a" }, "ba")).toEqual(["$: does not match the required pattern"]);
    expect(v({ type: "object", additionalProperties: false, properties: { a: {} } }, { a: 1 })).toEqual([]);
    expect(v({ type: "object", additionalProperties: true }, { a: 1 })).toEqual([]);
  });
  it("formats", () => {
    const ok = (f: string, x: string) => v({ type: "string", format: f }, x).length === 0;
    expect([
      ok("email", "a@b.co"),
      ok("email", "a b@c.co"),
      ok("email", "a@b"),
      ok("email", "@b.co"),
      ok("email", "a@b.co x"),
      ok("email", "xa@b.co"),
      ok("email", "a@@b.co"),
    ]).toEqual([true, false, false, false, false, true, false]);
    expect([
      ok("uri", "https://x.test/a"),
      ok("uri", "https://"),
      ok("uri", " https://x"),
      ok("uri", "1http://x"),
      ok("uri", "web+x://y"),
      ok("uri", "https://a b"),
      ok("uri", "HTTPS://X"),
    ]).toEqual([true, false, false, false, true, false, true]);
    expect([ok("date", "2026-10-26"), ok("date", "2026-10-26x"), ok("date", "x2026-10-26"), ok("date", "2026-1-26"), ok("date", "2026-99-99")]).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect([
      ok("date-time", "2026-10-26T10:00Z"),
      ok("date-time", "2026-10-26T10:00:00.123+01:00"),
      ok("date-time", "2026-10-26T10:00:00"),
      ok("date-time", "x2026-10-26T10:00:00Z"),
      ok("date-time", "2026-10-26T10:00:00Zx"),
      ok("date-time", "2026-10-26T10:00:00-05:30"),
      ok("date-time", "2026-10-26T10:00:00.Z"),
      ok("date-time", "2026-13-26T10:00:00Z"),
      ok("date-time", "2026-10-26 10:00:00Z"),
    ]).toEqual([true, true, false, false, false, true, false, false, false]);
  });
  it("error and walk caps, depth beyond 8 is not walked", () => {
    expect(
      v(
        { type: "array", items: { type: "string" } },
        Array.from({ length: 1005 }, () => 1),
      ),
    ).toHaveLength(20);
    const arr = Array.from({ length: 1005 }, (_, i) => (i < 1000 ? "s" : 1));
    expect(v({ type: "array", items: { type: "string" } }, arr)).toEqual([]);
    expect(v({ pattern: "b$" }, `${"a".repeat(10_000)}b`)).toEqual(["$: does not match the required pattern"]);
    let s: Record<string, unknown> = { type: "string" };
    let x: unknown = 1;
    for (let i = 0; i < 8; i++) {
      s = { type: "object", properties: { n: s } };
      x = { n: x };
    }
    expect(v(s, x)).toHaveLength(1);
    expect(validateJson({ required: ["a", "b", "c"] }, {}, 2)).toEqual(["a: is required", "b: is required"]);
  });
});
