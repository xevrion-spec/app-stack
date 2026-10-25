/**
 * Tax-pot / set-aside estimate for a sole trader: income tax on trading profit (after personal allowance and its taper) plus
 * Class 4 NIC, payments on account, and a suggested % of each receipt to set aside. Config-driven and UNVERIFIED.
 */
import { roundHalfAway } from "@xevrion/pipeline";
import { UK_RATES, UNVERIFIED_NOTICE, type UkRates } from "./rates.js";

export interface TaxEstimate {
  profitPence: number;
  usedTradingAllowance: boolean;
  taxableProfitPence: number;
  personalAllowancePence: number;
  incomeTaxPence: number;
  class4Pence: number;
  totalPence: number;
  effectiveRate: number;
  paymentsOnAccountPence: number; // each of two instalments for next year, 0 if under threshold
  setAsidePercent: number; // suggested share of each pound of income to put aside
  bands: { name: string; pence: number; rate: number; taxPence: number }[];
  verified: false;
  notice: string;
}

export function estimateTax(
  p: { turnoverPence: number; expensesPence: number; otherIncomePence?: number; useTradingAllowance?: boolean },
  r: UkRates = UK_RATES,
): TaxEstimate {
  if (p.turnoverPence < 0 || p.expensesPence < 0) throw new RangeError("turnover and expenses must be non-negative");
  const other = p.otherIncomePence ?? 0;
  const viaExpenses = p.turnoverPence - p.expensesPence;
  const viaAllowance = Math.max(0, p.turnoverPence - r.trading_allowance_pence);
  const useTA = p.useTradingAllowance ?? viaAllowance < viaExpenses;
  const profit = Math.max(0, useTA ? viaAllowance : viaExpenses);
  const total = profit + other;
  const taper = r.personal_allowance_taper;
  const pa = Math.max(0, r.personal_allowance_pence - Math.max(0, Math.floor((total - taper.threshold_pence) * taper.reduce_by_per_pound)));
  let remaining = Math.max(0, total - pa);
  let prev = 0;
  const bands: TaxEstimate["bands"] = [];
  let it = 0;
  for (const b of r.income_tax_bands) {
    const width = b.upto_pence === null ? Infinity : b.upto_pence - prev;
    const inBand = Math.min(remaining, width);
    if (inBand > 0) {
      const t = roundHalfAway(inBand * b.rate);
      bands.push({ name: b.name, pence: inBand, rate: b.rate, taxPence: t });
      it += t;
    }
    remaining -= inBand;
    prev = b.upto_pence ?? prev;
    if (remaining <= 0) break;
  }
  // Attribute income tax to trading profit pro rata when there is other income.
  const tradingShare = total ? profit / total : 0;
  const itTrading = roundHalfAway(it * tradingShare);
  const c = r.class4_nic;
  const c4 = roundHalfAway(Math.max(0, Math.min(profit, c.upper_pence) - c.lower_pence) * c.main_rate + Math.max(0, profit - c.upper_pence) * c.upper_rate);
  const tot = itTrading + c4;
  const poa = tot > r.payments_on_account.threshold_pence ? roundHalfAway(tot * r.payments_on_account.fraction) : 0;
  return {
    profitPence: profit,
    usedTradingAllowance: useTA,
    taxableProfitPence: Math.max(0, total - pa),
    personalAllowancePence: pa,
    incomeTaxPence: itTrading,
    class4Pence: c4,
    totalPence: tot,
    effectiveRate: profit ? Math.round((tot / profit) * 1000) / 1000 : 0,
    paymentsOnAccountPence: poa,
    setAsidePercent: p.turnoverPence ? Math.ceil((tot / p.turnoverPence) * 100) : 0,
    bands,
    verified: false,
    notice: UNVERIFIED_NOTICE,
  };
}
