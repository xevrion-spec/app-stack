/** Shared text helpers: merchant keys strip dates, refs and card noise so "NETFLIX.COM 12/07 REF 8812" ~ "NETFLIX.COM 13/08". */
export function merchantKey(description: string): string {
  return (
    description
      .toUpperCase()
      .replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, " ")
      // Strip non-letters before noise words so "SO0" -> "SO" -> "" in one pass (idempotent).
      .replace(/[^A-Z ]+/g, " ")
      .replace(/\b(CARD|PAYMENT|TO|FROM|DD|SO|DIRECT DEBIT|STANDING ORDER|POS|VISA|DEBIT|CREDIT|CONTACTLESS|REF|FPI|FPO|BGC|ON)\b/g, " ")
      .replace(/\b[A-Z]\b/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}
/** Jaccard similarity of word sets, 0..1. */
export function similarity(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
export const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
