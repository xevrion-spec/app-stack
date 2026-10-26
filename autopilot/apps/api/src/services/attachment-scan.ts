/**
 * Attachment scanning (R4). Two layers:
 *  1. Real, always on: the bytes must match the declared type (magic bytes / UTF-8 for text), and executables are
 *     refused whatever they claim to be.
 *  2. Malware engine: pluggable. The default is a STUB that only recognises the EICAR test signature; it is labelled
 *     "stub-eicar" in every result so nobody mistakes it for antivirus. Plug a real engine with __setAttachmentScanner.
 */
export type ScanResult = { status: "clean" | "infected" | "rejected"; engine: string; detail: string | null };
export interface MalwareEngine {
  name: string;
  scan(bytes: Uint8Array): Promise<{ infected: boolean; signature?: string }>;
}

export const ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/json",
]);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const stub: MalwareEngine = {
  name: "stub-eicar",
  async scan(bytes) {
    const head = String.fromCharCode(...bytes.subarray(0, 4096));
    return head.includes(EICAR) ? { infected: true, signature: "EICAR-Test-File" } : { infected: false };
  },
};
let engine: MalwareEngine = stub;
/** Test/integration hook: swap the malware engine (null restores the stub). */
export const __setAttachmentScanner = (e: MalwareEngine | null) => {
  engine = e ?? stub;
};

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  "application/pdf": (b) => starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  "image/png": (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => starts(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => starts(b, [0x47, 0x49, 0x46, 0x38]),
  "image/webp": (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8),
};
const EXECUTABLE = (b: Uint8Array) =>
  starts(b, [0x4d, 0x5a]) ||
  starts(b, [0x7f, 0x45, 0x4c, 0x46]) ||
  starts(b, [0xcf, 0xfa, 0xed, 0xfe]) ||
  starts(b, [0xfe, 0xed, 0xfa, 0xcf]) ||
  starts(b, [0x23, 0x21]);
function utf8(b: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
    return !b.includes(0);
  } catch {
    return false;
  }
}

export async function scanAttachment(bytes: Uint8Array, contentType: string): Promise<ScanResult> {
  const typeOk = MAGIC[contentType] ? MAGIC[contentType](bytes) : utf8(bytes);
  if (EXECUTABLE(bytes)) return { status: "rejected", engine: "type-check", detail: "executable content" };
  if (!typeOk) return { status: "rejected", engine: "type-check", detail: `content does not match ${contentType}` };
  if (contentType === "application/json") {
    try {
      JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { status: "rejected", engine: "type-check", detail: "invalid JSON" };
    }
  }
  try {
    const r = await engine.scan(bytes);
    return r.infected ? { status: "infected", engine: engine.name, detail: r.signature ?? "malware" } : { status: "clean", engine: engine.name, detail: null };
  } catch {
    return { status: "rejected", engine: engine.name, detail: "scanner error (fail closed)" };
  }
}
