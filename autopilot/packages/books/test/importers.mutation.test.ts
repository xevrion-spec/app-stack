/** Exact-output tests written to kill surviving mutants in importers.ts (Stryker scoped run, M6). Synthetic data. */
import { describe, it, expect } from "vitest";
import { detectFormat, parseMt940, parseOfx, parseQif, readCsv } from "../src/importers.js";

describe("detectFormat edges", () => {
  it("anchors, leading whitespace, and both MT940 tags", () => {
    expect(detectFormat("   \n\nOFXHEADER:100")).toBe("ofx");
    expect(detectFormat("junk OFXHEADER:100")).toBe("csv");
    expect(detectFormat("x <OFX>")).toBe("ofx");
    expect(detectFormat("x <?OFX ?>")).toBe("ofx");
    expect(detectFormat("<stmttrn>")).toBe("ofx");
    expect(detectFormat("  !Type:Bank\n")).toBe("qif");
    expect(detectFormat("note !Type:Bank\n")).toBe("csv");
    expect(detectFormat(":20:REF\n:61:2607010701C1,00NTRFNONREF")).toBe("mt940");
    expect(detectFormat(":20:REF\n:25:ACC")).toBe("csv");
    expect(detectFormat("Date,Desc\n:61:x")).toBe("csv");
    expect(detectFormat("x:20:REF\nx:61:")).toBe("csv");
    expect(detectFormat(`${" ".repeat(10)}${"a".repeat(2100)}\n:20:\n:61:`)).toBe("csv");
  });
});

describe("OFX exact output", () => {
  const ofx = (body: string, head = "<OFX><ACCTID> 1234 <CURDEF>GBP") => `${head}${body}`;
  it("rejections carry the 1-based row and exact message; fields and account exact", () => {
    const r = parseOfx(
      ofx(
        "<STMTTRN><DTPOSTED>20260231<TRNAMT>1</STMTTRN>" +
          "<STMTTRN><DTPOSTED>20260701<TRNAMT>abc</STMTTRN>" +
          "<STMTTRN><DTPOSTED>20260702120000<TRNAMT>-1.50<FITID>F1<NAME> Tesco &amp; Co <MEMO> lunch  deal </STMTTRN>" +
          "<STMTTRN><DTPOSTED>20260703<TRNAMT>2</STMTTRN>",
      ),
    );
    expect(r.rejected).toEqual([
      { row: 1, error: "invalid or missing DTPOSTED" },
      { row: 2, error: "invalid TRNAMT" },
    ]);
    expect(r.lines).toEqual([
      { date: "2026-07-02", description: "Tesco & Co lunch deal", amountPence: -150, externalId: "F1", counterparty: "Tesco & Co" },
      { date: "2026-07-03", description: "(no description)", amountPence: 200 },
    ]);
    expect(r.account).toEqual({ id: "1234", currency: "GBP" });
    expect(parseOfx("<STMTTRN><DTPOSTED>20260701<TRNAMT>1<MEMO>only memo</STMTTRN>").lines[0]).toEqual({
      date: "2026-07-01",
      description: "only memo",
      amountPence: 100,
    });
    expect(parseOfx("<STMTTRN><DTPOSTED>20260701<TRNAMT>1").account).toEqual({});
    expect(parseOfx("<STMTTRN><TRNAMT>1").rejected).toEqual([{ row: 1, error: "invalid or missing DTPOSTED" }]);
    expect(parseOfx("<STMTTRN><DTPOSTED>x20260701<TRNAMT>1").rejected).toHaveLength(1);
    expect(parseOfx("<stmttrn><dtposted>20260701<trnamt>3<name>&lt;b&gt;</stmttrn>").lines[0]!.description).toBe("<b>");
  });
});

