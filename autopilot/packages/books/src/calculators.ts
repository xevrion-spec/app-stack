/**
 * Simplified-expenses calculators (mileage, home office flat rate vs actual proportion) and capital allowances (AIA estimate).
 * All figures come from config and are returned with `verified: false`.
 */
import { roundHalfAway } from "@xevrion/pipeline";
import { UK_RATES, UNVERIFIED_NOTICE, type UkRates } from "./rates.js";

export type Vehicle = "car_van" | "motorcycle" | "bicycle";
export interface Estimate<T> {
  value: T;
  verified: false;
  notice: string;
  workings: string[];
}
const est = <T>(value: T, workings: string[]): Estimate<T> => ({ value, verified: false, notice: UNVERIFIED_NOTICE, workings });

/** Mileage allowance for business miles in one tax year. `priorMiles` = business miles already claimed this year in the same vehicle type. */
export function mileageAllowance(miles: number, vehicle: Vehicle, priorMiles = 0, r: UkRates = UK_RATES): Estimate<number> {
  if (!Number.isFinite(miles) || miles < 0 || !Number.isFinite(priorMiles) || priorMiles < 0) throw new RangeError("miles must be non-negative");
  const m = r.mileage_allowance_ppm;
  if (vehicle === "car_van") {
    const firstLeft = Math.max(0, m.car_van.first_miles - priorMiles);
    const atFirst = Math.min(miles, firstLeft);
    const atAfter = miles - atFirst;
    const pence = roundHalfAway(atFirst * m.car_van.first_pence + atAfter * m.car_van.after_pence);
    return est(pence, [`${atFirst} mi × ${m.car_van.first_pence}p`, `${atAfter} mi × ${m.car_van.after_pence}p`]);
  }
  const ppm = vehicle === "motorcycle" ? m.motorcycle.pence : m.bicycle.pence;
  return est(roundHalfAway(miles * ppm), [`${miles} mi × ${ppm}p`]);
}

/** Home office: flat rate by hours worked at home per month vs a proportion of actual household costs. Returns both and the better. */
export function homeOffice(
  months: { hours: number }[],
  actual?: { annualCostsPence: number; businessRooms: number; totalRooms: number; businessUseFraction: number },
  r: UkRates = UK_RATES,
): Estimate<{ flatRatePence: number; actualPence: number | null; better: "flat_rate" | "actual" }> {
  let flat = 0;
  const w: string[] = [];
  for (const [i, mo] of months.entries()) {
    const band = r.home_office_flat_rate_monthly_pence.find((b) => mo.hours >= b.min_hours && (b.max_hours === null || mo.hours <= b.max_hours));
    flat += band?.pence ?? 0;
    w.push(`month ${i + 1}: ${mo.hours}h -> ${band ? band.pence : 0}p`);
  }
  let act: number | null = null;
  if (actual) {
    if (actual.totalRooms <= 0 || actual.businessRooms < 0 || actual.businessRooms > actual.totalRooms) throw new RangeError("invalid room counts");
    if (actual.businessUseFraction < 0 || actual.businessUseFraction > 1) throw new RangeError("businessUseFraction must be 0..1");
    act = roundHalfAway((actual.annualCostsPence * actual.businessRooms * actual.businessUseFraction) / actual.totalRooms);
    w.push(`actual: ${actual.annualCostsPence}p × ${actual.businessRooms}/${actual.totalRooms} rooms × ${actual.businessUseFraction} use = ${act}p`);
  }
  return est({ flatRatePence: flat, actualPence: act, better: act !== null && act > flat ? "actual" : "flat_rate" }, w);
}

/** Annual Investment Allowance estimate: qualifying spend up to the (pro-rated) limit; cars excluded. */
export function annualInvestmentAllowance(
  items: { costPence: number; isCar?: boolean; privateUseFraction?: number }[],
  periodMonths = 12,
  r: UkRates = UK_RATES,
): Estimate<{ claimPence: number; excessPence: number; excludedCarsPence: number }> {
  if (periodMonths <= 0 || periodMonths > 18) throw new RangeError("periodMonths must be 1..18");
  const limit = roundHalfAway((r.aia_limit_pence * periodMonths) / 12);
  let qualifying = 0,
    cars = 0;
  for (const it of items) {
    if (it.costPence < 0) throw new RangeError("costs must be non-negative");
    if (it.isCar) cars += it.costPence;
    else qualifying += roundHalfAway(it.costPence * (1 - (it.privateUseFraction ?? 0)));
  }
  const claim = Math.min(qualifying, limit);
  return est({ claimPence: claim, excessPence: qualifying - claim, excludedCarsPence: cars }, [
    `limit ${limit}p for ${periodMonths} months`,
    `qualifying ${qualifying}p`,
    `cars excluded ${cars}p (writing-down allowances instead)`,
  ]);
}
