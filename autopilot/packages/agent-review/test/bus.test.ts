import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createBus, encodeCursor, decodeCursor, compareCursors } from "../src/bus.js";

describe("wake bus", () => {
  it("wakes every waiter on the key, only that key, once", async () => {
    const b = createBus();
    const a1 = b.wait("t:a", 5000);
    const a2 = b.wait("t:a", 5000);
    const other = b.wait("t:b", 30);
    expect(b.size()).toBe(3);
    expect(b.publish("t:a")).toBe(2);
    expect(await a1).toBe(true);
    expect(await a2).toBe(true);
    expect(await other).toBe(false);
    expect(b.size()).toBe(0);
    expect(b.publish("t:a")).toBe(0);
  });
  it("times out without a publish and cleans up", async () => {
    const b = createBus();
    expect(await b.wait("k", 5)).toBe(false);
    expect(await b.wait("k", -1)).toBe(false);
    expect(b.size()).toBe(0);
  });
  it("a timed-out waiter leaves other waiters on the key intact", async () => {
    const b = createBus();
    const short = b.wait("k", 5);
    const long = b.wait("k", 5000);
    expect(await short).toBe(false);
    expect(b.size()).toBe(1);
    expect(b.publish("k")).toBe(1);
    expect(await long).toBe(true);
  });
});

describe("cursor", () => {
  it("round-trips any timestamp/id", () =>
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes("|") && /^[\x20-\x7e]+$/.test(s)),
        fc.stringMatching(/^[a-z0-9]{1,30}$/),
        (t, id) => {
          expect(decodeCursor(encodeCursor(t, id))).toEqual({ updatedAt: t, id });
        },
      ),
    ));
  it("rejects junk", () => {
    for (const c of [null, undefined, "", "!!", "a".repeat(201), btoa("noseparator"), btoa("|x").replace(/=+$/, ""), btoa("x|").replace(/=+$/, ""), "a"])
      expect(decodeCursor(c)).toBeNull();
    expect(encodeCursor("2026-01-01T00:00:00.000Z", "r1")).not.toMatch(/[+/=]/);
  });
});

describe("compareCursors", () => {
  it("orders by time then id, and junk first", () => {
    const a = encodeCursor("2026-01-01T00:00:00.000Z", "b");
    const b = encodeCursor("2026-01-01T00:00:00.000Z", "c");
    const c = encodeCursor("2026-01-01T00:00:01.000Z", "a");
    expect(Math.sign(compareCursors(a, b))).toBe(-1);
    expect(Math.sign(compareCursors(b, a))).toBe(1);
    expect(Math.sign(compareCursors(b, c))).toBe(-1);
    expect(Math.sign(compareCursors(c, b))).toBe(1);
    expect(compareCursors(a, a)).toBe(0);
    expect(compareCursors("", a)).toBe(-1);
    expect(compareCursors(a, "")).toBe(1);
    expect(compareCursors("", "!")).toBe(0);
  });
  it("agrees with tuple order", () =>
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e12 }),
        fc.integer({ min: 0, max: 1e12 }),
        fc.stringMatching(/^[a-z]{1,4}$/),
        fc.stringMatching(/^[a-z]{1,4}$/),
        (t1, t2, i1, i2) => {
          const s1 = new Date(t1).toISOString();
          const s2 = new Date(t2).toISOString();
          const want = s1 === s2 ? (i1 === i2 ? 0 : i1 < i2 ? -1 : 1) : s1 < s2 ? -1 : 1;
          expect(Math.sign(compareCursors(encodeCursor(s1, i1), encodeCursor(s2, i2)))).toBe(want);
        },
      ),
    ));
});

describe("cursor strictness", () => {
  it("only accepts url-safe, bounded input and emits no padding", () => {
    expect(btoa("a|>>>")).toContain("+");
    expect(decodeCursor(btoa("a|>>>").replace(/=+$/, ""))).toBeNull();
    expect(decodeCursor(btoa("a|b?").replace(/=+$/, ""))).not.toBeNull();
    const long = btoa(`x|${"y".repeat(160)}`).replace(/=+$/, "");
    expect(long.length).toBeGreaterThan(200);
    expect(decodeCursor(long)).toBeNull();
    expect(decodeCursor(btoa(`x|${"y".repeat(100)}`).replace(/=+$/, ""))).not.toBeNull();
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9:.-]{1,30}$/), fc.stringMatching(/^[a-z0-9>?]{1,30}$/), (t, id) => /^[A-Za-z0-9_-]+$/.test(encodeCursor(t, id))),
    );
    expect(decodeCursor(`${encodeCursor("t", "i")}\n`)).toBeNull();
    expect(decodeCursor(`!${encodeCursor("t", "i")}`)).toBeNull();
  });
});
