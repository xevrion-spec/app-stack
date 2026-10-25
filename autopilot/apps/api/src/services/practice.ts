/** Practice defaults: plan quotas (metered per practice) and starter close-checklist templates. */
export type MeteredMetric = "assistant_questions" | "integration_syncs" | "portal_uploads" | "working_papers";
interface Quota {
  maxClients: number;
  maxStaff: number;
  aiReviewsPerMonth: number;
  monthly: Record<MeteredMetric, number>;
}
/** Plan limits are PLACEHOLDERS (no prices or paid plans exist); they protect the service, not revenue. */
const QUOTAS: Record<string, Quota> = {
  trial: {
    maxClients: 25,
    maxStaff: 5,
    aiReviewsPerMonth: 10_000,
    monthly: { assistant_questions: 500, integration_syncs: 100, portal_uploads: 500, working_papers: 200 },
  },
  practice: {
    maxClients: 500,
    maxStaff: 50,
    aiReviewsPerMonth: 500_000,
    monthly: { assistant_questions: 20_000, integration_syncs: 5_000, portal_uploads: 25_000, working_papers: 10_000 },
  },
  enterprise: {
    maxClients: 5_000,
    maxStaff: 500,
    aiReviewsPerMonth: 5_000_000,
    monthly: { assistant_questions: 200_000, integration_syncs: 50_000, portal_uploads: 250_000, working_papers: 100_000 },
  },
};
export const practiceQuota = (plan: string) => QUOTAS[plan] ?? QUOTAS.trial!;

export const DEFAULT_CLOSE_TEMPLATES: { name: string; kind: "month" | "quarter" | "year"; items: { title: string; required: boolean }[] }[] = [
  {
    name: "Month-end close",
    kind: "month",
    items: [
      { title: "All bank accounts imported to month end", required: true },
      { title: "Review queue cleared (no items awaiting review)", required: true },
      { title: "Missing receipts chased via document requests", required: false },
      { title: "Client queries answered or closed", required: true },
      { title: "Anomalies reviewed (duplicates, round sums, unusual VAT)", required: true },
    ],
  },
  {
    name: "VAT quarter close",
    kind: "quarter",
    items: [
      { title: "Month-end closes complete for the quarter", required: true },
      { title: "VAT draft computed and reviewed against the ledger", required: true },
      { title: "Reverse charge / partial exemption considered", required: false },
      { title: "Client approval of the VAT figures recorded", required: true },
      { title: "Working paper snapshot signed off", required: true },
    ],
  },
  {
    name: "Year-end close",
    kind: "year",
    items: [
      { title: "All quarters closed", required: true },
      { title: "Accruals, prepayments and capital items reviewed", required: true },
      { title: "Use-of-home / mileage / simplified expenses applied", required: false },
      { title: "Tax computation reviewed by a qualified adviser", required: true },
      { title: "Final working papers signed off by a partner or manager", required: true },
    ],
  },
];
