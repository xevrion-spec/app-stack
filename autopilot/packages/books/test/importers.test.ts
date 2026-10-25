import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { detectFormat, parseOfx, parseQif, parseMt940, readCsv, detectAccountingSource, parseAccountingExport } from "../src/index.js";

const OFX1 = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>GBP<BANKACCTFROM><ACCTID>12345678</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105120000<TRNAMT>-12.50<FITID>A1<NAME>TESCO STORES 1234<MEMO>Card
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260106<TRNAMT>1000.00<FITID>A2<NAME>ACME LTD &amp; CO
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261340<TRNAMT>-1.00<FITID>BAD
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const OFX2 = `<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX><STMTTRN><DTPOSTED>20260201</DTPOSTED><TRNAMT>-3.20</TRNAMT><FITID>X9</FITID><NAME>Pret</NAME></STMTTRN></OFX>`;
const QIF = `!Type:Bank
D05/01/2026
T-12.50
PTesco
^
D06/01/2026
T1,000.00
PAcme
^
D31/02/2026
T-1
PBad
^`;
const MT940 = `:20:STMT
:25:GB12BANK12345612345678
:60F:C260101GBP100,00
:61:2601050105D12,50NTRFNONREF//B1
:86:TESCO STORES
:61:2601060106C1000,00NTRFNONREF
:86:ACME LTD
:62F:C260106GBP1087,50`;

describe("detectFormat", () => {
  it("detects each format", () => {
    expect(detectFormat(OFX1)).toBe("ofx");
    expect(detectFormat(OFX2)).toBe("ofx");
    expect(detectFormat(QIF)).toBe("qif");
    expect(detectFormat(MT940)).toBe("mt940");
    expect(detectFormat("date,description,amount\n")).toBe("csv");
  });
  it("never throws on arbitrary text", () => fc.assert(fc.property(fc.string(), (s) => ["ofx", "qif", "mt940", "csv"].includes(detectFormat(s)))));
});

describe("parseOfx", () => {
  it("parses SGML 1.x with unclosed tags and rejects bad dates", () => {
    const r = parseOfx(OFX1);
    expect(r.format).toBe("ofx");
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ date: "2026-01-05", amountPence: -1250, externalId: "A1" });
    expect(r.lines[1]!.description).toContain("ACME LTD & CO");
    expect(r.lines[1]!.amountPence).toBe(100000);
    expect(r.rejected).toHaveLength(1);
  });
  it("parses XML 2.x", () => {
    const r = parseOfx(OFX2);
    expect(r.lines).toEqual([expect.objectContaining({ date: "2026-02-01", amountPence: -320, externalId: "X9" })]);
  });
  it("returns nothing for empty input", () => expect(parseOfx("").lines).toEqual([]));
  it("never throws", () => fc.assert(fc.property(fc.string(), (s) => Array.isArray(parseOfx(s).lines))));
});

describe("parseQif", () => {
  it("parses day-first dates and thousands separators", () => {
    const r = parseQif(QIF, { dayFirst: true });
    expect(r.lines.map((l) => [l.date, l.amountPence])).toEqual([
      ["2026-01-05", -1250],
      ["2026-01-06", 100000],
    ]);
    expect(r.rejected).toHaveLength(1);
  });
  it("never throws", () => fc.assert(fc.property(fc.string(), (s) => Array.isArray(parseQif(s).lines))));
});

describe("parseMt940", () => {
  it("parses :61: lines with :86: descriptions", () => {
    const r = parseMt940(MT940);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ date: "2026-01-05", amountPence: -1250 });
    expect(r.lines[0]!.description).toContain("TESCO");
    expect(r.lines[1]!.amountPence).toBe(100000);
  });
  it("never throws", () => fc.assert(fc.property(fc.string(), (s) => Array.isArray(parseMt940(s).lines))));
});

describe("readCsv", () => {
  it("handles quotes, escaped quotes, CRLF and embedded commas", () => {
    expect(readCsv('a,b\r\n"x, y","he said ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
    ]);
  });
  it("round-trips simple cells", () =>
    fc.assert(
      fc.property(fc.array(fc.array(fc.stringMatching(/^[a-z0-9][a-z0-9 ]{0,7}$/), { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 }), (rows) => {
        const text = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
        expect(readCsv(text)).toEqual(rows);
      }),
    ));
});

describe("accounting imports", () => {
  it("detects sources from headers", () => {
    expect(detectAccountingSource(["Date", "Amount", "Description", "Reference", "Account Code"])).toBe("xero");
    expect(detectAccountingSource(["foo", "bar"])).toBeNull();
  });
  it("parses a Xero export keeping the source category", () => {
    const r = parseAccountingExport("Date,Description,Reference,Amount,Account Code\n2026-01-05,Tesco,R1,-12.50,429\n", "xero");
    expect(r.source).toBe("xero");
    expect(r.lines[0]).toMatchObject({ amountPence: -1250, sourceCategory: "429" });
  });
  it("parses QuickBooks debit/credit columns", () => {
    const r = parseAccountingExport("Date,Description,Debit,Credit,Account\n2026-01-05,Shell,40.00,,Motor\n2026-01-06,Client,,200.00,Sales\n", "quickbooks");
    expect(r.lines.map((l) => l.amountPence)).toEqual([-4000, 20000]);
  });
  it("rejects bad rows rather than throwing", () => {
    const r = parseAccountingExport("Date,Description,Amount,Category\nnot-a-date,x,abc,Y\n", "freshbooks");
    expect(r.lines).toHaveLength(0);
    expect(r.rejected.length).toBeGreaterThan(0);
  });
});
