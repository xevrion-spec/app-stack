import type { Pence } from "./money.js";

export const STAGES = ["intake", "extract", "categorise", "reconcile", "draft", "qa", "review", "deliver", "outcome"] as const;
export type Stage = (typeof STAGES)[number];

export interface BankLine {
  id: string;
  date: string; // ISO yyyy-mm-dd
  description: string;
  amountPence: Pence; // +in / -out
  currency?: string; // ISO 4217, default GBP
}

export interface Receipt {
  id: string;
  date: string;
  merchant: string;
  totalPence: Pence; // positive gross
  vatPence: Pence;
}

export interface InvoiceRef {
  id: string;
  number: string;
  customerName: string;
  grossPence: Pence;
  issueDate: string;
  dueDate?: string;
}

export type ReasonCode =
  | "LOW_CONFIDENCE"
  | "UNKNOWN_CATEGORY"
  | "NO_RECEIPT"
  | "POSSIBLE_DUPLICATE"
  | "FOREIGN_CURRENCY"
  | "UNUSUAL_AMOUNT"
  | "TRANSFER_CHECK"
  | "REFUND_CHECK"
  | "VAT_ARITHMETIC"
  | "LLM_INVALID_OUTPUT";

export interface ExceptionItem {
  reasonCode: ReasonCode;
  severity: "low" | "medium" | "high";
  subjectId?: string;
  message: string;
}

export interface StageResult<T> {
  stage: Stage;
  output: T;
  confidence: number; // 0..1
  exceptions: ExceptionItem[];
}

/** A stage is a pure-ish async function with an injected context (LLM, tracer). */
export interface StageContext {
  tracer: Tracer;
  llm?: LlmClient;
}
export interface Tracer {
  span<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T>;
}
export const noopTracer: Tracer = { span: (_n, _i, fn) => fn() };

export interface LlmClient {
  /** Returns raw model text. Callers must validate structure. */
  complete(prompt: string): Promise<string>;
}
