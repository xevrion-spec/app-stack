import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { diffPayload } from "../src/diff.js";

describe("payload diff", () => {
  it("reports add/remove/change by path, sorted, nested and arrays", () => {
    const a = { amount: 100, to: "a@example.test", meta: { tier: "gold", tags: ["x", "y"] }, gone: true, "odd key": 1 };
    const b = { amount: 80, to: "a@example.test", meta: { tier: "gold", tags: ["x"], note: "n" }, "odd key": 2 };
    expect(diffPayload(a, b)).toEqual({
      changes: [
        { path: "amount", op: "change", from: 100, to: 80 },
        { path: "gone", op: "remove", from: true },
        { path: "meta.note", op: "add", to: "n" },
        { path: "meta.tags[1]", op: "remove", from: "y" },
        { path: '["odd key"]', op: "change", from: 1, to: 2 },
      ],
      truncated: false,
    });
    expect(diffPayload([1], [1, { a: 1 }]).changes).toEqual([{ path: "[1]", op: "add", to: { a: 1 } }]);
    expect(diffPayload({ a: [1] }, { a: { 0: 1 } }).changes).toEqual([{ path: "a", op: "change", from: [1], to: { 0: 1 } }]);
    expect(diffPayload(1, 2).changes).toEqual([{ path: "$", op: "change", from: 1, to: 2 }]);
    expect(diffPayload({ n: null }, { n: 0 }).changes).toEqual([{ path: "n", op: "change", from: null, to: 0 }]);
  });
  it("clips long values and bounds output", () => {
    const long = "z".repeat(500);
    const d = diffPayload({ s: "a", o: {} }, { s: long, o: { big: long } }).changes;
    expect((d[1]!.to as string).length).toBe(201);
    expect(d[0]).toEqual({ path: "o.big", op: "add", to: `${"z".repeat(200)}…` });
    expect(diffPayload({ o: { k: 1 } }, { o: { k: { deep: long } } }).changes[0]!.to).toBe(`${JSON.stringify({ deep: long }).slice(0, 200)}…`);
    expect(diffPayload({ o: [1] }, { o: [{ s: "short" }] }).changes[0]!.to).toEqual({ s: "short" });
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    expect(diffPayload({}, many, 3)).toMatchObject({ truncated: true });
    expect(diffPayload({}, many, 3).changes).toHaveLength(3);
    expect(diffPayload({}, many, 10).truncated).toBe(false);
    let deepA: unknown = 1;
    let deepB: unknown = 2;
    for (let i = 0; i < 20; i++) {
      deepA = { n: deepA };
      deepB = { n: deepB };
    }
    expect(diffPayload(deepA, deepB).changes).toHaveLength(1);
    expect(diffPayload(deepA, deepB).changes[0]!.path.split(".").length).toBe(12);
  });
  it("property: identical inputs never differ; different JSON always does", () =>
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (x, y) => {
        expect(diffPayload(x, structuredClone(x)).changes).toEqual([]);
        if (JSON.stringify(x) !== JSON.stringify(y)) expect(diffPayload(x, y, 10_000).changes.length).toBeGreaterThan(0);
      }),
    ));
});
