/**
 * Practice integrations (ADR 0027): provider INTERFACES, field MAPPERS and MOCK adapters only. Nothing here makes a
 * network call. Raw shapes follow the providers' public API documentation as understood on 2026-10-25 and are
 * UNVERIFIED against live tenants. A real adapter must pass the same contract tests (test/integrations.contract.test.ts).
 */
import { merchantKey } from "./text.js";

// ---------------- ledger read adapters (Xero / QuickBooks Online / FreeAgent) ----------------
export type LedgerProvider = "xero" | "quickbooks" | "freeagent";
export interface ExtAccount {
  code: string;
  name: string;
  type: "income" | "expense" | "asset" | "liability" | "equity" | "bank" | "other";
}
export interface ExtTransaction {
  externalId: string;
  date: string;
  description: string;
  amountPence: number;
  accountCode: string | null;
  vatRateCode: string | null;
  contact: string | null;
}
export interface LedgerReadAdapter {
  readonly provider: LedgerProvider;
  readonly mode: "mock" | "live";
  accounts(): Promise<ExtAccount[]>;
  transactions(since: string, until: string): Promise<ExtTransaction[]>;
}
const pence = (v: number | string) => {
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n) || Math.abs(n) > 1e11) throw new RangeError(`invalid amount: ${v}`);
  return Math.round(n * 100);
};
const isoDate = (v: string) => {
  const ms = v.match(/^\/Date\((\d+)([+-]\d{4})?\)\/$/);
  const d = ms ? new Date(Number(ms[1])) : new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid date: ${v}`);
  return d.toISOString().slice(0, 10);
};

/** Xero BankTransaction (Accounting API). SPEND is money out, RECEIVE is money in; Total is gross. */
export interface XeroBankTransaction {
  BankTransactionID: string;
  Type: "SPEND" | "RECEIVE" | "SPEND-TRANSFER" | "RECEIVE-TRANSFER";
  Date: string;
  Contact?: { Name?: string };
  Reference?: string;
  Total: number;
  LineItems: { Description?: string; LineAmount?: number; AccountCode?: string; TaxType?: string }[];
}
const XERO_TAX: Record<string, string> = {
  INPUT2: "STD",
  OUTPUT2: "STD",
  RRINPUT: "RED",
  RROUTPUT: "RED",
  ZERORATEDINPUT: "ZERO",
  ZERORATEDOUTPUT: "ZERO",
  EXEMPTINPUT: "EXEMPT",
  EXEMPTOUTPUT: "EXEMPT",
  NONE: "OUT",
};
export function mapXero(t: XeroBankTransaction): ExtTransaction {
  const out = t.Type.startsWith("SPEND");
  const line = t.LineItems[0] ?? {};
  const total = pence(t.Total);
  return {
    externalId: `xero:${t.BankTransactionID}`,
    date: isoDate(t.Date),
    description: (line.Description ?? t.Reference ?? t.Contact?.Name ?? "(no description)").trim(),
    amountPence: out ? -Math.abs(total) : Math.abs(total),
    accountCode: line.AccountCode ?? null,
    vatRateCode: line.TaxType ? (XERO_TAX[line.TaxType] ?? null) : null,
    contact: t.Contact?.Name ?? null,
  };
}
/** QuickBooks Online Purchase / Deposit entities (simplified). */
export interface QboTxn {
  Id: string;
  entity: "Purchase" | "Deposit";
  TxnDate: string;
  TotalAmt: number;
  PrivateNote?: string;
  EntityRef?: { name?: string };
  Line: {
    Amount: number;
    Description?: string;
    AccountBasedExpenseLineDetail?: { AccountRef: { value: string; name?: string }; TaxCodeRef?: { value: string } };
    DepositLineDetail?: { AccountRef: { value: string } };
  }[];
}
const QBO_TAX: Record<string, string> = { "20.0% S": "STD", "5.0% R": "RED", "0.0% Z": "ZERO", Exempt: "EXEMPT", "No VAT": "OUT" };
export function mapQbo(t: QboTxn): ExtTransaction {
  const line = t.Line[0];
  const detail = line?.AccountBasedExpenseLineDetail ?? line?.DepositLineDetail;
  const tax = line?.AccountBasedExpenseLineDetail?.TaxCodeRef?.value;
  const total = Math.abs(pence(t.TotalAmt));
  return {
    externalId: `qbo:${t.entity}:${t.Id}`,
    date: isoDate(t.TxnDate),
    description: (line?.Description ?? t.PrivateNote ?? t.EntityRef?.name ?? "(no description)").trim(),
    amountPence: t.entity === "Purchase" ? -total : total,
    accountCode: detail?.AccountRef.value ?? null,
    vatRateCode: tax ? (QBO_TAX[tax] ?? null) : null,
    contact: t.EntityRef?.name ?? null,
  };
}
/** FreeAgent bank transaction explanation. gross_value is signed; category is a URL ending in the category id. */
export interface FreeAgentExplanation {
  url: string;
  dated_on: string;
  description?: string;
  gross_value: string;
  category?: string;
  sales_tax_rate?: string;
}
export function mapFreeAgent(t: FreeAgentExplanation): ExtTransaction {
  const rate = t.sales_tax_rate == null ? null : Number(t.sales_tax_rate);
  return {
    externalId: `freeagent:${t.url.split("/").pop()}`,
    date: isoDate(t.dated_on),
    description: (t.description ?? "(no description)").trim(),
    amountPence: pence(t.gross_value),
    accountCode: t.category ? (t.category.split("/").pop() ?? null) : null,
    vatRateCode: rate == null ? null : rate === 20 ? "STD" : rate === 5 ? "RED" : rate === 0 ? "ZERO" : null,
    contact: null,
  };
}

/** Maps an external account NAME to Autopilot's default chart by keyword. Unknown → 9999 with a reason (never guessed). */
const CHART_HINTS: [RegExp, string][] = [
  [/\b(sales|revenue|income|fees received)\b/i, "4000"],
  [/\b(cost of (sales|goods)|purchases|stock|materials)\b/i, "5000"],
  [/\b(travel|mileage|fuel|motor|vehicle)\b/i, "6400"],
  [/\b(office|stationery|postage|printing)\b/i, "6200"],
  [/\b(software|subscriptions?|computer|it)\b/i, "6300"],
  [/\b(phone|telephone|internet|mobile)\b/i, "6500"],
  [/\b(bank (charges|fees)|interest paid)\b/i, "6600"],
  [/\b(advertising|marketing)\b/i, "6100"],
  [/\b(professional|accountancy|legal)\b/i, "6700"],
];
export function mapAccountName(name: string): { code: string; reason: string } {
  for (const [re, code] of CHART_HINTS) if (re.test(name)) return { code, reason: `account name "${name}" matched ${re.source}` };
  return { code: "9999", reason: `no confident mapping for "${name}"; needs review` };
}

abstract class FixtureAdapter<R> implements LedgerReadAdapter {
  abstract readonly provider: LedgerProvider;
  readonly mode = "mock" as const;
  constructor(
    protected readonly raw: R[],
    private readonly chart: ExtAccount[],
  ) {}
  protected abstract map(r: R): ExtTransaction;
  async accounts() {
    return [...this.chart];
  }
  async transactions(since: string, until: string) {
    if (since > until) throw new RangeError("since must be <= until");
    return this.raw
      .map((r) => this.map(r))
      .filter((t) => t.date >= since && t.date <= until)
      .sort((a, b) => a.date.localeCompare(b.date) || a.externalId.localeCompare(b.externalId));
  }
}
const SYNTH_CHART: ExtAccount[] = [
  { code: "200", name: "Sales", type: "income" },
  { code: "429", name: "General Expenses", type: "expense" },
  { code: "449", name: "Motor Vehicle Expenses", type: "expense" },
  { code: "463", name: "IT Software and Consumables", type: "expense" },
  { code: "090", name: "Business Bank Account", type: "bank" },
];
export class MockXeroAdapter extends FixtureAdapter<XeroBankTransaction> {
  readonly provider = "xero" as const;
  constructor(raw: XeroBankTransaction[] = XERO_FIXTURE) {
    super(raw, SYNTH_CHART);
  }
  protected map = mapXero;
}
export class MockQuickBooksAdapter extends FixtureAdapter<QboTxn> {
  readonly provider = "quickbooks" as const;
  constructor(raw: QboTxn[] = QBO_FIXTURE) {
    super(raw, SYNTH_CHART);
  }
  protected map = mapQbo;
}
export class MockFreeAgentAdapter extends FixtureAdapter<FreeAgentExplanation> {
  readonly provider = "freeagent" as const;
  constructor(raw: FreeAgentExplanation[] = FREEAGENT_FIXTURE) {
    super(raw, SYNTH_CHART);
  }
  protected map = mapFreeAgent;
}
export const XERO_FIXTURE: XeroBankTransaction[] = [
  {
    BankTransactionID: "x-001",
    Type: "RECEIVE",
    Date: "/Date(1782950400000+0000)/",
    Contact: { Name: "Synthetic Customer Ltd" },
    Total: 1200,
    LineItems: [{ Description: "Invoice INV-001 (synthetic)", AccountCode: "200", TaxType: "OUTPUT2" }],
  },
  {
    BankTransactionID: "x-002",
    Type: "SPEND",
    Date: "2026-07-03T00:00:00",
    Contact: { Name: "Synthetic Fuel Co" },
    Total: 62.1,
    LineItems: [{ Description: "SYNTHETIC FUEL A40", AccountCode: "449", TaxType: "INPUT2" }],
  },
  {
    BankTransactionID: "x-003",
    Type: "SPEND",
    Date: "2026-07-09",
    Total: 19.99,
    LineItems: [{ AccountCode: "463", TaxType: "INPUT2" }],
    Reference: "SYNTHETIC SOFTWARE SUB",
  },
];
export const QBO_FIXTURE: QboTxn[] = [
  {
    Id: "101",
    entity: "Deposit",
    TxnDate: "2026-07-01",
    TotalAmt: 850,
    Line: [{ Amount: 850, Description: "SYNTHETIC CLIENT PAYMENT", DepositLineDetail: { AccountRef: { value: "1" } } }],
  },
  {
    Id: "102",
    entity: "Purchase",
    TxnDate: "2026-07-04",
    TotalAmt: 45.6,
    EntityRef: { name: "Synthetic Rail" },
    Line: [
      {
        Amount: 45.6,
        Description: "SYNTHETIC TRAIN TICKET",
        AccountBasedExpenseLineDetail: { AccountRef: { value: "58", name: "Travel" }, TaxCodeRef: { value: "0.0% Z" } },
      },
    ],
  },
];
export const FREEAGENT_FIXTURE: FreeAgentExplanation[] = [
  {
    url: "https://api.freeagent.com/v2/bank_transaction_explanations/9001",
    dated_on: "2026-07-02",
    description: "SYNTHETIC OFFICE SUPPLIES",
    gross_value: "-23.99",
    category: "https://api.freeagent.com/v2/categories/285",
    sales_tax_rate: "20.0",
  },
  {
    url: "https://api.freeagent.com/v2/bank_transaction_explanations/9002",
    dated_on: "2026-07-10",
    description: "SYNTHETIC SALES RECEIPT",
    gross_value: "300.00",
    category: "https://api.freeagent.com/v2/categories/001",
  },
];
export const ledgerAdapterFor = (p: LedgerProvider): LedgerReadAdapter =>
  p === "xero" ? new MockXeroAdapter() : p === "quickbooks" ? new MockQuickBooksAdapter() : new MockFreeAgentAdapter();

// ---------------- practice management + e-sign ----------------
export interface PmJob {
  externalId: string;
  clientRef: string;
  title: string;
  dueDate: string;
  status: "open" | "done";
}
export interface PracticeManagementAdapter {
  readonly name: string;
  upsertJob(j: Omit<PmJob, "externalId"> & { idempotencyKey: string }): Promise<PmJob>;
  listJobs(clientRef: string): Promise<PmJob[]>;
}
export class MockPracticeManagement implements PracticeManagementAdapter {
  readonly name = "mock-pm";
  private jobs = new Map<string, PmJob>();
  async upsertJob(j: Omit<PmJob, "externalId"> & { idempotencyKey: string }) {
    if (!j.title.trim()) throw new RangeError("title required");
    const existing = this.jobs.get(j.idempotencyKey);
    const job: PmJob = {
      externalId: existing?.externalId ?? `pm-${this.jobs.size + 1}`,
      clientRef: j.clientRef,
      title: j.title,
      dueDate: j.dueDate,
      status: j.status,
    };
    this.jobs.set(j.idempotencyKey, job);
    return job;
  }
  async listJobs(clientRef: string) {
    return [...this.jobs.values()].filter((j) => j.clientRef === clientRef).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }
}
export interface ESignEnvelope {
  envelopeId: string;
  documentSha256: string;
  signers: string[];
  status: "sent" | "completed" | "declined" | "voided";
}
export interface ESignAdapter {
  readonly name: string;
  createEnvelope(documentSha256: string, signers: string[]): Promise<ESignEnvelope>;
  status(envelopeId: string): Promise<ESignEnvelope>;
  void(envelopeId: string): Promise<ESignEnvelope>;
}
export class MockESign implements ESignAdapter {
  readonly name = "mock-esign";
  private envs = new Map<string, ESignEnvelope>();
  async createEnvelope(documentSha256: string, signers: string[]) {
    if (!/^[a-f0-9]{64}$/.test(documentSha256)) throw new RangeError("documentSha256 must be a sha256 hex digest");
    if (!signers.length || signers.some((s) => !/^[^@\s]+@[^@\s]+$/.test(s))) throw new RangeError("signers must be emails");
    const e: ESignEnvelope = {
      envelopeId: `env-${this.envs.size + 1}`,
      documentSha256,
      signers: [...new Set(signers.map((s) => s.toLowerCase()))],
      status: "sent",
    };
    this.envs.set(e.envelopeId, e);
    return { ...e };
  }
  async status(id: string) {
    const e = this.envs.get(id);
    if (!e) throw new RangeError("unknown envelope");
    return { ...e };
  }
  async void(id: string) {
    const e = await this.status(id);
    if (e.status === "completed") throw new RangeError("completed envelopes cannot be voided");
    this.envs.set(id, { ...e, status: "voided" });
    return { ...e, status: "voided" as const };
  }
  /** Test hook standing in for the provider's completion webhook. */
  complete(id: string) {
    const e = this.envs.get(id);
    if (e && e.status === "sent") this.envs.set(id, { ...e, status: "completed" });
  }
}

// ---------------- MTD VAT submission (mock HMRC) ----------------
export interface VatReturn {
  periodKey: string;
  vatDueSales: number;
  vatDueAcquisitions: number;
  totalVatDue: number;
  vatReclaimedCurrPeriod: number;
  netVatDue: number;
  totalValueSalesExVAT: number;
  totalValuePurchasesExVAT: number;
  totalValueGoodsSuppliedExVAT: number;
  totalAcquisitionsExVAT: number;
  finalised: boolean;
}
/** Box arithmetic checks HMRC applies (boxes 1-5 pence-precise; 6-9 whole pounds). Returns every problem found. */
export function validateVatReturn(r: VatReturn): string[] {
  const errs: string[] = [];
  if (!/^[A-Z0-9#]{4}$/.test(r.periodKey)) errs.push("periodKey must be 4 characters");
  const money = ["vatDueSales", "vatDueAcquisitions", "totalVatDue", "vatReclaimedCurrPeriod", "netVatDue"] as const;
  for (const k of money) if (!Number.isFinite(r[k]) || Math.round(r[k] * 100) !== r[k] * 100) errs.push(`${k} must have at most 2 decimals`);
  for (const k of ["totalValueSalesExVAT", "totalValuePurchasesExVAT", "totalValueGoodsSuppliedExVAT", "totalAcquisitionsExVAT"] as const)
    if (!Number.isInteger(r[k])) errs.push(`${k} must be whole pounds`);
  const c = (x: number) => Math.round(x * 100);
  if (c(r.totalVatDue) !== c(r.vatDueSales) + c(r.vatDueAcquisitions)) errs.push("box 3 must equal box 1 + box 2");
  if (c(r.netVatDue) !== Math.abs(c(r.totalVatDue) - c(r.vatReclaimedCurrPeriod))) errs.push("box 5 must equal |box 3 - box 4|");
  if (r.netVatDue < 0) errs.push("box 5 cannot be negative");
  if (!r.finalised) errs.push("the return must be finalised (legal declaration) before submission");
  return errs;
}
export interface VatSubmissionReceipt {
  processingDate: string;
  formBundleNumber: string;
  chargeRefNumber: string | null;
  sandbox: true;
}
export interface VatSubmissionAdapter {
  readonly name: string;
  readonly mode: "mock" | "sandbox" | "live";
  submit(vrn: string, r: VatReturn, fraudHeaders: Record<string, string>): Promise<VatSubmissionReceipt>;
}
/** HMRC sandbox settings for when Henry registers an app. Config only: not used by the mock, no credentials here. */
export const HMRC_SANDBOX_CONFIG = {
  baseUrl: "https://test-api.service.hmrc.gov.uk",
  authorizeUrl: "https://test-www.tax.service.gov.uk/oauth/authorize",
  tokenUrl: "https://test-api.service.hmrc.gov.uk/oauth/token",
  scopes: ["read:vat", "write:vat"],
  vatReturnPath: (vrn: string) => `/organisations/vat/${vrn}/returns`,
  fraudPreventionHeadersRequired: true,
  verified: false,
} as const;
const REQUIRED_FPH = ["Gov-Client-Connection-Method", "Gov-Client-Timezone", "Gov-Client-User-IDs", "Gov-Vendor-Version", "Gov-Vendor-Product-Name"];
/** Builds the WEB_APP_VIA_SERVER fraud-prevention header set (shape per HMRC guidance; UNVERIFIED). */
export function buildFraudPreventionHeaders(ctx: { userId: string; timezone: string; publicIp?: string; vendorVersion: string }): Record<string, string> {
  return {
    "Gov-Client-Connection-Method": "WEB_APP_VIA_SERVER",
    "Gov-Client-Timezone": ctx.timezone,
    "Gov-Client-User-IDs": `autopilot=${encodeURIComponent(ctx.userId)}`,
    ...(ctx.publicIp ? { "Gov-Client-Public-IP": ctx.publicIp } : {}),
    "Gov-Vendor-Version": `autopilot=${encodeURIComponent(ctx.vendorVersion)}`,
    "Gov-Vendor-Product-Name": "Autopilot",
  };
}
export class MockHmrcVatAdapter implements VatSubmissionAdapter {
  readonly name = "mock-hmrc-vat";
  readonly mode = "mock" as const;
  private seen = new Set<string>();
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async submit(vrn: string, r: VatReturn, fph: Record<string, string>) {
    if (!/^\d{9}$/.test(vrn)) throw new RangeError("VRN must be 9 digits");
    const missing = REQUIRED_FPH.filter((h) => !fph[h]);
    if (missing.length) throw new RangeError(`missing fraud prevention headers: ${missing.join(", ")}`);
    const errs = validateVatReturn(r);
    if (errs.length) throw new RangeError(errs.join("; "));
    const key = `${vrn}:${r.periodKey}`;
    if (this.seen.has(key)) throw new RangeError("DUPLICATE_SUBMISSION");
    this.seen.add(key);
    return {
      processingDate: this.clock().toISOString(),
      formBundleNumber: `MOCK${String(this.seen.size).padStart(8, "0")}`,
      chargeRefNumber: r.netVatDue > 0 ? `MOCKCHG${this.seen.size}` : null,
      sandbox: true as const,
    };
  }
}

// ---------------- Open Banking (AISP) ----------------
export interface ObConsent {
  consentId: string;
  institutionId: string;
  status: "awaiting_authorisation" | "authorised" | "revoked" | "expired";
  expiresAt: string;
  redirectUrl: string;
}
export interface OpenBankingProvider {
  readonly name: string;
  readonly mode: "mock" | "live";
  createConsent(institutionId: string, redirectUri: string): Promise<ObConsent>;
  completeConsent(consentId: string, code: string): Promise<ObConsent>;
  accounts(consentId: string): Promise<{ accountId: string; name: string; currency: string }[]>;
  transactions(
    consentId: string,
    accountId: string,
    since: string,
    until: string,
  ): Promise<{ id: string; date: string; description: string; amountPence: number }[]>;
  revoke(consentId: string): Promise<ObConsent>;
}
/** Mock AISP: 90-day consent, explicit authorise step, revocation; deterministic synthetic transactions. */
export class MockOpenBanking implements OpenBankingProvider {
  readonly name = "mock-aisp";
  readonly mode = "mock" as const;
  private consents = new Map<string, ObConsent>();
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async createConsent(institutionId: string, redirectUri: string) {
    if (!/^https:\/\//.test(redirectUri)) throw new RangeError("redirectUri must be https");
    const id = `cons-${this.consents.size + 1}`;
    const c: ObConsent = {
      consentId: id,
      institutionId,
      status: "awaiting_authorisation",
      expiresAt: new Date(this.clock().getTime() + 90 * 86_400_000).toISOString(),
      redirectUrl: `https://mock-bank.invalid/authorise?consent=${id}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    };
    this.consents.set(id, c);
    return { ...c };
  }
  private live(id: string) {
    const c = this.consents.get(id);
    if (!c) throw new RangeError("unknown consent");
    if (c.status === "authorised" && c.expiresAt <= this.clock().toISOString()) this.consents.set(id, { ...c, status: "expired" });
    return this.consents.get(id)!;
  }
  async completeConsent(id: string, code: string) {
    const c = this.live(id);
    if (c.status !== "awaiting_authorisation") throw new RangeError(`consent is ${c.status}`);
    if (code !== "mock-ok") throw new RangeError("authorisation failed");
    const n = { ...c, status: "authorised" as const };
    this.consents.set(id, n);
    return { ...n };
  }
  private authorised(id: string) {
    const c = this.live(id);
    if (c.status !== "authorised") throw new RangeError(`consent is ${c.status}`);
    return c;
  }
  async accounts(id: string) {
    this.authorised(id);
    return [{ accountId: "acc-1", name: "Synthetic Current Account", currency: "GBP" }];
  }
  async transactions(id: string, accountId: string, since: string, until: string) {
    this.authorised(id);
    if (accountId !== "acc-1") throw new RangeError("unknown account");
    const out = [];
    for (let d = since, i = 0; d <= until && out.length < 1000; d = new Date(Date.parse(d) + 2 * 86_400_000).toISOString().slice(0, 10), i++)
      out.push({ id: `ob-${d}`, date: d, description: ["SYNTHETIC CARD SPEND", "SYNTHETIC CUSTOMER"][i % 2]!, amountPence: i % 2 ? 25_000 : -1_250 });
    return out;
  }
  async revoke(id: string) {
    const c = this.live(id);
    const n = { ...c, status: "revoked" as const };
    this.consents.set(id, n);
    return { ...n };
  }
}

