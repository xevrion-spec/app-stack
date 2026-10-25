/**
 * "Ask your books": deterministic question understanding (intent + period + filters) so every answer comes from the
 * ledger via a named tool and carries citations. An LLM can rephrase or route through the same interface (`LlmRouter`) but
 * never invents numbers. Unknown questions return suggestions rather than a guess.
 */
import { addDays } from "./text.js";
import { addMonths } from "./recurring.js";

export type Intent = "spend" | "income" | "profit" | "top_merchants" | "outstanding_invoices" | "runway" | "tax_estimate" | "vat" | "recurring" | "unknown";
export interface Question {
  intent: Intent;
  from: string;
  to: string;
  periodLabel: string;
  category: string | null;
  merchant: string | null;
}
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");

export function parsePeriod(q: string, today: string): { from: string; to: string; label: string } {
  const s = q.toLowerCase();
  const [y, m] = today.split("-").map(Number) as [number, number];
  const ty = m > 4 || (m === 4 && Number(today.slice(8)) >= 6) ? y : y - 1;
  if (/last month/.test(s)) {
    const d = addMonths(`${y}-${pad(m)}-01`, -1);
    const [yy, mm] = d.split("-").map(Number) as [number, number];
    return { from: d, to: monthEnd(yy, mm), label: "last month" };
  }
  if (/this month/.test(s)) return { from: `${y}-${pad(m)}-01`, to: today, label: "this month" };
  const lastN = s.match(/last (\d{1,3}) days/);
  if (lastN) return { from: addDays(today, -Number(lastN[1])), to: today, label: `last ${lastN[1]} days` };
  if (/last tax year/.test(s)) return { from: `${ty - 1}-04-06`, to: `${ty}-04-05`, label: `tax year ${ty - 1}-${pad(ty % 100)}` };
  if (/this tax year|tax year/.test(s)) return { from: `${ty}-04-06`, to: today, label: `tax year ${ty}-${pad((ty + 1) % 100)} to date` };
  if (/last quarter/.test(s)) {
    const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
    const from = addMonths(`${y}-${pad(qStartMonth)}-01`, -3);
    const [fy, fm] = from.split("-").map(Number) as [number, number];
    return { from, to: monthEnd(fy, fm + 2), label: "last quarter" };
  }
  if (/last year/.test(s)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: String(y - 1) };
  if (/this year/.test(s)) return { from: `${y}-01-01`, to: today, label: `${y} to date` };
  const named = MONTHS.findIndex((mo) => new RegExp(`\\b(${mo}|${mo.slice(0, 3)})\\b`).test(s));
  if (named >= 0) {
    const yr = Number(s.match(/\b(20\d{2})\b/)?.[1] ?? (named + 1 > m ? y - 1 : y));
    return { from: `${yr}-${pad(named + 1)}-01`, to: monthEnd(yr, named + 1), label: `${MONTHS[named]![0]!.toUpperCase()}${MONTHS[named]!.slice(1)} ${yr}` };
  }
  const yr = s.match(/\b(20\d{2})\b/);
  if (yr) return { from: `${yr[1]}-01-01`, to: `${yr[1]}-12-31`, label: yr[1]! };
  return { from: `${y}-${pad(m)}-01`, to: today, label: "this month" };
}

const CATEGORY_WORDS: Record<string, string[]> = {
  travel: ["travel", "train", "fuel", "petrol", "mileage", "taxi", "uber", "parking"],
  "admin/office": ["office", "stationery", "software", "admin"],
  "phone/internet": ["phone", "mobile", "internet", "broadband"],
  advertising: ["advertising", "marketing", "ads"],
  "professional fees": ["accountant", "legal", "professional"],
  "bank charges": ["bank charges", "bank fees", "fees"],
  "cost of goods": ["stock", "materials", "supplies", "cost of goods"],
};
export function parseQuestion(q: string, today: string): Question {
  const s = q.toLowerCase().replace(/[?!.]/g, " ");
  const p = parsePeriod(s, today);
  let intent: Intent = "unknown";
  if (/runway|run out of (cash|money)|how long.*(cash|money)|burn/.test(s)) intent = "runway";
  else if (/(who|which).*(owe|unpaid|overdue)|outstanding|unpaid invoices|overdue|debtors/.test(s)) intent = "outstanding_invoices";
  else if (/\bvat\b/.test(s)) intent = "vat";
  else if (/tax (bill|estimate|due|owe)|how much tax|set aside|tax pot/.test(s)) intent = "tax_estimate";
  else if (/subscription|recurring|direct debit/.test(s)) intent = "recurring";
  else if (/top|biggest|largest|most/.test(s) && /(supplier|merchant|payee|spend|expense|cost)/.test(s)) intent = "top_merchants";
  else if (/profit|net income|make money|earn.*net/.test(s)) intent = "profit";
  else if (/income|revenue|turnover|sales|earn|got paid|received/.test(s)) intent = "income";
  else if (/spend|spent|expense|cost|pay(ing)? for|outgoing/.test(s)) intent = "spend";
  let category: string | null = null;
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) if (words.some((w) => s.includes(w))) category = cat;
  const merchant = s.match(/\b(?:on|at|to|from) ([a-z0-9][a-z0-9 &.-]{2,30}?)(?: (?:in|this|last|during|for)\b|$)/)?.[1]?.trim() ?? null;
  return {
    intent,
    from: p.from,
    to: p.to,
    periodLabel: p.label,
    category,
    merchant: merchant && !/(this|last|the|my|average)/.test(merchant) && !category ? merchant : null,
  };
}

export interface Citation {
  type: "transaction" | "invoice" | "report" | "series";
  id: string;
  label: string;
}
export interface Answer {
  question: string;
  intent: Intent;
  answer: string;
  figures: Record<string, number | string | null>;
  citations: Citation[];
  period: { from: string; to: string; label: string };
  grounded: boolean;
  suggestions?: string[];
}
export const SUGGESTIONS = [
  "How much did I spend on travel last month?",
  "What was my profit this tax year?",
  "Who owes me money?",
  "What are my biggest suppliers this year?",
  "How long will my cash last?",
  "How much tax should I set aside?",
  "What subscriptions am I paying for?",
];
export const gbp = (p: number) => `${p < 0 ? "-" : ""}£${(Math.abs(p) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Optional LLM routing (rephrase → intent). Implementations must return one of the known intents or "unknown". */
export interface LlmRouter {
  readonly name: string;
  route(question: string): Promise<Intent>;
}
export class MockLlmRouter implements LlmRouter {
  readonly name = "mock-llm";
  async route(question: string): Promise<Intent> {
    return /money left|cash left/i.test(question) ? "runway" : "unknown";
  }
}
