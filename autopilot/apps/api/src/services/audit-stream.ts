/**
 * Push audit streaming (A10b). Every minute, each active sink gets the next batch of agent-review ledger entries after
 * its cursor, as signed NDJSON or CEF. The cursor only moves on 2xx, so delivery is at-least-once and in order; a
 * stable `autopilot-batch-id` lets receivers dedupe. Content-free: payloads appear only as hashes.
 */
import { SIGNATURE_HEADER, backoffSeconds, isRetryable, signPayload, validateWebhookUrl } from "@xevrion/platform";
import type { LedgerEntry as LedgerEntryLike } from "@xevrion/agent-review";
import type { Env } from "../env.js";
import { TenantDb } from "../lib/db.js";
import { devHttpHosts, webhookFetch, webhookNow } from "./webhooks.js";
import { sha256Hex } from "./csv.js";

export const STREAM_MAX_ATTEMPTS = 10;
export const STREAM_BATCH = 500;
export type SinkRow = {
  tenant_id: string;
  url: string;
  secret: string;
  format: "ndjson" | "cef";
  status: "active" | "paused";
  cursor_at: string;
  cursor_request: string;
  cursor_seq: number;
  attempt: number;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
  delivered: number;
  last_delivered_at: string | null;
  created_at: string;
  updated_at: string;
};
type Row = { request_id: string; seq: number; kind: LedgerEntryLike["kind"]; actor: string; at: string; data_json: string; prev_hash: string; hash: string };

/** Entries strictly after the (at, request_id, seq) cursor: no loss or repeats when many entries share a timestamp. */
export async function entriesAfter(db: TenantDb, c: { at: string; request: string; seq: number }, limit: number) {
  return db.all<Row>(
    `select request_id, seq, kind, actor, at, data_json, prev_hash, hash from review_ledger
     where tenant_id = ?1 and (at, request_id, seq) > (?2, ?3, ?4) order by at, request_id, seq limit ?5`,
    c.at,
    c.request,
    c.seq,
    limit,
  );
}
export const toEntry = (r: Row): LedgerEntryLike => ({
  requestId: r.request_id,
  seq: r.seq,
  kind: r.kind,
  actor: r.actor,
  at: r.at,
  data: JSON.parse(r.data_json) as Record<string, unknown>,
  prevHash: r.prev_hash,
  hash: r.hash,
});

const cefEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/\r?\n/g, " ");
/** ArcSight CEF:0 line; header fields escape | and \, extensions escape = and \. */
export function cefLine(e: LedgerEntryLike): string {
  const sev = e.kind === "decided" && e.data.decision === "reject" ? 6 : e.kind === "redacted" ? 5 : 3;
  const ext = [
    `rt=${Date.parse(e.at)}`,
    `suser=${cefEsc(e.actor)}`,
    `externalId=${cefEsc(e.requestId)}`,
    `cn1=${e.seq}`,
    "cn1Label=seq",
    `cs1=${cefEsc(e.hash)}`,
    "cs1Label=entryHash",
    ...(typeof e.data.decision === "string" ? [`act=${cefEsc(e.data.decision)}`] : []),
  ];
  return `CEF:0|Xevrion|AgentReview|1|review.${e.kind.replace(/[|\\]/g, "")}|Agent review ${e.kind.replace(/[|\\]/g, "")}|${sev}|${ext.join(" ")}`;
}

function renderBatch(format: SinkRow["format"], entries: LedgerEntryLike[]): string {
  return entries.map((e) => (format === "cef" ? cefLine(e) : JSON.stringify(e))).join("\n") + "\n";
}

/** Deliver one batch for one sink. Returns what happened; never throws for receiver failures. */
async function pushSink(env: Env, s: SinkRow, rand: () => number = Math.random): Promise<"idle" | "delivered" | "failed" | "paused"> {
  const db = new TenantDb(env.DB, s.tenant_id);
  const rows = await entriesAfter(db, { at: s.cursor_at, request: s.cursor_request, seq: s.cursor_seq }, STREAM_BATCH);
  if (!rows.length) return "idle";
  const entries = rows.map(toEntry);
  const body = renderBatch(s.format, entries);
  const last = rows[rows.length - 1]!;
  const batchId = (await sha256Hex(`${s.tenant_id}|${rows[0]!.at}|${rows[0]!.request_id}|${rows[0]!.seq}|${last.at}|${last.request_id}|${last.seq}`)).slice(
    0,
    32,
  );
  const t0 = webhookNow();
  const nowIso = new Date(t0).toISOString();
  let status: number | null = null;
  let error: string | null = null;
  const check = validateWebhookUrl(s.url, { allowHttpHosts: devHttpHosts(env) });
  if (!check.ok) error = `url_blocked: ${check.reason}`;
  else
    try {
      const res = await webhookFetch(s.url, {
        method: "POST",
        headers: {
          "content-type": s.format === "cef" ? "text/plain" : "application/x-ndjson",
          [SIGNATURE_HEADER]: await signPayload(s.secret, body, Math.floor(t0 / 1000)),
          "autopilot-batch-id": batchId,
          "autopilot-batch-count": String(rows.length),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      if (!res.ok) error = `http_${res.status}`;
    } catch (e) {
      error = (e as Error).name === "TimeoutError" ? "timeout" : "network_error";
    }
  if (status !== null && status >= 200 && status < 300) {
    await db.run(
      "update audit_sinks set cursor_at = ?2, cursor_request = ?3, cursor_seq = ?4, attempt = 0, next_attempt_at = '', last_status = ?5, last_error = null, delivered = delivered + ?6, last_delivered_at = ?7, updated_at = ?7 where tenant_id = ?1 and cursor_at = ?8 and cursor_request = ?9 and cursor_seq = ?10",
      last.at,
      last.request_id,
      last.seq,
      status,
      rows.length,
      nowIso,
      s.cursor_at,
      s.cursor_request,
      s.cursor_seq,
    );
    return "delivered";
  }
  const attempt = s.attempt + 1;
  const pause = !!error?.startsWith("url_blocked") || !isRetryable(status) || attempt >= STREAM_MAX_ATTEMPTS;
  await db.run(
    "update audit_sinks set attempt = ?2, next_attempt_at = ?3, last_status = ?4, last_error = ?5, status = ?6, updated_at = ?7 where tenant_id = ?1",
    attempt,
    new Date(t0 + backoffSeconds(attempt, rand) * 1000).toISOString(),
    status,
    error,
    pause ? "paused" : "active",
    nowIso,
  );
  return pause ? "paused" : "failed";
}

/** Cron: up to `maxBatches` batches per due sink (catch-up), bounded across tenants. */
export async function sweepAuditSinks(env: Env, maxBatches = 5, limit = 200): Promise<Record<string, number>> {
  const nowIso = new Date(webhookNow()).toISOString();
  const due =
    (
      await env.DB.prepare("select * from audit_sinks where status = 'active' and next_attempt_at <= ?1 order by next_attempt_at limit ?2")
        .bind(nowIso, limit)
        .all<SinkRow>()
    ).results ?? [];
  const out: Record<string, number> = { sinks: due.length, delivered: 0, failed: 0, paused: 0 };
  for (const first of due) {
    let s: SinkRow | null = first;
    for (let i = 0; i < maxBatches && s; i++) {
      const r = await pushSink(env, s);
      if (r === "idle") break;
      out[r] = (out[r] ?? 0) + 1;
      if (r !== "delivered") break;
      s = await env.DB.prepare("select * from audit_sinks where tenant_id = ?1").bind(first.tenant_id).first<SinkRow>();
    }
  }
  return out;
}
