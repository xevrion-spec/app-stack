import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Calendar, addBusinessSeconds, businessSecondsBetween, zonedToUtc } from "../src/calendar.js";

const london = Calendar.parse({ timeZone: "Europe/London", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", holidays: ["2026-12-25"] });
const at = (s: string) => Date.parse(s);
const out = (t: number) => new Date(t).toISOString();

describe("business calendar", () => {
  it("validates", () => {
    expect(Calendar.safeParse({ timeZone: "Mars/Olympus", days: [1], start: "09:00", end: "17:00" }).success).toBe(false);
    expect(Calendar.safeParse({ timeZone: "UTC", days: [1], start: "17:00", end: "09:00" }).success).toBe(false);
    expect(Calendar.safeParse({ timeZone: "UTC", days: [], start: "09:00", end: "17:00" }).success).toBe(false);
    expect(Calendar.safeParse({ timeZone: "UTC", days: [8], start: "09:00", end: "17:00" }).success).toBe(false);
    expect(Calendar.safeParse({ timeZone: "UTC", days: [1], start: "9:00", end: "17:00" }).success).toBe(false);
    expect(Calendar.safeParse({ timeZone: "UTC", days: [1], start: "09:00", end: "24:00" }).success).toBe(false);
    expect(Calendar.parse({ timeZone: "UTC", days: [7], start: "00:00", end: "23:59" }).holidays).toEqual([]);
  });
  it("adds within a day, across the evening, over weekends and holidays", () => {
    // Monday 2026-10-26 10:00 GMT
    expect(out(addBusinessSeconds(at("2026-10-26T10:00:00Z"), 3600, london))).toBe("2026-10-26T11:00:00.000Z");
    expect(out(addBusinessSeconds(at("2026-10-26T16:30:00Z"), 3600, london))).toBe("2026-10-27T09:30:00.000Z");
    // Friday 16:00 + 2h → Monday 10:00
    expect(out(addBusinessSeconds(at("2026-10-30T16:00:00Z"), 7200, london))).toBe("2026-11-02T10:00:00.000Z");
    // Saturday night → Monday open + 1h
    expect(out(addBusinessSeconds(at("2026-10-31T23:00:00Z"), 3600, london))).toBe("2026-11-02T10:00:00.000Z");
    // Thursday 24 Dec 16:00 + 2h skips Christmas Day → Monday 28 Dec 10:00
    expect(out(addBusinessSeconds(at("2026-12-24T16:00:00Z"), 7200, london))).toBe("2026-12-28T10:00:00.000Z");
    // exactly at close lands on close; zero adds nothing inside hours
    expect(out(addBusinessSeconds(at("2026-10-26T16:00:00Z"), 3600, london))).toBe("2026-10-26T17:00:00.000Z");
    expect(out(addBusinessSeconds(at("2026-10-26T12:00:00Z"), 0, london))).toBe("2026-10-26T12:00:00.000Z");
    expect(out(addBusinessSeconds(at("2026-10-26T08:00:00Z"), -5, london))).toBe("2026-10-26T09:00:00.000Z");
  });
  it("is DST-correct (London BST → GMT, New York)", () => {
    // Friday 23 Oct 2026 is BST (UTC+1): 09:00 local = 08:00Z
    expect(out(addBusinessSeconds(at("2026-10-23T07:00:00Z"), 60, london))).toBe("2026-10-23T08:01:00.000Z");
    // Friday 15:30 BST + 2h → Monday 26 Oct (GMT) 09:30 local = 09:30Z
    expect(out(addBusinessSeconds(at("2026-10-23T14:30:00Z"), 7200, london))).toBe("2026-10-26T09:30:00.000Z");
    const ny = Calendar.parse({ timeZone: "America/New_York", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" });
    expect(out(addBusinessSeconds(at("2026-03-09T12:00:00Z"), 60, ny))).toBe("2026-03-09T13:01:00.000Z");
    expect(zonedToUtc(2026, 3, 29, 1, 30, "Europe/London")).toBe(at("2026-03-29T01:30:00Z")); // 01:30 is skipped by BST: the later instant (02:30 BST)
    expect(zonedToUtc(2026, 7, 1, 12, 0, "Europe/London")).toBe(at("2026-07-01T11:00:00Z"));
  });
  it("throws when there is never any business time", () => {
    const allHolidays = Calendar.parse({ timeZone: "UTC", days: [1], start: "09:00", end: "10:00", holidays: [] });
    const never = { ...allHolidays, days: [1], holidays: Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)) };
    // all Mondays in 2026 are holidays but 2027 has Mondays, so it still resolves
    expect(addBusinessSeconds(at("2026-01-01T00:00:00Z"), 60, never)).toBeGreaterThan(at("2027-01-01T00:00:00Z"));
    expect(() => addBusinessSeconds(at("2026-01-01T00:00:00Z"), 3600 * 200, allHolidays)).toThrow(new RangeError("calendar has no business hours in range"));
  });
  it("properties: monotone, inverse of businessSecondsBetween, never lands outside hours", () =>
    fc.assert(
      fc.property(fc.integer({ min: at("2026-01-01T00:00:00Z"), max: at("2027-12-31T00:00:00Z") }), fc.integer({ min: 1, max: 40 * 3600 }), (from, secs) => {
        const t = addBusinessSeconds(from, secs, london);
        expect(t).toBeGreaterThanOrEqual(from + secs * 1000);
        expect(businessSecondsBetween(from, t, london)).toBe(secs);
        expect(addBusinessSeconds(from, secs + 60, london)).toBeGreaterThan(t);
        const local = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/London",
          hourCycle: "h23",
          hour: "2-digit",
          minute: "2-digit",
          weekday: "short",
        }).format(t);
        expect(/Sat|Sun/.test(local)).toBe(false);
        const hm = local.slice(-5);
        expect(hm >= "09:00" && hm <= "17:00").toBe(true);
      }),
      { numRuns: 300 },
    ));
  it("businessSecondsBetween: empty and reversed ranges", () => {
    expect(businessSecondsBetween(at("2026-10-26T10:00:00Z"), at("2026-10-26T10:00:00Z"), london)).toBe(0);
    expect(businessSecondsBetween(at("2026-10-26T11:00:00Z"), at("2026-10-26T10:00:00Z"), london)).toBe(0);
    expect(businessSecondsBetween(at("2026-10-31T10:00:00Z"), at("2026-11-01T20:00:00Z"), london)).toBe(0);
    expect(businessSecondsBetween(at("2026-10-26T00:00:00Z"), at("2026-10-28T00:00:00Z"), london)).toBe(16 * 3600);
  });
});

