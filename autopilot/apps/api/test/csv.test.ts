import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseCsv, parseBankCsv, toIsoDate, sha256Hex } from "../src/services/csv.js";
import { parseAmountToPence } from "@xevrion/pipeline";

describe("parseAmountToPence: accepted UK renderings", () => {
  it.each([
    ["0", 0],
    ["0.00", 0],
    ["-0.00", 0],
    ["1", 100],
    ["1.5", 150],
    ["1.05", 105],
    ["12.34", 1234],
    ["-12.34", -1234],
    ["+12.34", 1234],
    ["£9.99", 999],
    ["-£9.99", -999],
    ["£-9.99", -999],
    ["(45.00)", -4500],
    ["(£45.00)", -4500],
    ["1,234.56", 123456],
    ["-1,234,567.89", -123456789],
    [" 12.00 ", 1200],
    ["12.00 CR", 1200],
    ["12.00 DR", -1200],
    ["12.00cr", 1200],
    ["12.00-", -1200],
    ["\u221212.00", -1200],
    ["1 234.56", 123456],
    ["$5", 500],
    ["€5.10", 510],
    ["999999999.99", 99999999999],
    [".5".replace(".", "0."), 50],
  ] as [string, number][])("%j -> %i", (raw, pence) => expect(parseAmountToPence(raw)).toBe(pence));
});

describe("parseAmountToPence: rejects ambiguous or malformed input", () => {
  it.each([
    "",
    " ",
    "abc",
    "1.234",
    "1,23",
    "12,34.56",
    "1,2345",
    "--5",
    "+-5",
    "-+5",
    "1-2",
    "(5",
    "5)",
    "((5))x",
    "1.2.3",
    "£",
    "CR",
    "12..3",
    "1e5",
    "0x10",
    "NaN",
    "Infinity",
    "12.3.4",
    "=1+2",
    "99999999999999999999",
    "5 GBP",
  ])("%j throws", (raw) => expect(() => parseAmountToPence(raw)).toThrow(RangeError));
});

describe("parseAmountToPence: properties", () => {
  it("round-trips any formatted pence value", () =>
    fc.assert(
      fc.property(fc.integer({ min: -1e11, max: 1e11 }), (p) => {
        const abs = Math.abs(p);
        const s = `${p < 0 ? "-" : ""}${Math.trunc(abs / 100).toLocaleString("en-GB")}.${String(abs % 100).padStart(2, "0")}`;
        return parseAmountToPence(s) === p;
      }),
    ));
  it("brackets and DR always negate a positive amount", () =>
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), (p) => {
        const s = (p / 100).toFixed(2);
        return parseAmountToPence(`(${s})`) === -p && parseAmountToPence(`${s} DR`) === -p && parseAmountToPence(`${s} CR`) === p;
      }),
    ));
});

describe("toIsoDate", () => {
  it.each([
    ["2026-07-01", "2026-07-01"],
    ["2026-07-01 10:22:11", "2026-07-01"],
    ["2026-07-01T10:22:11Z", "2026-07-01"],
    ["01/07/2026", "2026-07-01"],
    ["1/7/2026", "2026-07-01"],
    ["01-07-26", "2026-07-01"],
    ["01.07.2026", "2026-07-01"],
    ["31/12/2025", "2025-12-31"],
    ["29/02/2028", "2028-02-29"],
    ["01 Jul 2026", "2026-07-01"],
    ["01-Jul-26", "2026-07-01"],
    ["5 April 2026", "2026-04-05"],
    ["06/04/2026", "2026-04-06"],
    [" 01/07/2026 ", "2026-07-01"],
  ])("%j -> %s", (raw, iso) => expect(toIsoDate(raw)).toBe(iso));
  it.each([
    "",
    "2026-13-01",
    "2026-02-30",
    "29/02/2027",
    "31/04/2026",
    "00/01/2026",
    "32/01/2026",
    "01/13/2026",
    "2026/07/01x",
    "07-2026",
    "yesterday",
    "01 Foo 2026",
    "1899-01-01",
    "12/31/2026",
  ])("%j rejected", (raw) => expect(() => toIsoDate(raw)).toThrow(RangeError));
  it("accepts every real calendar day 2024-2027 in UK format", () =>
    fc.assert(
      fc.property(fc.date({ min: new Date("2024-01-01"), max: new Date("2027-12-31"), noInvalidDate: true }), (d) => {
        const iso = d.toISOString().slice(0, 10);
        const [y, m, dd] = iso.split("-");
        return toIsoDate(`${dd}/${m}/${y}`) === iso;
      }),
    ));
});

