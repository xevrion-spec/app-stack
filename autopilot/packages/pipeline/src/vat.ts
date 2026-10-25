import vatData from "../../domain-uk-tax/vat.json" with { type: "json" };
import { roundHalfAway, vatFromGross, type Pence } from "./money.js";

/**
 * DRAFT VAT computation. Rates come from packages/domain-uk-tax/vat.json, which is marked UNVERIFIED.
 * Output is always flagged draft/unverified. Never submit to HMRC from this code.
 */
export type VatScheme = "standard" | "cash" | "flat_rate";
export interface VatRate {
  code: string;
  rate: number | null;
}

export const VAT_RATES: Record<string, number | null> = Object.fromEntries(vatData.rate_codes.map((r) => [r.code, r.rate_placeholder]));

export interface VatInputLine {
  id: string;
  date: string;
  grossPence: Pence; // +sales / -purchases (bank sign)
  kind: "income" | "expense" | "transfer" | "suspense" | "capital";
  vatRateCode: string | null; // STD/RED/ZERO/EXEMPT/OUTSIDE
  evidencedVatPence?: Pence | null; // VAT shown on receipt/invoice, preferred for purchases
}

export interface VatReturnDraft {
  scheme: VatScheme;
  periodStart: string;
  periodEnd: string;
  box1: Pence;
  box2: Pence;
  box3: Pence;
  box4: Pence;
  box5: Pence;
  box6: Pence;
  box7: Pence;
  box8: Pence;
  box9: Pence;
  status: "draft";
  ratesVerified: false;
  warnings: string[];
}

const pounds = (p: Pence) => Math.trunc(p / 100) * 100; // boxes 6-9 are whole pounds (verify)

// eslint-disable-next-line complexity -- known debt (docs/quality.md): split in a follow-up
export function computeVatReturn(
  lines: VatInputLine[],
  opts: { scheme: VatScheme; periodStart: string; periodEnd: string; flatRatePercent?: number | null },
): VatReturnDraft {
  const warnings: string[] = ["Draft only: VAT rates/rules are UNVERIFIED placeholders. Not for submission."];
  const inPeriod = lines.filter((l) => l.date >= opts.periodStart && l.date <= opts.periodEnd);
  let box1 = 0,
    box4 = 0,
    box6 = 0,
    box7 = 0;
  const rateOf = (code: string | null) => (code ? (VAT_RATES[code] ?? null) : null);
  if (opts.scheme === "cash") warnings.push("Cash scheme: bank-dated lines used as payment dates.");
  if (opts.scheme === "flat_rate") {
    const pct = opts.flatRatePercent;
    if (pct == null || pct <= 0 || pct >= 100) throw new RangeError("flat_rate scheme requires flatRatePercent in (0,100)");
    warnings.push(`Flat rate ${pct}% (UNVERIFIED for this trade sector).`);
    const turnoverGross = inPeriod
      .filter((l) => l.kind === "income" && l.grossPence > 0 && l.vatRateCode !== "OUTSIDE" && l.vatRateCode !== "EXEMPT")
      .reduce((a, l) => a + l.grossPence, 0);
    box1 = roundHalfAway((turnoverGross * pct) / 100);
    box6 = turnoverGross;
    for (const l of inPeriod) {
      if (l.kind === "expense" && l.grossPence < 0) box7 += -l.grossPence;
      if (l.kind === "capital" && l.grossPence < 0) warnings.push(`Capital purchase ${l.id}: may be reclaimable under flat rate if over threshold (verify).`);
    }
  } else {
    for (const l of inPeriod) {
      const rate = rateOf(l.vatRateCode);
      if (l.kind === "income") {
        const vat = rate == null ? 0 : vatFromGross(l.grossPence, rate);
        box1 += vat;
        box6 += l.grossPence - vat;
      } else if (l.kind === "expense" || l.kind === "capital") {
        const gross = -l.grossPence;
        const vat = l.evidencedVatPence != null ? l.evidencedVatPence * Math.sign(gross || 1) : 0;
        if (l.evidencedVatPence == null && rate && rate > 0) warnings.push(`No VAT evidence for ${l.id}: input VAT not claimed.`);
        box4 += vat;
        box7 += gross - vat;
      }
    }
  }
  const box2 = 0,
    box8 = 0,
    box9 = 0;
  const box3 = box1 + box2;
  return {
    scheme: opts.scheme,
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    box1,
    box2,
    box3,
    box4,
    box5: box3 - box4,
    box6: pounds(box6),
    box7: pounds(box7),
    box8,
    box9,
    status: "draft",
    ratesVerified: false,
    warnings,
  };
}

/** Structural invariants that must always hold for any draft. */
export function vatInvariantsHold(r: VatReturnDraft): boolean {
  return r.box3 === r.box1 + r.box2 && r.box5 === r.box3 - r.box4 && [r.box6, r.box7, r.box8, r.box9].every((b) => b % 100 === 0);
}
