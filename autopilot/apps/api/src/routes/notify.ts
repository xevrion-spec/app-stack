/**
 * R1 notification routes. Admin (owner, humans): channels, Slack identity links, test sends, delivery log, retry.
 * Public (rate-limited per IP): POST /notify/actions (confirmed one-click link) and the Slack interactivity endpoint.
 * GET never decides, so mail scanners that pre-fetch links cannot approve anything.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { Hono, type MiddlewareHandler } from "hono";
import * as R from "@xevrion/agent-review";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { auditStmt } from "../lib/audit.js";
import { AppError, notFound } from "../lib/errors.js";
import { newId, TenantDb } from "../lib/db.js";
import { loginRateLimit } from "../lib/ratelimit.js";
import { act, CHANNEL_COLS, testChannel, type ChannelRow } from "../services/notify.js";
import { webhookNow } from "../services/webhooks.js";
import { validateWebhookUrl } from "@xevrion/platform";
import { devHttpHosts } from "../services/webhooks.js";
import * as S from "../services/agent-review.js";
import { scope, accessScope } from "./agent-reviews.js";

export const notifyAdmin = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
const ownerHuman: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal").apiKey) throw new AppError(403, "forbidden", "API keys cannot manage notification channels");
  return requireRole("owner")(c, next);
};
notifyAdmin.use("/notify/*", ownerHuman);
const actor = (c: { get: (k: "principal") => { email: string } }) => c.get("principal").email;
const randomSecret = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

const ChannelIn = z
  .object({
    kind: z.enum(["slack", "teams", "email", "webhook"]),
    name: z.string().min(1).max(80),
    url: z.string().url().max(2000).openapi({ description: "Slack/Teams incoming-webhook URL, email provider HTTP endpoint, or your webhook" }),
    secret: z.string().min(8).max(500).optional().openapi({ description: "Email provider token; generated for webhooks when omitted" }),
    signingSecret: z.string().min(8).max(200).optional().openapi({ description: "Slack app signing secret (for interactive buttons)" }),
    projectId: z.string().max(64).optional(),
    minRisk: z.enum(["low", "medium", "high", "critical"]).default("low"),
    recipients: z.array(z.string().email().max(254)).max(50).default([]),
  })
  .superRefine((b, ctx) => {
    if (b.kind === "email" && !b.recipients.length)
      ctx.addIssue({ code: "custom", path: ["recipients"], message: "email channels need at least one recipient" });
    if (b.kind === "email" && !b.secret) ctx.addIssue({ code: "custom", path: ["secret"], message: "email channels need the provider token" });
  })
  .openapi("NotifyChannelIn");
const ChannelOut = z
  .object({
    id: z.string(),
    kind: z.enum(["slack", "teams", "email", "webhook"]),
    name: z.string(),
    urlHost: z.string(),
    projectId: z.string().nullable(),
    minRisk: z.string(),
    recipients: z.array(z.string()),
    interactive: z.boolean(),
    active: z.boolean(),
    createdAt: z.string(),
    secret: z.string().optional().openapi({ description: "Shown once, on creation of a webhook channel" }),
  })
  .openapi("NotifyChannel");
const out = (r: ChannelRow) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  urlHost: new URL(r.url).host,
  projectId: r.project_id,
  minRisk: r.min_risk,
  recipients: JSON.parse(r.recipients_json) as string[],
  interactive: r.kind === "slack" ? !!r.signing_secret : r.kind !== "webhook",
  active: !!r.active,
  createdAt: r.created_at,
});
async function loadChannel(db: TenantDb, id: string) {
  const ch = await db.first<ChannelRow>(`select ${CHANNEL_COLS} from notify_channels where tenant_id = ?1 and id = ?2`, id);
  if (!ch) throw notFound("Channel");
  return ch;
}

notifyAdmin.openapi(
  def({
    method: "post",
    path: "/notify/channels",
    tag: "Agent review",
    summary: "Add a reviewer notification channel (Slack, Teams, email or webhook)",
    body: ChannelIn,
    response: ChannelOut,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const check = validateWebhookUrl(b.url, { allowHttpHosts: devHttpHosts(c.env) });
    if (!check.ok) throw new AppError(400, "validation_failed", `URL not allowed: ${check.reason}`);
    const db = scope(c);
    if (b.projectId && !(await db.first("select 1 from review_projects where tenant_id = ?1 and id = ?2", b.projectId))) throw notFound("Project");
    for (const e of b.recipients)
      if (!(await db.first("select 1 from users where tenant_id = ?1 and lower(email) = ?2 and deactivated_at is null", e.toLowerCase())))
        throw new AppError(400, "validation_failed", `${e} is not an active member of this workspace`);
    const id = newId();
    const t = new Date().toISOString();
    const secret = b.secret ?? randomSecret();
    await db.batch([
      db.stmt(
        `insert into notify_channels (tenant_id, id, kind, name, url, secret, signing_secret, project_id, min_risk, recipients_json, active, created_by, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?12, ?12)`,
        id,
        b.kind,
        b.name,
        b.url,
        secret,
        b.signingSecret ?? null,
        b.projectId ?? null,
        b.minRisk,
        JSON.stringify(b.recipients.map((e) => e.toLowerCase())),
        actor(c),
        t,
      ),
      auditStmt(db, actor(c), "notify.channel_created", id, { kind: b.kind, host: new URL(b.url).host }),
    ]);
    const row = await loadChannel(db, id);
    return c.json({ ...out(row), ...(b.kind === "webhook" && !b.secret ? { secret } : {}) }, 201);
  },
);

notifyAdmin.openapi(
  def({
    method: "get",
    path: "/notify/channels",
    tag: "Agent review",
    summary: "List notification channels (secrets are never returned)",
    response: z.object({ items: z.array(ChannelOut) }),
  }),
  async (c) => {
    const db = scope(c);
    const rows = await db.all<ChannelRow>(`select ${CHANNEL_COLS} from notify_channels where tenant_id = ?1 order by created_at`);
    return c.json({ items: rows.map(out) }, 200);
  },
);

notifyAdmin.openapi(
  def({
    method: "delete",
    path: "/notify/channels/{id}",
    tag: "Agent review",
    summary: "Delete a channel (pending deliveries are skipped)",
    params: IdParam,
    response: z.object({ deleted: z.literal(true) }),
  }),
  async (c) => {
    const db = scope(c);
    const ch = await loadChannel(db, c.req.valid("param").id);
    await db.batch([
      db.stmt("delete from notify_channels where tenant_id = ?1 and id = ?2", ch.id),
      db.stmt("delete from notify_identities where tenant_id = ?1 and channel_id = ?2", ch.id),
      auditStmt(db, actor(c), "notify.channel_deleted", ch.id),
    ]);
    return c.json({ deleted: true as const }, 200);
  },
);

notifyAdmin.openapi(
  def({
    method: "post",
    path: "/notify/channels/{id}/test",
    tag: "Agent review",
    summary: "Send a synthetic test message now",
    params: IdParam,
    response: z.object({ ok: z.boolean(), status: z.number().nullable(), error: z.string().nullable() }),
  }),
  async (c) => {
    const r = await testChannel(c.env, await loadChannel(scope(c), c.req.valid("param").id));
    return c.json({ ok: !r.error, ...r }, 200);
  },
);

const Identity = z.object({ externalId: z.string().min(1).max(64), email: z.string().email().max(254) }).openapi("NotifyIdentity");
notifyAdmin.openapi(
  def({
    method: "put",
    path: "/notify/channels/{id}/identities",
    tag: "Agent review",
    summary: "Link a Slack user id to a reviewer, so their button clicks decide as them",
    params: IdParam,
    body: Identity,
    response: Identity,
  }),
  async (c) => {
    const db = scope(c);
    const ch = await loadChannel(db, c.req.valid("param").id);
    const b = c.req.valid("json");
    if (ch.kind !== "slack") throw new AppError(400, "validation_failed", "Identities apply to Slack channels");
    const email = b.email.toLowerCase();
    if (!(await db.first("select 1 from users where tenant_id = ?1 and lower(email) = ?2 and deactivated_at is null", email)))
      throw new AppError(400, "validation_failed", `${b.email} is not an active member of this workspace`);
    await db.batch([
      db.stmt(
        "insert into notify_identities (tenant_id, channel_id, external_id, email, created_at) values (?1, ?2, ?3, ?4, ?5) on conflict(tenant_id, channel_id, external_id) do update set email = excluded.email",
        ch.id,
        b.externalId,
        email,
        new Date().toISOString(),
      ),
      auditStmt(db, actor(c), "notify.identity_linked", ch.id, { externalId: b.externalId, email }),
    ]);
    return c.json({ externalId: b.externalId, email }, 200);
  },
);

const DeliveryOut = z
  .object({
    id: z.string(),
    channelId: z.string(),
    recipient: z.string().nullable(),
    status: z.enum(["pending", "sent", "dead", "skipped"]),
    attempt: z.number().int(),
    responseStatus: z.number().nullable(),
    lastError: z.string().nullable(),
    nextAttemptAt: z.string(),
  })
  .openapi("NotifyDelivery");
type DeliveryRow = {
  id: string;
  channel_id: string;
  recipient: string | null;
  status: "pending" | "sent" | "dead" | "skipped";
  attempt: number;
  response_status: number | null;
  last_error: string | null;
  next_attempt_at: string;
};
const dOut = (d: DeliveryRow) => ({
  id: d.id,
  channelId: d.channel_id,
  recipient: d.recipient,
  status: d.status,
  attempt: d.attempt,
  responseStatus: d.response_status,
  lastError: d.last_error,
  nextAttemptAt: d.next_attempt_at,
});

export const notifyReviewLog = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
notifyReviewLog.get("/agent-reviews/:id/notifications", requireRole("owner"));
notifyReviewLog.openapi(
  def({
    method: "get",
    path: "/agent-reviews/{id}/notifications",
    tag: "Agent review",
    summary: "Notification delivery log for a request",
    params: IdParam,
    response: z.object({ items: z.array(DeliveryOut) }),
  }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, await accessScope(c));
    const rows = await db.all<DeliveryRow>(
      "select id, channel_id, recipient, status, attempt, response_status, last_error, next_attempt_at from notify_deliveries where tenant_id = ?1 and request_id = ?2 order by created_at, id",
      r.id,
    );
    return c.json({ items: rows.map(dOut) }, 200);
  },
);

notifyAdmin.openapi(
  def({
    method: "post",
    path: "/notify/deliveries/{id}/retry",
    tag: "Agent review",
    summary: "Re-queue a dead delivery",
    params: IdParam,
    response: DeliveryOut,
  }),
  async (c) => {
    const db = scope(c);
    const id = c.req.valid("param").id;
    const res = await db.run(
      "update notify_deliveries set status = 'pending', attempt = 0, next_attempt_at = ?3, last_error = null, updated_at = ?3 where tenant_id = ?1 and id = ?2 and status = 'dead'",
      id,
      new Date(webhookNow()).toISOString(),
    );
    if (!res) throw new AppError(409, "conflict", "Only dead deliveries can be retried");
    await db.batch([auditStmt(db, actor(c), "notify.delivery_retried", id)]);
    const d = await db.first<DeliveryRow>(
      "select id, channel_id, recipient, status, attempt, response_status, last_error, next_attempt_at from notify_deliveries where tenant_id = ?1 and id = ?2",
      id,
    );
    return c.json(dOut(d!), 200);
  },
);

// ---------------- public ----------------
export const notifyPublic = new Hono<AppEnv>();
notifyPublic.use("/notify/*", loginRateLimit);
const ActionIn = z.object({ token: z.string().min(10).max(4000), reason: z.string().max(2000).optional() });
notifyPublic.post("/notify/actions", async (c) => {
  const parsed = ActionIn.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "validation_failed", "token is required");
  const r = await act(c.env, parsed.data.token, { channel: "link", reason: parsed.data.reason });
  return c.json({ decision: r.decision, reviewer: r.reviewer, requestId: r.review.id, status: r.review.status }, 200);
});

/** Slack interactivity: verify the Slack signature, map the clicking user, decide, reply ephemerally. */
notifyPublic.post("/notify/slack/:channelId/interactions", async (c) => {
  const raw = await c.req.text();
  const channelId = c.req.param("channelId");
  const ch = await c.env.DB.prepare("select tenant_id, signing_secret from notify_channels where id = ?1 and kind = 'slack' and active = 1")
    .bind(channelId)
    .first<{ tenant_id: string; signing_secret: string | null }>();
  const now = Math.floor(webhookNow() / 1000);
  if (
    !ch?.signing_secret ||
    !(await R.verifySlackSignature(ch.signing_secret, c.req.header("x-slack-request-timestamp") ?? null, raw, c.req.header("x-slack-signature") ?? null, now))
  )
    throw new AppError(401, "unauthenticated", "Bad Slack signature");
  let payload: { user?: { id?: string }; actions?: { action_id?: string; value?: string }[] };
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "");
  } catch {
    throw new AppError(400, "validation_failed", "payload is required");
  }
  const a = payload.actions?.[0];
  if (!a?.value || (a.action_id !== "review_approve" && a.action_id !== "review_reject"))
    return c.json({ response_type: "ephemeral", text: "Nothing to do." }, 200);
  const db = new TenantDb(c.env.DB, ch.tenant_id);
  const link = await db.first<{ email: string }>(
    "select email from notify_identities where tenant_id = ?1 and channel_id = ?2 and external_id = ?3",
    channelId,
    payload.user?.id ?? "",
  );
  try {
    const r = await act(c.env, a.value, { channel: "slack", email: link?.email });
    return c.json({ response_type: "ephemeral", text: `Recorded ${r.decision} by ${r.reviewer}. Request is now ${r.review.status}.` }, 200);
  } catch (e) {
    if (e instanceof AppError) return c.json({ response_type: "ephemeral", text: e.message }, 200);
    throw e;
  }
});