describe("parseCsv (RFC 4180)", () => {
  it.each([
    [
      "a,b\n1,2",
      [
        ["a", "b"],
        ["1", "2"],
      ],
    ],
    [
      "a,b\r\n1,2\r\n",
      [
        ["a", "b"],
        ["1", "2"],
      ],
    ],
    [
      "a,b\r1,2",
      [
        ["a", "b"],
        ["1", "2"],
      ],
    ],
    ['"x, y",z', [["x, y", "z"]]],
    ['"he said ""hi""",1', [['he said "hi"', "1"]]],
    ['"multi\nline",1', [["multi\nline", "1"]]],
    [
      "\uFEFFdate,amount\n1,2",
      [
        ["date", "amount"],
        ["1", "2"],
      ],
    ],
    [
      "a,b\n\n\n1,2\n,\n",
      [
        ["a", "b"],
        ["1", "2"],
      ],
    ],
    ["a,,c", [["a", "", "c"]]],
    ['""', []],
  ] as [string, string[][]][])("%j", (text, rows) => expect(parseCsv(text)).toEqual(rows));
  it("throws on an unterminated quote instead of swallowing the rest of the file", () => expect(() => parseCsv('a,b\n"oops,1\n2,3')).toThrow(/unterminated/));
  it("round-trips arbitrary field content", () =>
    fc.assert(
      fc.property(fc.array(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 5 }), (rows) => {
        const norm = rows.map((r) => r.map((f) => (f.trim() === "" ? "x" + f : f)));
        const text = norm.map((r) => r.map((f) => `"${f.replace(/"/g, '""')}"`).join(",")).join("\r\n");
        expect(parseCsv(text)).toEqual(norm);
      }),
    ));
});

/** Header layouts modelled on real UK bank exports (synthetic rows). */
const FORMATS: [string, string, { date: string; description: string; amountPence: number; currency?: string }][] = [
  [
    "Barclays",
    "Number,Date,Account,Amount,Subcategory,Memo\n,01/07/2026,20-00-00 12345678,-12.50,PAYMENT,TRAINLINE.COM",
    { date: "2026-07-01", description: "TRAINLINE.COM", amountPence: -1250 },
  ],
  [
    "Lloyds/Halifax/BoS",
    "Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance\n01/07/2026,DEB,'30-00-00,12345678,ADOBE SYSTEMS,19.97,,1000.00",
    { date: "2026-07-01", description: "ADOBE SYSTEMS", amountPence: -1997 },
  ],
  [
    "Lloyds credit",
    "Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance\n02/07/2026,FPI,'30-00-00,12345678,STRIPE PAYOUT,,250.00,1250.00",
    { date: "2026-07-02", description: "STRIPE PAYOUT", amountPence: 25000 },
  ],
  [
    "NatWest/RBS",
    "Date, Type, Description, Value, Balance, Account Name, Account Number\n01/07/2026,D/D,\"VODAFONE LTD\",-30.00,970.00,'BUSINESS,'123456-12345678",
    { date: "2026-07-01", description: "VODAFONE LTD", amountPence: -3000 },
  ],
  [
    "Nationwide",
    '"Date","Transaction type","Description","Paid out","Paid in","Balance"\n"01 Jul 2026","Payment to","RYMAN","£12.99","","£987.01"',
    { date: "2026-07-01", description: "RYMAN", amountPence: -1299 },
  ],
  [
    "Nationwide paid in",
    '"Date","Transaction type","Description","Paid out","Paid in","Balance"\n"03 Jul 2026","Bank credit","ACME LTD","","£1,200.00","£2,187.01"',
    { date: "2026-07-03", description: "ACME LTD", amountPence: 120000 },
  ],
  [
    "Monzo",
    "Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In\ntx_1,01/07/2026,09:00:00,Card payment,Pret,,Eating out,-4.50,GBP,-4.50,GBP,,,,PRET A MANGER LONDON,,-4.50,",
    { date: "2026-07-01", description: "PRET A MANGER LONDON", amountPence: -450, currency: "GBP" },
  ],
  [
    "Starling",
    "Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category,Notes\n01/07/2026,GitHub,GITHUB SPONSOR,CARD,-7.00,993.00,GENERAL,",
    { date: "2026-07-01", description: "GitHub", amountPence: -700 },
  ],
  [
    "Revolut Business",
    "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nCARD_PAYMENT,Current,2026-07-01 08:00:00,2026-07-02 09:10:11,Notion Labs,-8.00,0.00,USD,COMPLETED,100.00",
    { date: "2026-07-02", description: "Notion Labs", amountPence: -800, currency: "USD" },
  ],
  [
    "Santander",
    "Date,Description,Amount,Balance\n01/07/2026,CARD PAYMENT TO TFL TRAVEL CH,-2.80,997.20",
    { date: "2026-07-01", description: "CARD PAYMENT TO TFL TRAVEL CH", amountPence: -280 },
  ],
  ["HSBC", "Date,Details,Paid out,Paid in,Balance\n01-07-26,BP FUEL,45.10,,900.00", { date: "2026-07-01", description: "BP FUEL", amountPence: -4510 }],
  ["Metro", "Date,Narrative,Money Out,Money In\n2026-07-01,PLUSNET,24.99,", { date: "2026-07-01", description: "PLUSNET", amountPence: -2499 }],
  [
    "Tide",
    "Date,Transaction description,Paid in,Paid out,Currency\n01/07/2026,FIVERR,,40.00,GBP",
    { date: "2026-07-01", description: "FIVERR", amountPence: -4000, currency: "GBP" },
  ],
  ["Co-op", "Date,Payee,Amount\n01/07/2026,CHECKATRADE,(60.00)", { date: "2026-07-01", description: "CHECKATRADE", amountPence: -6000 }],
  ["CR/DR suffix", "Date,Description,Amount\n01/07/2026,REMITTANCE ACME,250.00 CR", { date: "2026-07-01", description: "REMITTANCE ACME", amountPence: 25000 }],
];