describe("QIF exact output", () => {
  it("rows count only real records; exact messages; payee/memo/ref combos", () => {
    const r = parseQif(
      "!Type:Bank\nD31/02/2026\nT1\n^\nD01/07/2026\nTabc\n^\nD02/07'26\nT-3.20\nP  Shell  \nMfuel\nN#42\n^\nD3/7/26\nU5\nMmemo only\n^\nD4.7.2026\nT1\n^\n",
    );
    expect(r.rejected).toEqual([
      { row: 1, error: "invalid or missing D (date)" },
      { row: 2, error: "invalid T (amount)" },
    ]);
    expect(r.lines).toEqual([
      { date: "2026-07-02", description: "Shell fuel", amountPence: -320, externalId: "#42", counterparty: "Shell" },
      { date: "2026-07-03", description: "memo only", amountPence: 500 },
      { date: "2026-07-04", description: "(no description)", amountPence: 100 },
    ]);
    expect(r.format).toBe("qif");
  });
  it("year handling, US order, CRLF and malformed dates", () => {
    expect(parseQif("D1/7/99\nT1\n^").lines[0]!.date).toBe("2099-07-01");
    expect(parseQif("D1/7/100\nT1\n^").rejected).toHaveLength(0);
    expect(parseQif("D1/7/100\nT1\n^").lines[0]!.date).toBe("0100-07-01");
    expect(parseQif("D7/1/2026\nT1\n^", { dayFirst: false }).lines[0]!.date).toBe("2026-07-01");
    expect(parseQif("D01/07/2026\r\nT1\r\n^\r\nD02/07/2026\r\nT2\r\n^\r\n").lines.map((l) => l.amountPence)).toEqual([100, 200]);
    expect(parseQif("D 1/7/2026x\nT1\n^").rejected).toEqual([{ row: 1, error: "invalid or missing D (date)" }]);
    expect(parseQif("Dx1/7/2026\nT1\n^").rejected).toHaveLength(1);
    expect(parseQif("D1/7/2026\nT1\n^  \nD2/7/2026\nT1\n^").lines).toHaveLength(2);
    expect(parseQif("D1/7/2026\nT1\n^ x\nD2/7/2026\nT2\n^").lines).toHaveLength(1);
    expect(parseQif("D1/7/2026\nT1\n^").lines[0]!.description).toBe("(no description)");
    expect(parseQif("D1/7/1\nT1\n^").rejected).toHaveLength(1);
  });
});

describe("MT940 exact output", () => {
  const stmt = (lines: string) => `:20:STMT\n:25: GB00SYNTH12345678 \n:60F:C260630GBP1000,00\n${lines}\n:62F:C260731GBP1000,00`;
  it("rejections, amounts, marks, references, narrative, account and currency", () => {
    const r = parseMt940(
      stmt(
        [
          ":61:garbage",
          ":61:2602310231C1,00NTRFNONREF",
          ":61:2607010701C99999999999,00NTRFNONREF",
          ":61:2607020702D12,5NTRFREF1//BANKREF",
          ":86:FIRST LINE",
          "SECOND LINE",
          ":61:2607030703RD1,NTRFNONREF",
          ":61:2607040704RC2,00NTRF",
          ":86:  spaced   out  ",
          ":61:2607050705C3,00",
        ].join("\n"),
      ),
    );
    expect(r.rejected).toEqual([
      { row: 1, error: "unrecognised :61: line" },
      { row: 2, error: "invalid value date" },
      { row: 3, error: "amount out of range" },
    ]);
    expect(r.lines).toEqual([
      { date: "2026-07-02", description: "FIRST LINE SECOND LINE", amountPence: -1250, externalId: "REF1" },
      { date: "2026-07-03", description: "NONREF", amountPence: 100 },
      { date: "2026-07-04", description: "spaced out", amountPence: -200 },
      { date: "2026-07-05", description: "(no description)", amountPence: 300 },
    ]);
    expect(r.account).toEqual({ id: "GB00SYNTH12345678", currency: "GBP" });
    expect(parseMt940(":20:X\n:61:2607010701C1,00NTRFNONREF").account).toEqual({});
    expect(parseMt940(":20:X\n:60M:D260630EUR1,00\n:61:2607010701C1,00").account).toEqual({ currency: "EUR" });
    expect(parseMt940(":20:X\n:61:2607010701C1000000000,00").rejected).toEqual([]);
    expect(parseMt940(":20:X\n:61:2607010701C1000000000,01").rejected).toEqual([{ row: 1, error: "amount out of range" }]);
    expect(parseMt940("\r\n:20:X\r\n:61:2607010701C1,5\r\n:86:A\r\n:62F:C").lines).toEqual([{ date: "2026-07-01", description: "A", amountPence: 150 }]);
    expect(parseMt940(":20:X\n:61:2607010701C1,00ABCD\n:86:n").lines[0]).toEqual({ date: "2026-07-01", description: "n", amountPence: 100, externalId: "D" });
  });
});

describe("readCsv exact output", () => {
  it("CRLF, lone CR, blank rows, quotes and the unterminated error message", () => {
    expect(readCsv("a,b\r\nc,d\re,f\n\n , \n")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
    expect(readCsv('"x ""y""",z\r\n"multi\nline",2')).toEqual([
      ['x "y"', "z"],
      ["multi\nline", "2"],
    ]);
    expect(() => readCsv('"open')).toThrow("unterminated quoted field");
    expect(readCsv("a\r")).toEqual([["a"]]);
    expect(readCsv("a\r\r\nb")).toEqual([["a"], ["b"]]);
    expect(readCsv("x, ")).toEqual([["x", " "]]);
    expect(readCsv("")).toEqual([]);
  });
});
