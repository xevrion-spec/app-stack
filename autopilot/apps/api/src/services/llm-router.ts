/**
 * LLM intent router interface (ADR 0026). The practice assistant ALWAYS tries deterministic rules first. The LLM router
 * is only a fallback for phrasing the rules miss, and it may only return one of the known intents (never free text,
 * never data). The shipped adapter is a MOCK (keyword synonyms); no model is called and no ledger data leaves the Worker.
 */
import { ALL_INTENTS, type PracticeIntent } from "@xevrion/books";

export interface LlmRouter {
  readonly name: string;
  route(question: string): Promise<PracticeIntent | null>;
}
const SYNONYMS: [RegExp, PracticeIntent][] = [
  [/\b(behind|slipping|neglected)\b/i, "worst_health"],
  [/\b(owe|chase|outstanding)\b/i, "missing_documents"],
  [/\b(money (we're|we are) owed|invoice the client)\b/i, "wip"],
];
export const mockLlmRouter: LlmRouter = {
  name: "mock-llm",
  async route(q) {
    const hit = SYNONYMS.find(([re]) => re.test(q))?.[1] ?? null;
    return hit && ALL_INTENTS.includes(hit) ? hit : null;
  },
};
