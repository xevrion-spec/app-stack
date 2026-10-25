import { canonicalJson } from "./canonical.js";

/**
 * Tamper-evident ledger for one review request: every state change appends an entry whose hash covers the
 * previous entry's hash, so editing, deleting or reordering any entry breaks every later hash.
 * Entries carry hashes of payloads, not payloads, so the chain can be exported to a SIEM without leaking content.
 */
export const GENESIS = "0".repeat(64);
export const LEDGER_KINDS = ["requested", "decided", "escalated", "expired", "cancelled"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface LedgerEntry {
  requestId: string;
  seq: number;
  kind: LedgerKind;
  actor: string;
  at: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}
export type UnsignedEntry = Omit<LedgerEntry, "hash" | "prevHash">;

const enc = new TextEncoder();
export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function entryMaterial(prevHash: string, e: UnsignedEntry): string {
  return `${prevHash}\n${canonicalJson({ requestId: e.requestId, seq: e.seq, kind: e.kind, actor: e.actor, at: e.at, data: e.data })}`;
}

export async function seal(prevHash: string, e: UnsignedEntry): Promise<LedgerEntry> {
  return { ...e, prevHash, hash: await sha256Hex(entryMaterial(prevHash, e)) };
}

/** Seal several entries in order, starting after `prevHash`. */
export async function sealAll(prevHash: string, entries: UnsignedEntry[]): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  let prev = prevHash;
  for (const e of entries) {
    const s = await seal(prev, e);
    out.push(s);
    prev = s.hash;
  }
  return out;
}

export type ChainProblem = "empty" | "seq_gap" | "prev_mismatch" | "hash_mismatch" | "wrong_request";
export type ChainVerdict = { ok: true; length: number; head: string } | { ok: false; at: number; problem: ChainProblem };

/** Verify a whole chain from genesis. `at` is the 1-based seq of the first bad entry. */
export async function verifyChain(requestId: string, entries: LedgerEntry[]): Promise<ChainVerdict> {
  if (!entries.length) return { ok: false, at: 0, problem: "empty" };
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const problem: ChainProblem | null =
      e.requestId !== requestId
        ? "wrong_request"
        : e.seq !== i + 1
          ? "seq_gap"
          : e.prevHash !== prev
            ? "prev_mismatch"
            : e.hash !== (await sha256Hex(entryMaterial(prev, e)))
              ? "hash_mismatch"
              : null;
    if (problem) return { ok: false, at: i + 1, problem };
    prev = e.hash;
  }
  return { ok: true, length: entries.length, head: prev };
}
