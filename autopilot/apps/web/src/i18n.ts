/**
 * Minimal i18n scaffold: typed message keys, en-GB as the source locale, a pseudo-locale ("en-XA") to catch
 * hard-coded strings, and locale-aware money/date formatting. Add a locale by adding a dictionary with the same keys.
 */
const enGB = {
  "nav.review": "Review queue",
  "nav.transactions": "Transactions",
  "nav.upload": "Upload",
  "nav.invoices": "Invoices",
  "nav.receivables": "Receivables",
  "nav.reports": "Reports",
  "nav.vat": "VAT & SA",
  "nav.assistant": "Ask",
  "nav.team": "Team & close",
  "nav.banking": "Bank feeds",
  "nav.privacy": "Privacy",
  "nav.ops": "Ops",
  "nav.practice": "Practice",
  "nav.start": "Get started",
  "nav.jobs": "Jobs",
  "nav.settings": "Settings",
  "palette.open": "Command palette",
  "palette.placeholder": "Type a command or page…",
  "palette.empty": "No matches",
  "theme.label": "Theme",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "common.loading": "Loading…",
  "common.unverified": "Unverified placeholder rules; not tax advice.",
  footer: "Xevrion Autopilot · drafts only, nothing is submitted to HMRC",
} as const;
export type MessageKey = keyof typeof enGB;
type Dict = Record<MessageKey, string>;
const pseudo = Object.fromEntries(Object.entries(enGB).map(([k, v]) => [k, `[${v.replace(/[aeiou]/g, (c) => c + c)}]`])) as Dict;
const DICTS: Record<string, Dict> = { "en-GB": enGB, "en-XA": pseudo };
export const LOCALES = Object.keys(DICTS);

let current = "en-GB";
export function setLocale(l: string) {
  current = DICTS[l] ? l : "en-GB";
  if (typeof document !== "undefined") document.documentElement.lang = current === "en-XA" ? "en" : current;
}
export const locale = () => current;
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const s = DICTS[current]![key] ?? enGB[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? `{${v}}`));
}
export const formatDate = (iso: string) => new Intl.DateTimeFormat(current === "en-XA" ? "en-GB" : current, { dateStyle: "medium" }).format(new Date(iso));