describe("calendar edges (mutation-driven)", () => {
  const base = { timeZone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  const issues = (o: Record<string, unknown>) => {
    const r = Calendar.safeParse({ ...base, ...o });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  it("field rules and messages", () => {
    expect(issues({})).toEqual([]);
    expect(issues({ start: "23:59", end: "23:59" })).toEqual(["end: end must be after start"]);
    expect(issues({ start: "00:00", end: "23:59" })).toEqual([]);
    expect(issues({ start: "19:60" })[0]).toBe("start: HH:MM, 24-hour");
    expect(issues({ start: "x09:00" })).toContain("start: HH:MM, 24-hour");
    expect(issues({ start: "09:00x" })).toContain("start: HH:MM, 24-hour");
    expect(issues({ end: "20:00", start: "1a:00" })).toContain("start: HH:MM, 24-hour");
    expect(issues({ timeZone: "Nowhere/Zone" })).toEqual(["timeZone: unknown IANA time zone"]);
    expect(issues({ timeZone: "" }).length).toBeGreaterThan(0);
    expect(issues({ timeZone: "x".repeat(65) }).length).toBeGreaterThan(0);
    expect(issues({ days: [0] })).toHaveLength(1);
    expect(issues({ days: [1, 2, 3, 4, 5, 6, 7, 1] })).toHaveLength(1);
    expect(issues({ days: [1.5] })).toHaveLength(1);
    expect(issues({ holidays: ["2026-1-01"] })).toHaveLength(1);
    expect(issues({ holidays: ["x2026-01-01"] })).toHaveLength(1);
    expect(issues({ holidays: ["2026-01-01x"] })).toHaveLength(1);
    expect(issues({ holidays: Array.from({ length: 367 }, () => "2026-01-01") })).toHaveLength(1);
  });
  it("between: spans weekends and holidays; partial windows at both ends; far ranges", () => {
    const cal = Calendar.parse({ ...base, holidays: ["2026-10-28"] });
    // Mon 26 Oct 16:00 → Thu 29 Oct 10:00: 1h Mon + 8h Tue + 0 Wed (holiday) + 1h Thu
    expect(businessSecondsBetween(at("2026-10-26T16:00:00Z"), at("2026-10-29T10:00:00Z"), cal)).toBe(10 * 3600);
    // ends before open on the first day
    expect(businessSecondsBetween(at("2026-10-26T06:00:00Z"), at("2026-10-26T08:00:00Z"), cal)).toBe(0);
    // ends exactly at open
    expect(businessSecondsBetween(at("2026-10-26T06:00:00Z"), at("2026-10-26T09:00:00Z"), cal)).toBe(0);
    expect(businessSecondsBetween(at("2026-10-26T06:00:00Z"), at("2026-10-26T09:00:01Z"), cal)).toBe(1);
    // starts after close
    expect(businessSecondsBetween(at("2026-10-26T18:00:00Z"), at("2026-10-27T09:30:00Z"), cal)).toBe(1800);
    expect(addBusinessSeconds(at("2026-10-28T12:00:00Z"), 60, cal)).toBe(at("2026-10-29T09:01:00Z"));
    expect(addBusinessSeconds(at("2026-10-26T18:00:00Z"), 1, cal)).toBe(at("2026-10-27T09:00:01Z"));
  });
  it("zonedToUtc both DST directions", () => {
    expect(zonedToUtc(2026, 10, 25, 1, 30, "Europe/London")).toBe(at("2026-10-25T01:30:00Z")); // repeated hour: the later (GMT) reading
    expect(zonedToUtc(2026, 1, 15, 9, 0, "America/New_York")).toBe(at("2026-01-15T14:00:00Z"));
    expect(zonedToUtc(2026, 7, 15, 9, 0, "America/New_York")).toBe(at("2026-07-15T13:00:00Z"));
    expect(zonedToUtc(2026, 7, 15, 9, 0, "Asia/Kolkata")).toBe(at("2026-07-15T03:30:00Z"));
  });
});