describe("parseBankCsv: UK bank formats", () => {
  it.each(FORMATS)("%s", (_n, text, want) => {
    const r = parseBankCsv(text);
    expect(r.rejected).toEqual([]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ row: 2, currency: want.currency ?? r.lines[0]!.currency, ...want });
  });
});

describe("parseBankCsv: malformed input", () => {
  it.each([
    ["header only", "Date,Description,Amount", /header row/],
    ["empty", "", /header row/],
    ["no date column", "When,Description,Amount\n1,a,1", /must have/],
    ["no amount column", "Date,Description,Balance\n01/07/2026,a,1", /must have/],
    ["only paid out, no paid in", "Date,Description,Paid out\n01/07/2026,a,1", /must have/],
    ["unterminated quote", 'Date,Description,Amount\n01/07/2026,"oops,1', /unterminated/],
  ])("%s throws", (_n, text, err) => expect(() => parseBankCsv(text)).toThrow(err));

  it.each([
    ["bad date", "31/02/2026,X,1.00", /invalid date/],
    ["garbage date", "soon,X,1.00", /unrecognised date/],
    ["empty description", "01/07/2026,  ,1.00", /empty description/],
    ["shifted columns", "01/07/2026,X,12,34", /columns/],
    ["text amount", "01/07/2026,X,ten pounds", /unparseable/],
    ["missing amount", "01/07/2026,X", /unparseable/],
    ["three decimals", "01/07/2026,X,1.234", /unparseable/],
  ])("row with %s is rejected, others kept", (_n, row, err) => {
    const r = parseBankCsv(`Date,Description,Amount\n01/07/2026,GOOD,1.00\n${row}\n02/07/2026,GOOD2,-2.00`);
    expect(r.lines.map((l) => l.description)).toEqual(["GOOD", "GOOD2"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.row).toBe(3);
    expect(r.rejected[0]!.error).toMatch(err);
  });

  it.each([
    ["gbp", "GBP"],
    ["", "GBP"],
    ["eur", "EUR"],
  ])("currency %j -> %s", (cur, want) => {
    expect(parseBankCsv(`Date,Description,Amount,Currency\n01/07/2026,X,1.00,${cur}`).lines[0]!.currency).toBe(want);
  });
  it.each(["POUNDS", "£", "12", "G B P"])("bad currency %j rejected", (cur) => {
    expect(parseBankCsv(`Date,Description,Amount,Currency\n01/07/2026,X,1.00,${cur}`).rejected[0]!.error).toMatch(/bad currency/);
  });

  it("enforces the row limit", () => {
    const body = Array.from({ length: 11 }, (_, i) => `01/07/2026,X${i},1.00`).join("\n");
    expect(() => parseBankCsv(`Date,Description,Amount\n${body}`, 10)).toThrow(/more than 10 rows/);
    expect(parseBankCsv(`Date,Description,Amount\n${body}`, 11).lines).toHaveLength(11);
  });
  it("truncates descriptions to 300 chars", () =>
    expect(parseBankCsv(`Date,Description,Amount\n01/07/2026,${"A".repeat(500)},1`).lines[0]!.description).toHaveLength(300));
  it("keeps formula-like descriptions as inert data (escaping happens on export)", () =>
    expect(parseBankCsv(`Date,Description,Amount\n01/07/2026,=HYPERLINK("x"),1`).lines[0]!.description).toBe("=HYPERLINK(x)"));
  it("paid in minus paid out when both present", () =>
    expect(parseBankCsv("Date,Description,Paid out,Paid in\n01/07/2026,X,5.00,7.00").lines[0]!.amountPence).toBe(200));
  it("never loses a row: lines + rejected == data rows", () =>
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.oneof(fc.constant("01/07/2026"), fc.string()), fc.string(), fc.oneof(fc.constant("1.00"), fc.string())), {
          minLength: 1,
          maxLength: 30,
        }),
        (rows) => {
          const safe = (s: string) => `"${s.replace(/"/g, '""')}"`;
          const text = "Date,Description,Amount\n" + rows.map((r) => `${safe(r[0])},${safe(r[1].trim() || "x")},${safe(r[2])}`).join("\n");
          const nonBlank = rows.length; // every row has a non-blank description
          const r = parseBankCsv(text);
          expect(r.lines.length + r.rejected.length).toBe(nonBlank);
        },
      ),
    ));
});

describe("sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("%j", async (s, h) => expect(await sha256Hex(s)).toBe(h));
  it("same bytes as string or Uint8Array", async () => expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(await sha256Hex("abc")));
});
