import type { ExceptionItem } from "./types.js";

/** QA score in [0,1]: share of items without a blocking exception, minus a penalty per high-severity issue. */
export function qaScore(totalItems: number, exceptions: ExceptionItem[]): number {
  if (totalItems <= 0) return 1;
  const blocking = new Set(exceptions.filter((e) => e.severity !== "low" && e.subjectId).map((e) => e.subjectId));
  const high = exceptions.filter((e) => e.severity === "high").length;
  const s = Math.max(0, 1 - blocking.size / totalItems - 0.25 * high);
  return Math.round(s * 1000) / 1000;
}

export const isBillableOutcome = (score: number, exceptions: ExceptionItem[]) => score >= 0.85 && !exceptions.some((e) => e.severity === "high");
