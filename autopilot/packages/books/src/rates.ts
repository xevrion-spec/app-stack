/** Loads the config-driven UK rates. Every result derived from these carries `verified: false` until Henry signs them off. */
import raw from "../../domain-uk-tax/uk-rates.unverified.json" with { type: "json" };
export type UkRates = typeof raw;
export const UK_RATES: UkRates = raw;
export const UNVERIFIED_NOTICE = "Estimate using UNVERIFIED placeholder rates. Not tax advice; check gov.uk or an accountant.";
