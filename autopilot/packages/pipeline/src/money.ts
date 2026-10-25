/** Money is always integer minor units (pence). Never use floats for stored amounts. */
export type Pence = number;

export function assertPence(n: number, label = "amount"): asserts n is Pence {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} must be an integer number of pence, got ${n}`);
}

/** Parse "1,234.56", "-12.3", "(45.00)", "£9.99" into pence. Throws on garbage. */
export function parseAmountToPence(raw: string): Pence {
  const s = raw.trim().replace(/[£$€,\s]/g, "");
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const body = s.replace(/[()\-+]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(body)) throw new RangeError(`unparseable amount: ${raw}`);
  const [whole = "0", frac = ""] = body.split(".");
  const p = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -p : p;
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
