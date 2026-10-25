/** Money is always integer minor units (pence). Never use floats for stored amounts. */
export type Pence = number;

export function assertPence(n: number, label = "amount"): asserts n is Pence {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} must be an integer number of pence, got ${n}`);
}

/**
 * Parse UK bank amount renderings into pence: "1,234.56", "-12.3", "(45.00)", "£9.99", "+5", "12.00 CR", "12.00 DR", "12.00-".
 * Throws on anything ambiguous (misplaced thousands separators, stray signs, unbalanced brackets, > 2 decimals, unsafe size).
 */
export function parseAmountToPence(raw: string): Pence {
  let s = raw
    .trim()
    .replace(/\u2212/g, "-")
    .replace(/\s+/g, "");
  let neg = false;
  const suffix = s.match(/^(.*?)(CR|DR)$/i);
  if (suffix) {
    s = suffix[1]!;
    neg = suffix[2]!.toUpperCase() === "DR";
  } else if (/\d-$/.test(s)) {
    s = s.slice(0, -1);
    neg = true;
  }
  if (/^\(.*\)$/.test(s)) {
    s = s.slice(1, -1);
    neg = !neg;
  }
  const m = s.match(/^([+-])?[£$€]?([+-])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  if (!m || (m[1] && m[2])) throw new RangeError(`unparseable amount: ${raw}`);
  if ((m[1] ?? m[2]) === "-") neg = !neg;
  const whole = m[3]!.replace(/,/g, "");
  const p = Number(whole) * 100 + Number(((m[4] ?? "") + "00").slice(0, 2));
  if (!Number.isSafeInteger(p)) throw new RangeError(`amount too large: ${raw}`);
  return neg && p !== 0 ? -p : p;
}

/** Round half away from zero (HMRC VAT guidance allows rounding to nearest penny; verify per scheme). */
export function roundHalfAway(x: number): Pence {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** VAT contained in a VAT-inclusive gross amount at `rate` (e.g. 0.2). */
export function vatFromGross(gross: Pence, rate: number): Pence {
  if (rate <= 0) return 0;
  return roundHalfAway((gross * rate) / (1 + rate));
}

export function vatOnNet(net: Pence, rate: number): Pence {
  return rate <= 0 ? 0 : roundHalfAway(net * rate);
}

export const formatGBP = (p: Pence): string =>
  (p < 0 ? "-" : "") + "£" + (Math.abs(p) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
