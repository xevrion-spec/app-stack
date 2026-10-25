/** Upload safety shared by every upload path (owner, practice, portal). */
export const MAX_RECEIPT = 10 * 1024 * 1024;
export const RECEIPT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"]);
/** Virus/content scan hook. STUB: marks clean; replace with a real scanner before accepting customer files. */
export async function scanHook(_bytes: ArrayBuffer, _contentType: string): Promise<"clean" | "rejected"> {
  return "clean";
}
