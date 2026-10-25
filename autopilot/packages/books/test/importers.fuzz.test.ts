/** Property-based fuzzing of statement parsers: round-trips from generated statements, invariants, and ReDoS budgets. */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseOfx, parseQif, parseMt940, readCsv, detectFormat, type ImportedLine } from "../src/index.js";

const day = fc
  .date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2098-12-31T00:00:00Z"), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));
const pence = fc.integer({ min: -99_999_999, max: 99_999_999 }).filter((n) => n !== 0);
const word = fc.stringMatching(/^[A-Z][A-Z0-9 &.-]{0,30}[A-Z0-9]$/);
const line = fc.record({ date: day, amountPence: pence, description: word });
const amt = (p: number) => `${p < 0 ? "-" : ""}${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, "0")}`;
const RUNS = { numRuns: 200 };

function invariants(lines: ImportedLine[]) {
  for (const l of lines) {
    expect(l.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isSafeInteger(l.amountPence)).toBe(true);
    expect(l.description.length).toBeGreaterThan(0);
  }
}

describe("OFX", () => {
  const ofx = (ls: { date: string; amountPence: number; description: string }[]) =>
    `OFXHEADER:100\n<OFX><BANKTRANLIST>${ls
      .map((l, i) => `<STMTTRN><DTPOSTED>${l.date.replace(/-/g, "")}120000<TRNAMT>${amt(l.amountPence)}<FITID>F${i}<NAME>${l.description}</STMTTRN>`)
      .join("\n")}</BANKTRANLIST></OFX>`;
  it("round-trips generated statements exactly", () =>
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (ls) => {
        const r = parseOfx(ofx(ls));
        expect(detectFormat(ofx(ls))).toBe("ofx");
        expect(r.rejected).toEqual([]);
        expect(r.lines.map((l) => [l.date, l.amountPence, l.description])).toEqual(ls.map((l) => [l.date, l.amountPence, l.description.replace(/\s+/g, " ")]));
      }),
      RUNS,
    ));
  it("never yields invalid lines from mutated input", () =>
    fc.assert(
      fc.property(fc.array(line, { maxLength: 5 }), fc.string(), fc.nat(), (ls, junk, at) => {
        const s = ofx(ls);
        const k = at % (s.length + 1);
        invariants(parseOfx(s.slice(0, k) + junk + s.slice(k)).lines);
      }),
      RUNS,
    ));
});

describe("QIF", () => {
  const qif = (ls: { date: string; amountPence: number; description: string }[]) =>
    "!Type:Bank\n" +
    ls
      .map((l) => {
        const [y, m, d] = l.date.split("-");
        return `D${d}/${m}/${y}\nT${amt(l.amountPence)}\nP${l.description}\n^`;
      })
      .join("\n") +
    "\n";
  it("round-trips generated statements exactly (UK day-first)", () =>
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (ls) => {
        const r = parseQif(qif(ls));
        expect(r.rejected).toEqual([]);
        expect(r.lines.map((l) => [l.date, l.amountPence])).toEqual(ls.map((l) => [l.date, l.amountPence]));
      }),
      RUNS,
    ));
  it("never yields invalid lines from arbitrary records", () =>
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 20 }), (recs) => invariants(parseQif("!Type:Bank\n" + recs.join("\n^\n")).lines)),
      RUNS,
    ));
});

describe("MT940", () => {
  const mt = (ls: { date: string; amountPence: number; description: string }[]) =>
    `:20:STMT\n:25:ACC1\n:60F:C260101GBP0,00\n` +
    ls
      .map((l) => {
        const yymmdd = l.date.slice(2).replace(/-/g, "");
        const a = Math.abs(l.amountPence);
        return `:61:${yymmdd}${l.amountPence < 0 ? "D" : "C"}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")}NTRFREF\n:86:${l.description}`;
      })
      .join("\n");
  const line2000s = fc.record({ date: day.filter((d) => d >= "2000-01-01" && d <= "2099-12-31"), amountPence: pence, description: word });
  it("round-trips generated statements exactly", () =>
    fc.assert(
      fc.property(fc.array(line2000s, { maxLength: 30 }), (ls) => {
        const r = parseMt940(mt(ls));
        expect(r.rejected).toEqual([]);
        expect(r.lines.map((l) => [l.date, l.amountPence, l.description])).toEqual(ls.map((l) => [l.date, l.amountPence, l.description.replace(/\s+/g, " ")]));
      }),
      RUNS,
    ));
  it("rejects absurd amounts instead of producing unsafe integers", () => {
    const r = parseMt940(`:20:X\n:61:260101C${"9".repeat(40)},00NTRFREF\n:86:HUGE`);
    invariants(r.lines);
    expect(r.lines).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });
});

describe("CSV reader", () => {
  const cell = fc.string({ maxLength: 20 });
  const enc = (c: string) => (/[",\n\r]/.test(c) || c === "" ? `"${c.replace(/"/g, '""')}"` : c);
  it("round-trips any table of strings (quotes, commas, newlines)", () =>
    fc.assert(
      fc.property(fc.array(fc.array(cell, { minLength: 2, maxLength: 5 }), { minLength: 1, maxLength: 20 }), (rows) => {
        const text = rows.map((r) => r.map(enc).join(",")).join("\r\n");
        // Rows whose cells are all empty or whitespace-only are treated as blank lines and skipped by design.
        expect(readCsv(text)).toEqual(rows.filter((r) => r.some((c) => c.trim() !== "")));
      }),
      RUNS,
    ));
});

describe("ReDoS / pathological input budgets (200 KB each, < 1.5 s)", () => {
  const big = (s: string) => s.repeat(Math.ceil(200_000 / s.length));
  it.each([
    ["ofx", () => parseOfx(big("<STMTTRN><DTPOSTED>2026"))],
    ["ofx-noclose", () => parseOfx("<STMTTRN>" + big("<NAME>" + "a".repeat(50)))],
    ["qif", () => parseQif(big("D1/1/26\nT1.00\n"))],
    ["mt940", () => parseMt940(":20:X\n" + big(":61:2601011,1111111111111111111111\n"))],
    ["mt940-narrative", () => parseMt940(":20:X\n:61:260101C1,00NTRF\n" + big(":86:" + "x".repeat(60) + "\n"))],
    ["csv", () => readCsv(big('"a,""b"",c",d\n'))],
    ["detect", () => detectFormat(big(":20:") + ":61:")],
  ])("%s", (_, fn) => {
    const t = performance.now();
    try {
      fn();
    } catch {
      /* throwing is fine; hanging is not */
    }
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
