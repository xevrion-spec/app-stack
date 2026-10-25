import * as R from "@xevrion/agent-review";
import type { TenantDb } from "../lib/db.js";

export type PendingEntry = Omit<R.UnsignedEntry, "requestId" | "seq">;
const LEDGER_COLS = "request_id, seq, kind, actor, at, data_json, prev_hash, hash";
type LedgerRow = { request_id: string; seq: number; kind: R.LedgerKind; actor: string; at: string; data_json: string; prev_hash: string; hash: string };

export const payloadSha = (json: string) => R.sha256Hex(R.canonicalJson(JSON.parse(json)));

/** Seal entries after (seq, head) and return the inserts plus the new head; callers pin the head on the request row in the same batch. */
export async function appendStmts(
  db: TenantDb,
  requestId: string,
  after: { seq: number; head: string | null },
  entries: PendingEntry[],
): Promise<{ stmts: D1PreparedStatement[]; seq: number; head: string }> {
  const sealed = await R.sealAll(
    after.head ?? R.GENESIS,
    entries.map((e, i) => ({ ...e, requestId, seq: after.seq + i + 1 })),
  );
  const stmts = sealed.map((e) =>
    db.stmt(
      "insert into review_ledger (tenant_id, request_id, seq, kind, actor, at, data_json, prev_hash, hash) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      e.requestId,
      e.seq,
      e.kind,
      e.actor,
      e.at,
      JSON.stringify(e.data),
      e.prevHash,
      e.hash,
    ),
  );
  const last = sealed[sealed.length - 1]!;
  return { stmts, seq: last.seq, head: last.hash };
}

const toEntry = (r: LedgerRow): R.LedgerEntry => ({
  requestId: r.request_id,
  seq: r.seq,
  kind: r.kind,
  actor: r.actor,
  at: r.at,
  data: JSON.parse(r.data_json) as Record<string, unknown>,
  prevHash: r.prev_hash,
  hash: r.hash,
});

export async function loadChain(db: TenantDb, requestId: string): Promise<R.LedgerEntry[]> {
  return (await db.all<LedgerRow>(`select ${LEDGER_COLS} from review_ledger where tenant_id = ?1 and request_id = ?2 order by seq`, requestId)).map(toEntry);
}

type Head = { chain_seq: number; chain_head: string | null; current_payload_json: string; id: string };
type Decision = { reviewer: string; decision: string; payload_version: number; created_at: string };
export type Integrity =
  | { ok: true; length: number; head: string }
  | { ok: false; reason: "unchained" | R.ChainProblem | "head_mismatch" | "decisions_mismatch" | "payload_mismatch"; at?: number };

/**
 * Full integrity check: the chain itself, the head pinned on the row (catches tail truncation), every decision row
 * matching a chain entry (catches edits to review_decisions), and the current payload hash (catches payload edits).
 */
export async function checkIntegrity(r: Head, chain: R.LedgerEntry[], decisions: Decision[]): Promise<Integrity> {
  if (r.chain_seq === 0 && !chain.length) return { ok: false, reason: "unchained" };
  const v = await R.verifyChain(r.id, chain);
  if (!v.ok) return { ok: false, reason: v.problem, at: v.at };
  if (v.length !== r.chain_seq || v.head !== r.chain_head) return { ok: false, reason: "head_mismatch" };
  const fromChain = chain
    .filter((e) => e.kind === "decided")
    .map((e) => `${e.actor}|${String(e.data.decision)}|${String(e.data.payloadVersion)}|${e.at}`)
    .sort();
  const fromRows = decisions.map((d) => `${d.reviewer}|${d.decision}|${d.payload_version}|${d.created_at}`).sort();
  if (fromChain.join("\n") !== fromRows.join("\n")) return { ok: false, reason: "decisions_mismatch" };
  const lastSha = [...chain].reverse().find((e) => typeof e.data.payloadSha256 === "string")?.data.payloadSha256;
  if (lastSha !== (await payloadSha(r.current_payload_json))) return { ok: false, reason: "payload_mismatch" };
  return v;
}