/** Integration catalogue: what exists and how real it is (shown in the API and the console; keep honest). */
export const INTEGRATION_CATALOG = [
  { id: "xero", kind: "ledger_read", status: "mock", note: "Mapper + mock adapter; needs a Xero app (OAuth2) to go live" },
  { id: "quickbooks", kind: "ledger_read", status: "mock", note: "Mapper + mock adapter; needs an Intuit developer app" },
  { id: "freeagent", kind: "ledger_read", status: "mock", note: "Mapper + mock adapter; FreeAgent CSV import is real" },
  { id: "csv_imports", kind: "file_import", status: "real", note: "Bank CSV/OFX/QIF/MT940 and Xero/QuickBooks/FreeAgent/FreshBooks CSV exports" },
  { id: "practice_management", kind: "pm", status: "interface", note: "Karbon/XPM-style job sync interface + mock" },
  { id: "esign", kind: "esign", status: "interface", note: "Envelope interface + mock; engagement acceptance in-portal is real" },
  { id: "hmrc_mtd_vat", kind: "submission", status: "mock", note: "Box validation + fraud headers real; HMRC not called; needs HMRC recognition" },
  { id: "open_banking", kind: "aisp", status: "mock", note: "Consent lifecycle mock; needs an FCA-authorised AISP partner" },
] as const;
export const normaliseForDedupe = (t: ExtTransaction) => `${t.date}|${t.amountPence}|${merchantKey(t.description)}`;
