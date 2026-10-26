/**
 * R1 reviewer notifications: enqueue on request creation (same batch), deliver from a cron sweep with retries and
 * backoff, and turn signed one-click actions (email/Teams links, Slack buttons) into decisions through decideAs.
 * Outbound HTTP goes through the shared webhook fetcher (SSRF-checked; faked in tests). No real messages are sent
 * unless a real URL and provider are configured.
 */
import * as R from "@xevrion/agent-review";
import { SIGNATURE_HEADER, backoffSeconds, isRetryable, signPayload, validateWebhookUrl } from "@xevrion/platform";
import type { Env } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { auditStmt } from "../lib/audit.js";
import { devHttpHosts, webhookFetch, webhookNow } from "./webhooks.js";
import * as S from "./agent-review.js";
import { decideAs, scopeFor } from "./agent-review-decide.js";

const NOTIFY_MAX_ATTEMPTS = 8;
import { RISKS } from "./notify-enqueue.js";
type ChannelKind = "slack" | "teams" | "email" | "webhook";
export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string;
  url: string;
  secret: string;
  signing_secret: string | null;
  project_id: string | null;
  min_risk: (typeof RISKS)[number];
  recipients_json: string;
  active: number;
  created_by: string;
  created_at: string;
}
export const CHANNEL_COLS = "id, kind, name, url, secret, signing_secret, project_id, min_risk, recipients_json, active, created_by, created_at";
interface DeliveryRow {
  tenant_id: string;
  id: string;
  channel_id: string;
  request_id: string;
  recipient: string | null;
  attempt: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const appOrigin = (env: Env) => (env.ALLOWED_ORIGINS ?? "").split(",")[0]!.trim().replace(/\/$/, "");
const actionKey = (env: Env, tenantId: string) => (env.NOTIFY_ACTION_KEY ? `${env.NOTIFY_ACTION_KEY}:${tenantId}` : null);

async function tokens(env: Env, tenantId: string, r: S.RequestRow, user: string, nowSec: number) {
  const key = actionKey(env, tenantId);
  if (!key) return null;
  const exp = Math.min(Math.floor(Date.parse(r.deadline_at) / 1000), nowSec + 7 * 86_400);
  const n = newId();
  const mk = (d: R.NotifyDecision) => R.signAction({ v: 1, tid: tenantId, rid: r.id, d, u: user, exp, n }, key);
  return { approve: await mk("approve"), reject: await mk("reject") };
}

async function render(env: Env, db: TenantDb, ch: ChannelRow, r: S.RequestRow, recipient: string | null, nowSec: number) {
  const project = (await db.first<{ name: string }>("select name from review_projects where tenant_id = ?1 and id = ?2", r.project_id))?.name ?? r.project_id;
  const app = appOrigin(env);
  const base: R.NotifyInput = {
    requestId: r.id,
    action: r.action,
    risk: r.risk,
    project,
    deadlineAt: r.deadline_at,
    summary: R.summarise(JSON.parse(r.current_payload_json)),
    openUrl: `${app}/#/agent-reviews/${encodeURIComponent(r.id)}`,
  };
  if (ch.kind === "webhook") return { body: JSON.stringify(R.renderWebhook(base)), contentType: "application/json" };
  // Slack buttons act as whoever clicks (mapped via identities); links in email/Teams are bound to one person.
  const tok = await tokens(env, db.tenantId, r, ch.kind === "slack" ? "*" : (recipient ?? "*"), nowSec);
  if (ch.kind === "slack") return { body: JSON.stringify(R.renderSlack(base, tok)), contentType: "application/json" };
  const links = tok && recipient ? { approveUrl: `${app}/#/act/${tok.approve}`, rejectUrl: `${app}/#/act/${tok.reject}` } : {};
  if (ch.kind === "teams") return { body: JSON.stringify(R.renderTeams({ ...base, ...links })), contentType: "application/json" };
  return { body: JSON.stringify({ to: recipient, ...R.renderEmail({ ...base, ...links }) }), contentType: "application/json" };
}

async function headers(ch: ChannelRow, body: string, contentType: string, t0: number): Promise<Record<string, string>> {
  const h: Record<string, string> = { "content-type": contentType };
  if (ch.kind === "webhook") h[SIGNATURE_HEADER] = await signPayload(ch.secret, body, Math.floor(t0 / 1000));
  if (ch.kind === "email") h.authorization = `Bearer ${ch.secret}`;
  return h;
}

async function send(env: Env, ch: ChannelRow, body: string, contentType: string): Promise<{ status: number | null; error: string | null }> {
  const check = validateWebhookUrl(ch.url, { allowHttpHosts: devHttpHosts(env) });
  if (!check.ok) return { status: null, error: `url_blocked: ${check.reason}` };
  try {
    const res = await webhookFetch(ch.url, {
      method: "POST",
      headers: await headers(ch, body, contentType, webhookNow()),
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, error: res.ok ? null : `http_${res.status}` };
  } catch (e) {
    return { status: null, error: (e as Error).name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

async function deliver(env: Env, d: DeliveryRow, rand: () => number): Promise<"sent" | "failed" | "dead" | "skipped"> {
  const db = new TenantDb(env.DB, d.tenant_id);
  const t0 = webhookNow();
  const ch = await db.first<ChannelRow>(`select ${CHANNEL_COLS} from notify_channels where tenant_id = ?1 and id = ?2`, d.channel_id);
  const r = await db.first<S.RequestRow>(`select ${S.COLS} from review_requests where tenant_id = ?1 and id = ?2`, d.request_id);
  const finish = (status: string, http: number | null, error: string | null, attempt: number, next: string) =>
    db.run(
      "update notify_deliveries set status = ?3, response_status = ?4, last_error = ?5, attempt = ?6, next_attempt_at = ?7, updated_at = ?8 where tenant_id = ?1 and id = ?2",
      d.id,
      status,
      http,
      error,
      attempt,
      next,
      iso(t0),
    );
  if (!ch || !ch.active || !r || R.FINAL.has(r.status)) {
    await finish("skipped", null, !ch || !ch.active ? "channel_inactive" : "request_final", d.attempt, iso(t0));
    return "skipped";
  }
  const { body, contentType } = await render(env, db, ch, r, d.recipient, Math.floor(t0 / 1000));
  const res = await send(env, ch, body, contentType);
  const attempt = d.attempt + 1;
  if (!res.error) {
    await finish("sent", res.status, null, attempt, iso(t0));
    return "sent";
  }
  const dead = res.error.startsWith("url_blocked") || !isRetryable(res.status) || attempt >= NOTIFY_MAX_ATTEMPTS;
  await finish(dead ? "dead" : "pending", res.status, res.error, attempt, iso(t0 + backoffSeconds(attempt, rand) * 1000));
  return dead ? "dead" : "failed";
}

/** Cron: deliver due notifications across tenants (bounded). */
export async function sweepNotifications(env: Env, limit = 200, rand: () => number = Math.random): Promise<Record<string, number>> {
  const due =
    (
      await env.DB.prepare(
        "select tenant_id, id, channel_id, request_id, recipient, attempt from notify_deliveries where status = 'pending' and next_attempt_at <= ?1 order by next_attempt_at limit ?2",
      )
        .bind(iso(webhookNow()), limit)
        .all<DeliveryRow>()
    ).results ?? [];
  const out: Record<string, number> = { due: due.length, sent: 0, failed: 0, dead: 0, skipped: 0 };
  for (const d of due) out[await deliver(env, d, rand)]!++;
  return out;
}

/** Sends one synthetic message now (no request involved) so an admin can check the channel. */
export async function testChannel(env: Env, ch: ChannelRow): Promise<{ status: number | null; error: string | null }> {
  const n: R.NotifyInput = {
    requestId: "test",
    action: "test.notification",
    risk: "low",
    project: "Channel test",
    deadlineAt: iso(webhookNow()),
    summary: [["note", "This is a test message from the review layer"]],
    openUrl: `${appOrigin(env)}/#/agent-reviews`,
  };
  const body =
    ch.kind === "slack"
      ? JSON.stringify(R.renderSlack(n, null))
      : ch.kind === "teams"
        ? JSON.stringify(R.renderTeams(n))
        : ch.kind === "email"
          ? JSON.stringify({ to: JSON.parse(ch.recipients_json)[0] ?? null, ...R.renderEmail(n) })
          : JSON.stringify(R.renderWebhook(n));
  return send(env, ch, body, "application/json");
}

// ---------------- inbound: one-click actions ----------------
type UserRow = { id: string; email: string; role: string; deactivated_at: string | null };

/** Verify a token and decide as `email` (or the token's bound user). Single use per (nonce, person). */
export async function act(env: Env, token: string, opts: { email?: string; reason?: string; channel: "link" | "slack" }) {
  const tid = tenantOf(token);
  const key = tid ? actionKey(env, tid) : null;
  if (!tid || !key) throw new AppError(400, "invalid_action", "This action link is not valid");
  const v = await R.verifyAction(token, key, Math.floor(webhookNow() / 1000));
  if (!v.ok)
    throw new AppError(
      v.reason === "expired" ? 410 : 400,
      v.reason === "expired" ? "action_expired" : "invalid_action",
      v.reason === "expired" ? "This action link has expired" : "This action link is not valid",
    );
  const c = v.claims;
  if (opts.channel === "link" && c.u === "*") throw new AppError(400, "invalid_action", "This action must come from its channel");
  const email = (c.u === "*" ? opts.email : c.u)?.toLowerCase();
  if (!email) throw new AppError(403, "unknown_reviewer", "This chat user is not linked to a reviewer");
  const db = new TenantDb(env.DB, c.tid);
  const u = await db.first<UserRow>("select id, email, role, deactivated_at from users where tenant_id = ?1 and lower(email) = ?2", email);
  if (!u || u.deactivated_at || (u.role !== "owner" && u.role !== "reviewer"))
    throw new AppError(403, "forbidden", "You cannot decide reviews in this workspace");
  const who = { userId: u.id, email: u.email, role: u.role, apiKey: false };
  const r = await S.expireIfDue(env, db, await S.loadReview(db, c.rid, await scopeFor(db, who)));
  try {
    await db.run(
      "insert into notify_action_nonces (tenant_id, nonce, request_id, used_at) values (?1, ?2, ?3, ?4)",
      `${c.n}:${email}`,
      c.rid,
      iso(webhookNow()),
    );
  } catch {
    throw new AppError(409, "action_used", "This action link was already used");
  }
  const next = await decideAs(env, db, r, who, { decision: c.d, reason: opts.reason });
  await db.batch([auditStmt(db, u.email, "notify.action", r.id, { channel: opts.channel, decision: c.d })]);
  return { review: next, decision: c.d, reviewer: u.email };
}

function tenantOf(token: string): string | null {
  try {
    const claims = JSON.parse(atob((token.split(".")[0] ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as { tid?: unknown };
    return typeof claims.tid === "string" ? claims.tid : null;
  } catch {
    return null;
  }
}
