/**
 * Platform API: events + activity, webhooks, automations, API keys, inbound triggers, search, bulk operations,
 * invoice concurrency/soft-delete, usage, flags and realtime. Mounted under /v1.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  EVENT_TYPES,
  TEMPLATES,
  catalogDocument,
  etagFor,
  ftsQuery,
  generateApiKey,
  ifMatchFails,
  ifNoneMatchHits,
  isEnabled,
  isEventType,
  makeEvent,
  parseAutomation,
  parseFlags,
  quotaCheck,
  randomToken,
  SCOPES,
  validateWebhookUrl,
  PLAN_QUOTAS,
} from "@xevrion/platform";
import type { AppEnv } from "../env.js";
import { requireRole } from "../lib/auth.js";
import { TenantDb, decodeCursor, encodeCursor, newId } from "../lib/db.js";
import { AppError, badRequest, notFound } from "../lib/errors.js";
import { auditStmt } from "../lib/audit.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { Outbox, rowToEnvelope, type EventRow } from "../services/events.js";
import { runAutomation, type AutomationRow } from "../services/automations.js";
import { categoriseTransaction } from "../services/categorise.js";
import { attemptDelivery, devHttpHosts, type EndpointRow } from "../services/webhooks.js";
import { period } from "../services/usage.js";

type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const actor = (c: C) => c.get("principal").email;
const owner = requireRole("owner");
export const platform = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });

const Page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().optional() });
async function keyset<T extends { created_at: string; id: string }>(db: TenantDb, sql: string, params: unknown[], cursor: string | undefined, limit: number) {
  const cur = decodeCursor(cursor);
  const where = cur ? ` and (created_at, id) < (?${params.length + 2}, ?${params.length + 3})` : "";
  const rows = await db.all<T>(`${sql}${where} order by created_at desc, id desc limit ${limit + 1}`, ...params, ...(cur ?? []));
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

// ---------------- events & activity ----------------
const EventOut = z
  .object({
    id: z.string(),
    type: z.string(),
    version: z.number(),
    actor: z.string(),
    occurredAt: z.string(),
    causationChain: z.array(z.string()),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("Event");
platform.openapi(
  def({
    method: "get",
    path: "/events/catalog",
    tag: "Events",
    summary: "Versioned event catalog",
    response: z.array(z.object({ type: z.string(), version: z.number(), description: z.string(), fields: z.array(z.string()) })),
  }),
  (c) => c.json(catalogDocument(), 200),
);
platform.openapi(
  def({
    method: "get",
    path: "/events",
    tag: "Events",
    summary: "Event log (newest first); filter by type or entity.*",
    query: Page.extend({ type: z.string().max(60).optional() }),
    response: z.object({ items: z.array(EventOut), nextCursor: z.string().nullable() }).openapi("EventPage"),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const db = scope(c);
    const params: unknown[] = [];
    let sql = "select id, type, version, actor, causation_json, payload_json, created_at, dispatched_at from events where tenant_id = ?1";
    if (q.type) {
      if (q.type.endsWith(".*")) {
        sql += " and type like ?2";
        params.push(q.type.slice(0, -1) + "%");
      } else {
        sql += " and type = ?2";
        params.push(q.type);
      }
    }
    const p = await keyset<EventRow>(db, sql, params, q.cursor, q.limit);
    return c.json({ items: p.items.map((r) => strip(rowToEnvelope(db.tenantId, r))), nextCursor: p.nextCursor }, 200);
  },
);
const strip = (e: ReturnType<typeof rowToEnvelope>) => ({
  id: e.id,
  type: e.type,
  version: e.version,
  actor: e.actor,
  occurredAt: e.occurredAt,
  causationChain: e.causationChain,
  data: e.data as Record<string, unknown>,
});
platform.openapi(def({ method: "get", path: "/events/{id}", tag: "Events", summary: "One event", params: IdParam, response: EventOut }), async (c) => {
  const db = scope(c);
  const r = await db.first<EventRow>(
    "select id, type, version, actor, causation_json, payload_json, created_at, dispatched_at from events where tenant_id = ?1 and id = ?2",
    c.req.valid("param").id,
  );
  if (!r) throw notFound("Event");
  return c.json(strip(rowToEnvelope(db.tenantId, r)), 200);
});
const ActivityOut = z
  .object({
    id: z.string(),
    actor: z.string(),
    action: z.string(),
    subject: z.string().nullable(),
    meta: z.record(z.string(), z.unknown()).nullable(),
    created_at: z.string(),
  })
  .openapi("Activity");
platform.openapi(
  def({
    method: "get",
    path: "/activity",
    tag: "Events",
    summary: "Audit timeline (who did what, newest first)",
    query: Page.extend({ subject: z.string().max(64).optional() }),
    response: z.object({ items: z.array(ActivityOut), nextCursor: z.string().nullable() }).openapi("ActivityPage"),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const p = await keyset<{ id: string; actor: string; action: string; subject: string | null; meta_json: string | null; created_at: string }>(
      scope(c),
      "select id, actor, action, subject, meta_json, created_at from audit_log where tenant_id = ?1" + (q.subject ? " and subject = ?2" : ""),
      q.subject ? [q.subject] : [],
      q.cursor,
      q.limit,
    );
    return c.json(
      {
        items: p.items.map(({ meta_json, ...r }) => ({ ...r, meta: meta_json ? (JSON.parse(meta_json) as Record<string, unknown>) : null })),
        nextCursor: p.nextCursor,
      },
      200,
    );
  },
);

// ---------------- webhooks ----------------
const EventFilters = z
  .array(z.string().max(60))
  .min(1)
  .max(20)
  .refine(
    (fs) => fs.every((f) => f === "*" || isEventType(f) || EVENT_TYPES.some((t) => f.endsWith(".*") && t.startsWith(f.slice(0, -1)))),
    "unknown event type",
  );
const WebhookIn = z
  .object({ url: z.string().max(2048), description: z.string().max(200).optional(), events: EventFilters.default(["*"]) })
  .openapi("CreateWebhook");
const WebhookOut = z
  .object({
    id: z.string(),
    url: z.string(),
    description: z.string().nullable(),
    events: z.array(z.string()),
    status: z.string(),
    disabled_reason: z.string().nullable(),
    consecutive_failures: z.number(),
    version: z.number(),
    created_at: z.string(),
    secret: z.string().optional(),
  })
  .openapi("Webhook");
type WebhookRow = {
  id: string;
  url: string;
  description: string | null;
  event_filters_json: string;
  status: string;
  disabled_reason: string | null;
  consecutive_failures: number;
  version: number;
  created_at: string;
};
const WH_COLS = "id, url, description, event_filters_json, status, disabled_reason, consecutive_failures, version, created_at";
const whOut = ({ event_filters_json, ...r }: WebhookRow) => ({ ...r, events: JSON.parse(event_filters_json) as string[] });
const checkUrl = (c: C, url: string) => {
  const v = validateWebhookUrl(url, {
    allowHttpHosts: devHttpHosts(c.env),
  });
  if (!v.ok) throw badRequest(`Webhook URL rejected: ${v.reason}`);
};
platform.use("/webhooks", async (c, next) => (c.req.method === "GET" ? next() : owner(c, next)));
platform.use("/webhooks/*", async (c, next) => (c.req.method === "GET" ? next() : owner(c, next)));
platform.openapi(
  def({
    method: "post",
    path: "/webhooks",
    tag: "Webhooks",
    summary: "Create endpoint (secret returned once)",
    body: WebhookIn,
    response: WebhookOut,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    checkUrl(c, b.url);
    const db = scope(c);
    const n = (await db.first<{ n: number }>("select count(*) n from webhook_endpoints where tenant_id = ?1 and deleted_at is null"))?.n ?? 0;
    if (n >= 20) throw badRequest("At most 20 webhook endpoints per tenant");
    const id = newId();
    const secret = `whsec_${randomToken(24)}`;
    await db.batch([
      db.stmt(
        "insert into webhook_endpoints (tenant_id, id, url, description, secret, event_filters_json) values (?1, ?2, ?3, ?4, ?5, ?6)",
        id,
        b.url,
        b.description ?? null,
        secret,
        JSON.stringify(b.events),
      ),
      auditStmt(db, actor(c), "webhook.created", id, { url: b.url, events: b.events }),
    ]);
    const row = (await db.first<WebhookRow>(`select ${WH_COLS} from webhook_endpoints where tenant_id = ?1 and id = ?2`, id))!;
    return c.json({ ...whOut(row), secret }, 201);
  },
);
platform.openapi(def({ method: "get", path: "/webhooks", tag: "Webhooks", summary: "List endpoints", response: z.array(WebhookOut) }), async (c) =>
  c.json(
    (await scope(c).all<WebhookRow>(`select ${WH_COLS} from webhook_endpoints where tenant_id = ?1 and deleted_at is null order by created_at`)).map(whOut),
    200,
  ),
);
const getWh = async (db: TenantDb, id: string) => {
  const r = await db.first<WebhookRow>(`select ${WH_COLS} from webhook_endpoints where tenant_id = ?1 and id = ?2 and deleted_at is null`, id);
  if (!r) throw notFound("Webhook");
  return r;
};
platform.openapi(def({ method: "get", path: "/webhooks/{id}", tag: "Webhooks", summary: "Get endpoint", params: IdParam, response: WebhookOut }), async (c) =>
  c.json(whOut(await getWh(scope(c), c.req.valid("param").id)), 200),
);
platform.openapi(
  def({
    method: "patch",
    path: "/webhooks/{id}",
    tag: "Webhooks",
    summary: "Update endpoint (optimistic concurrency via version)",
    params: IdParam,
    body: z.object({
      version: z.number().int(),
      url: z.string().max(2048).optional(),
      description: z.string().max(200).nullable().optional(),
      events: EventFilters.optional(),
      status: z.enum(["active", "disabled"]).optional(),
    }),
    response: WebhookOut,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = scope(c);
    const cur = await getWh(db, id);
    if (b.url) checkUrl(c, b.url);
    const n = await db.run(
      "update webhook_endpoints set url = coalesce(?4, url), description = case when ?5 = 1 then ?6 else description end, event_filters_json = coalesce(?7, event_filters_json), status = coalesce(?8, status), consecutive_failures = case when ?8 = 'active' then 0 else consecutive_failures end, first_failure_at = case when ?8 = 'active' then null else first_failure_at end, disabled_reason = case when ?8 = 'active' then null when ?8 = 'disabled' then 'disabled by user' else disabled_reason end, version = version + 1 where tenant_id = ?1 and id = ?2 and version = ?3 and deleted_at is null",
      id,
      b.version,
      b.url ?? null,
      b.description !== undefined ? 1 : 0,
      b.description ?? null,
      b.events ? JSON.stringify(b.events) : null,
      b.status ?? null,
    );
    if (!n) throw new AppError(409, "version_conflict", `Webhook was modified (current version ${cur.version})`, { currentVersion: cur.version });
    await db.run(
      "insert into audit_log (tenant_id, id, actor, action, subject, meta_json) values (?1, ?2, ?3, 'webhook.updated', ?4, ?5)",
      newId(),
      actor(c),
      id,
      JSON.stringify(b),
    );
    return c.json(whOut(await getWh(db, id)), 200);
  },
);
platform.openapi(
  def({
    method: "delete",
    path: "/webhooks/{id}",
    tag: "Webhooks",
    summary: "Delete endpoint (soft)",
    params: IdParam,
    response: z.object({ deleted: z.boolean() }),
  }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    await getWh(db, id);
    await db.batch([
      db.stmt("update webhook_endpoints set deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where tenant_id = ?1 and id = ?2", id),
      auditStmt(db, actor(c), "webhook.deleted", id),
    ]);
    return c.json({ deleted: true }, 200);
  },
);
platform.openapi(
  def({
    method: "post",
    path: "/webhooks/{id}/rotate-secret",
    tag: "Webhooks",
    summary: "Rotate signing secret (old one valid for 24h)",
    params: IdParam,
    response: z.object({ secret: z.string(), previousSecretExpiresAt: z.string() }),
  }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    await getWh(db, id);
    const secret = `whsec_${randomToken(24)}`;
    const exp = new Date(Date.now() + 86400_000).toISOString();
    await db.batch([
      db.stmt(
        "update webhook_endpoints set previous_secret = secret, previous_secret_expires_at = ?3, secret = ?4, version = version + 1 where tenant_id = ?1 and id = ?2",
        id,
        exp,
        secret,
      ),
      auditStmt(db, actor(c), "webhook.secret_rotated", id),
    ]);
    return c.json({ secret, previousSecretExpiresAt: exp }, 200);
  },
);
const DeliveryOut = z
  .object({
    id: z.string(),
    event_id: z.string(),
    attempt: z.number(),
    status: z.string(),
    response_status: z.number().nullable(),
    error: z.string().nullable(),
    duration_ms: z.number().nullable(),
    next_attempt_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("WebhookDelivery");
platform.openapi(
  def({
    method: "get",
    path: "/webhooks/{id}/deliveries",
    tag: "Webhooks",
    summary: "Delivery log",
    params: IdParam,
    query: Page.extend({ status: z.enum(["pending", "succeeded", "failed", "dead"]).optional() }),
    response: z.object({ items: z.array(DeliveryOut), nextCursor: z.string().nullable() }).openapi("DeliveryPage"),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const db = scope(c);
    await getWh(db, id);
    return c.json(
      await keyset<z.infer<typeof DeliveryOut>>(
        db,
        "select id, event_id, attempt, status, response_status, error, duration_ms, next_attempt_at, created_at from webhook_deliveries where tenant_id = ?1 and endpoint_id = ?2" +
          (q.status ? " and status = ?3" : ""),
        q.status ? [id, q.status] : [id],
        q.cursor,
        q.limit,
      ),
      200,
    );
  },
);
platform.openapi(
  def({
    method: "post",
    path: "/webhooks/{id}/deliveries/{deliveryId}/replay",
    tag: "Webhooks",
    summary: "Replay a delivery now",
    params: z.object({ id: z.string().max(64), deliveryId: z.string().max(64) }),
    response: DeliveryOut,
  }),
  async (c) => {
    const { id, deliveryId } = c.req.valid("param");
    const db = scope(c);
    const ep = await db.first<EndpointRow>(
      "select id, url, secret, status, consecutive_failures, first_failure_at from webhook_endpoints where tenant_id = ?1 and id = ?2 and deleted_at is null",
      id,
    );
    const d = await db.first<{ event_id: string }>(
      "select event_id from webhook_deliveries where tenant_id = ?1 and id = ?2 and endpoint_id = ?3",
      deliveryId,
      id,
    );
    if (!ep || !d) throw notFound("Delivery");
    if (ep.status !== "active") throw badRequest("Endpoint is disabled; re-enable it first");
    const er = (await db.first<EventRow>(
      "select id, type, version, actor, causation_json, payload_json, created_at, dispatched_at from events where tenant_id = ?1 and id = ?2",
      d.event_id,
    ))!;
    // replay = a fresh attempt series on the same delivery row (attempt counter continues for the audit trail)
    await db.batch([
      db.stmt("update webhook_deliveries set status = 'pending', attempt = 0 where tenant_id = ?1 and id = ?2", deliveryId),
      auditStmt(db, actor(c), "webhook.replayed", deliveryId),
    ]);
    await attemptDelivery(db, deliveryId, rowToEnvelope(db.tenantId, er), ep, Math.random, devHttpHosts(c.env));
    return c.json(
      (await db.first<z.infer<typeof DeliveryOut>>(
        "select id, event_id, attempt, status, response_status, error, duration_ms, next_attempt_at, created_at from webhook_deliveries where tenant_id = ?1 and id = ?2",
        deliveryId,
      ))!,
      200,
    );
  },
);
platform.openapi(
  def({
    method: "post",
    path: "/webhooks/{id}/test",
    tag: "Webhooks",
    summary: "Send a signed test ping to this endpoint",
    params: IdParam,
    response: DeliveryOut,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = scope(c);
    const ep = await db.first<EndpointRow>(
      "select id, url, secret, status, consecutive_failures, first_failure_at from webhook_endpoints where tenant_id = ?1 and id = ?2 and deleted_at is null",
      id,
    );
    if (!ep) throw notFound("Webhook");
    const ob = new Outbox(db);
    const ev = ob.add("job.completed", { jobId: "test-ping", status: "test", qaScore: null, exceptions: 0 }, `test:${actor(c)}`);
    const did = newId();
    await db.batch([
      ...ob.stmts,
      db.stmt("update events set dispatched_at = created_at where tenant_id = ?1 and id = ?2", ev.id),
      db.stmt("insert into webhook_deliveries (tenant_id, id, endpoint_id, event_id) values (?1, ?2, ?3, ?4)", did, id, ev.id),
    ]);
    await attemptDelivery(db, did, ev, { ...ep, status: "active" }, Math.random, devHttpHosts(c.env));
    return c.json(
      (await db.first<z.infer<typeof DeliveryOut>>(
        "select id, event_id, attempt, status, response_status, error, duration_ms, next_attempt_at, created_at from webhook_deliveries where tenant_id = ?1 and id = ?2",
        did,
      ))!,
      200,
    );
  },
);

// ---------------- automations ----------------
const AutomationOut = z
  .object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    version: z.number(),
    trigger: z.string(),
    definition: z.record(z.string(), z.unknown()),
    created_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi("Automation");
type ARow = AutomationRow & { trigger_event: string; version: number; created_at: string; deleted_at: string | null };
const A_COLS = "id, name, definition_json, enabled, trigger_event, version, created_at, deleted_at";
const aOut = (r: ARow) => ({
  id: r.id,
  name: r.name,
  enabled: !!r.enabled,
  version: r.version,
  trigger: r.trigger_event,
  definition: JSON.parse(r.definition_json) as Record<string, unknown>,
  created_at: r.created_at,
  deleted_at: r.deleted_at,
});
const parseOr400 = (input: unknown) => {
  const p = parseAutomation(input);
  if (!p.ok) throw new AppError(400, "validation_failed", "Invalid automation", { errors: p.errors });
  return p.value;
};
platform.use("/automations", async (c, next) => (c.req.method === "GET" ? next() : owner(c, next)));
platform.use("/automations/*", async (c, next) => (c.req.method === "GET" || c.req.path.endsWith("/dry-run") ? next() : owner(c, next)));
platform.openapi(
  def({
    method: "get",
    path: "/automations/templates",
    tag: "Automations",
    summary: "Starter templates",
    response: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  (c) =>
    c.json(
      TEMPLATES.map((t) => ({ id: t.id, title: t.title })),
      200,
    ),
);
async function createAutomation(c: C, def0: ReturnType<typeof parseOr400>) {
  const db = scope(c);
  const n = (await db.first<{ n: number }>("select count(*) n from automations where tenant_id = ?1 and deleted_at is null"))?.n ?? 0;
  if (n >= 100) throw badRequest("At most 100 automations per tenant");
  const id = newId();
  await db.batch([
    db.stmt(
      "insert into automations (tenant_id, id, name, trigger_event, definition_json, enabled, created_by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      id,
      def0.name,
      def0.trigger.event,
      JSON.stringify(def0),
      def0.enabled ? 1 : 0,
      actor(c),
    ),
    auditStmt(db, actor(c), "automation.created", id, { name: def0.name, trigger: def0.trigger.event }),
  ]);
  return aOut((await db.first<ARow>(`select ${A_COLS} from automations where tenant_id = ?1 and id = ?2`, id))!);
}
platform.openapi(
  def({
    method: "post",
    path: "/automations",
    tag: "Automations",
    summary: "Create automation (JSON definition)",
    body: z.record(z.string(), z.unknown()),
    response: AutomationOut,
    status: 201,
  }),
  async (c) => c.json(await createAutomation(c, parseOr400(c.req.valid("json"))), 201),
);
platform.openapi(
  def({
    method: "post",
    path: "/automations/from-template",
    tag: "Automations",
    summary: "Create from a template",
    body: z.object({ templateId: z.string(), params: z.record(z.string(), z.string().max(80)).default({}) }),
    response: AutomationOut,
    status: 201,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const t = TEMPLATES.find((x) => x.id === b.templateId);
    if (!t) throw notFound("Template");
    return c.json(await createAutomation(c, parseOr400(t.build(b.params))), 201);
  },
);
platform.openapi(
  def({
    method: "get",
    path: "/automations",
    tag: "Automations",
    summary: "List automations",
    query: z.object({ includeDeleted: z.enum(["true", "false"]).optional() }),
    response: z.array(AutomationOut),
  }),
  async (c) =>
    c.json(
      (
        await scope(c).all<ARow>(
          `select ${A_COLS} from automations where tenant_id = ?1${c.req.valid("query").includeDeleted === "true" ? "" : " and deleted_at is null"} order by created_at`,
        )
      ).map(aOut),
      200,
    ),
);
const getA = async (db: TenantDb, id: string, withDeleted = false) => {
  const r = await db.first<ARow>(`select ${A_COLS} from automations where tenant_id = ?1 and id = ?2${withDeleted ? "" : " and deleted_at is null"}`, id);
  if (!r) throw notFound("Automation");
  return r;
};
platform.openapi(
  def({ method: "get", path: "/automations/{id}", tag: "Automations", summary: "Get automation", params: IdParam, response: AutomationOut }),
  async (c) => c.json(aOut(await getA(scope(c), c.req.valid("param").id)), 200),
);
platform.openapi(
  def({
    method: "put",
    path: "/automations/{id}",
    tag: "Automations",
    summary: "Replace definition (requires current version)",
    params: IdParam,
    body: z.object({ version: z.number().int(), definition: z.record(z.string(), z.unknown()) }),
    response: AutomationOut,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = scope(c);
    const cur = await getA(db, id);
    const d = parseOr400(b.definition);
    const n = await db.run(
      "update automations set name = ?4, trigger_event = ?5, definition_json = ?6, enabled = ?7, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where tenant_id = ?1 and id = ?2 and version = ?3 and deleted_at is null",
      id,
      b.version,
      d.name,
      d.trigger.event,
      JSON.stringify(d),
      d.enabled ? 1 : 0,
    );
    if (!n) throw new AppError(409, "version_conflict", `Automation was modified (current version ${cur.version})`, { currentVersion: cur.version });
    await db.run("insert into audit_log (tenant_id, id, actor, action, subject) values (?1, ?2, ?3, 'automation.updated', ?4)", newId(), actor(c), id);
    return c.json(aOut(await getA(db, id)), 200);
  },
);
platform.openapi(
  def({ method: "delete", path: "/automations/{id}", tag: "Automations", summary: "Soft-delete", params: IdParam, response: AutomationOut }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    await getA(db, id);
    await db.batch([
      db.stmt("update automations set deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 where tenant_id = ?1 and id = ?2", id),
      auditStmt(db, actor(c), "automation.deleted", id),
    ]);
    return c.json(aOut(await getA(db, id, true)), 200);
  },
);
platform.openapi(
  def({
    method: "post",
    path: "/automations/{id}/restore",
    tag: "Automations",
    summary: "Restore a soft-deleted automation",
    params: IdParam,
    response: AutomationOut,
  }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    const r = await getA(db, id, true);
    if (!r.deleted_at) throw badRequest("Automation is not deleted");
    await db.batch([
      db.stmt("update automations set deleted_at = null, version = version + 1 where tenant_id = ?1 and id = ?2", id),
      auditStmt(db, actor(c), "automation.restored", id),
    ]);
    return c.json(aOut(await getA(db, id)), 200);
  },
);
platform.openapi(
  def({
    method: "post",
    path: "/automations/{id}/dry-run",
    tag: "Automations",
    summary: "Test an automation against a stored event or a sample payload (no side effects)",
    params: IdParam,
    body: z.object({ eventId: z.string().max(64).optional(), sample: z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }).optional() }),
    response: z.object({
      matched: z.boolean(),
      skipped: z.string().nullable(),
      failedCondition: z.number().nullable(),
      actions: z.array(z.object({ index: z.number(), type: z.string(), outcome: z.string() })),
    }),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = scope(c);
    const a = await getA(db, id);
    let ev;
    if (b.eventId) {
      const er = await db.first<EventRow>(
        "select id, type, version, actor, causation_json, payload_json, created_at, dispatched_at from events where tenant_id = ?1 and id = ?2",
        b.eventId,
      );
      if (!er) throw notFound("Event");
      ev = rowToEnvelope(db.tenantId, er);
    } else if (b.sample) {
      if (!isEventType(b.sample.type)) throw badRequest("Unknown event type");
      try {
        ev = makeEvent(b.sample.type, b.sample.data as never, {
          id: `dry-${newId()}`,
          tenantId: db.tenantId,
          occurredAt: new Date().toISOString(),
          actor: "dry-run",
        });
      } catch (e) {
        throw badRequest((e as Error).message);
      }
    } else throw badRequest("Provide eventId or sample");
    const r = await runAutomation(db, { ...a, enabled: 1 }, ev, true);
    return c.json(
      {
        matched: r.plan.matched,
        skipped: r.plan.skipped ?? null,
        failedCondition: r.plan.failedCondition ?? null,
        actions: r.results.map((x) => ({ index: x.index, type: x.type, outcome: x.outcome })),
      },
      200,
    );
  },
);
const RunOut = z
  .object({
    id: z.string(),
    event_id: z.string(),
    dry_run: z.number(),
    status: z.string(),
    skipped_reason: z.string().nullable(),
    result: z.record(z.string(), z.unknown()).nullable(),
    created_at: z.string(),
  })
  .openapi("AutomationRun");
platform.openapi(
  def({
    method: "get",
    path: "/automations/{id}/runs",
    tag: "Automations",
    summary: "Run history",
    params: IdParam,
    query: Page,
    response: z.object({ items: z.array(RunOut), nextCursor: z.string().nullable() }).openapi("RunPage"),
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const db = scope(c);
    await getA(db, id, true);
    const p = await keyset<{
      id: string;
      event_id: string;
      dry_run: number;
      status: string;
      skipped_reason: string | null;
      result_json: string | null;
      created_at: string;
    }>(
      db,
      "select id, event_id, dry_run, status, skipped_reason, result_json, created_at from automation_runs where tenant_id = ?1 and automation_id = ?2",
      [id],
      q.cursor,
      q.limit,
    );
    return c.json(
      {
        items: p.items.map(({ result_json, ...r }) => ({ ...r, result: result_json ? (JSON.parse(result_json) as Record<string, unknown>) : null })),
        nextCursor: p.nextCursor,
      },
      200,
    );
  },
);

// ---------------- API keys ----------------
const KeyOut = z
  .object({
    id: z.string(),
    prefix: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    revoked_at: z.string().nullable(),
    key: z.string().optional(),
    project_id: z.string().nullable().openapi({ description: "Agent review project the key is bound to (null = whole tenant)" }),
  })
  .openapi("ApiKey");
type KRow = {
  id: string;
  prefix: string;
  name: string;
  scopes_json: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  project_id: string | null;
};
const K_COLS = "id, prefix, name, scopes_json, created_at, last_used_at, expires_at, revoked_at, project_id";
const kOut = ({ scopes_json, ...r }: KRow) => ({ ...r, scopes: JSON.parse(scopes_json) as string[] });
const KeyIn = z.object({
  name: z.string().min(1).max(60),
  scopes: z.array(z.enum(SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(730).optional(),
  /** Bind the key to one agent review project: it can then only see and create requests there. */
  projectId: z.string().max(64).optional(),
});
platform.use("/api-keys", owner);
platform.use("/api-keys/*", owner);
async function issueKey(c: C, b: z.infer<typeof KeyIn>, replaces?: string) {
  const db = scope(c);
  const k = await generateApiKey(c.env.ENVIRONMENT === "production" ? "live" : "test");
  const id = newId();
  const exp = b.expiresInDays ? new Date(Date.now() + b.expiresInDays * 86400_000).toISOString() : null;
  if (b.projectId && !(await db.first("select 1 from review_projects where tenant_id = ?1 and id = ?2 and archived_at is null", b.projectId)))
    throw notFound("Project");
  const stmts = [
    db.stmt(
      "insert into api_keys (tenant_id, id, prefix, key_hash, name, scopes_json, created_by, expires_at, project_id) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      id,
      k.prefix,
      k.hash,
      b.name,
      JSON.stringify(b.scopes),
      actor(c),
      exp,
      b.projectId ?? null,
    ),
    auditStmt(db, actor(c), replaces ? "api_key.rotated" : "api_key.created", id, {
      name: b.name,
      scopes: b.scopes,
      prefix: k.prefix,
      projectId: b.projectId ?? null,
    }),
  ];
  if (replaces)
    // grace window: old key keeps working for 24h so deploys can roll over
    stmts.push(
      db.stmt(
        "update api_keys set revoked_at = ?3, replaced_by = ?4 where tenant_id = ?1 and id = ?2 and revoked_at is null",
        replaces,
        new Date(Date.now() + 86400_000).toISOString(),
        id,
      ),
    );
  await db.batch(stmts);
  return { ...kOut((await db.first<KRow>(`select ${K_COLS} from api_keys where tenant_id = ?1 and id = ?2`, id))!), key: k.key };
}
platform.openapi(
  def({ method: "post", path: "/api-keys", tag: "API keys", summary: "Create a scoped API key (shown once)", body: KeyIn, response: KeyOut, status: 201 }),
  async (c) => {
    if (c.get("principal").apiKey) throw new AppError(403, "forbidden", "API keys cannot mint API keys");
    return c.json(await issueKey(c, c.req.valid("json")), 201);
  },
);
platform.openapi(
  def({ method: "get", path: "/api-keys", tag: "API keys", summary: "List keys (never returns secrets)", response: z.array(KeyOut) }),
  async (c) => c.json((await scope(c).all<KRow>(`select ${K_COLS} from api_keys where tenant_id = ?1 order by created_at`)).map(kOut), 200),
);
platform.openapi(
  def({
    method: "post",
    path: "/api-keys/{id}/rotate",
    tag: "API keys",
    summary: "Rotate: new key now, old key valid 24h",
    params: IdParam,
    response: KeyOut,
    status: 201,
  }),
  async (c) => {
    const db = scope(c);
    const old = await db.first<KRow>(`select ${K_COLS} from api_keys where tenant_id = ?1 and id = ?2 and revoked_at is null`, c.req.valid("param").id);
    if (!old) throw notFound("API key");
    return c.json(
      await issueKey(c, { name: old.name, scopes: JSON.parse(old.scopes_json), ...(old.project_id ? { projectId: old.project_id } : {}) }, old.id),
      201,
    );
  },
);
platform.openapi(
  def({ method: "delete", path: "/api-keys/{id}", tag: "API keys", summary: "Revoke immediately", params: IdParam, response: KeyOut }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    // Stamp with the same (isolate) clock that apiKeyAuth compares against: SQLite/D1 'now' can run ahead of it
    // (measured up to 2 ms on Windows), which left a just-revoked key usable for that window.
    const n = await db.run("update api_keys set revoked_at = ?3 where tenant_id = ?1 and id = ?2", id, new Date().toISOString());
    if (!n) throw notFound("API key");
    await db.run("insert into audit_log (tenant_id, id, actor, action, subject) values (?1, ?2, ?3, 'api_key.revoked', ?4)", newId(), actor(c), id);
    return c.json(kOut((await db.first<KRow>(`select ${K_COLS} from api_keys where tenant_id = ?1 and id = ?2`, id))!), 200);
  },
);

// ---------------- inbound triggers ----------------
platform.use("/triggers", owner);
platform.use("/triggers/*", owner);
const TriggerOut = z
  .object({ id: z.string(), name: z.string(), url: z.string(), created_at: z.string(), revoked_at: z.string().nullable(), secret: z.string().optional() })
  .openapi("InboundTrigger");
const tOut = (r: { id: string; name: string; created_at: string; revoked_at: string | null }) => ({ ...r, url: `/hooks/inbound/${r.id}` });
platform.openapi(
  def({
    method: "post",
    path: "/triggers",
    tag: "Automations",
    summary: "Create an inbound webhook trigger (secret shown once)",
    body: z.object({ name: z.string().min(1).max(60) }),
    response: TriggerOut,
    status: 201,
  }),
  async (c) => {
    const db = scope(c);
    const id = newId();
    const secret = `trsec_${randomToken(24)}`;
    await db.batch([
      db.stmt("insert into inbound_triggers (tenant_id, id, name, secret) values (?1, ?2, ?3, ?4)", id, c.req.valid("json").name, secret),
      auditStmt(db, actor(c), "trigger.created", id),
    ]);
    return c.json(
      {
        ...tOut(
          (await db.first<{ id: string; name: string; created_at: string; revoked_at: string | null }>(
            "select id, name, created_at, revoked_at from inbound_triggers where tenant_id = ?1 and id = ?2",
            id,
          ))!,
        ),
        secret,
      },
      201,
    );
  },
);
platform.openapi(def({ method: "get", path: "/triggers", tag: "Automations", summary: "List inbound triggers", response: z.array(TriggerOut) }), async (c) =>
  c.json(
    (
      await scope(c).all<{ id: string; name: string; created_at: string; revoked_at: string | null }>(
        "select id, name, created_at, revoked_at from inbound_triggers where tenant_id = ?1 order by created_at",
      )
    ).map(tOut),
    200,
  ),
);
platform.openapi(
  def({
    method: "delete",
    path: "/triggers/{id}",
    tag: "Automations",
    summary: "Revoke trigger",
    params: IdParam,
    response: z.object({ revoked: z.boolean() }),
  }),
  async (c) => {
    const n = await scope(c).run(
      "update inbound_triggers set revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where tenant_id = ?1 and id = ?2 and revoked_at is null",
      c.req.valid("param").id,
    );
    if (!n) throw notFound("Trigger");
    return c.json({ revoked: true }, 200);
  },
);

// ---------------- search ----------------
platform.openapi(
  def({
    method: "get",
    path: "/search",
    tag: "Search",
    summary: "Full-text search over transactions and invoices",
    query: z.object({
      q: z.string().min(1).max(200),
      kind: z.enum(["transaction", "invoice"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
    response: z.object({ items: z.array(z.object({ kind: z.string(), id: z.string(), snippet: z.string() })) }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const fts = ftsQuery(q.q);
    if (!fts) return c.json({ items: [] }, 200);
    const rows = await scope(c).all<{ kind: string; ref_id: string; snippet: string }>(
      `select kind, ref_id, snippet(search_index, 3, '[', ']', '…', 8) as snippet from search_index where tenant_id = ?1 and search_index match ?2${q.kind ? " and kind = ?3" : ""} order by rank limit ${q.limit}`,
      fts,
      ...(q.kind ? [q.kind] : []),
    );
    return c.json({ items: rows.map((r) => ({ kind: r.kind, id: r.ref_id, snippet: r.snippet })) }, 200);
  },
);

// ---------------- bulk ----------------
const BulkItem = z.object({
  id: z.string().min(1).max(64),
  categoryCode: z.string().min(1).max(10),
  vatRateCode: z.enum(["STD", "RED", "ZERO", "EXEMPT", "OUTSIDE"]).nullable().default(null),
  vatPence: z.number().int().min(0).default(0),
});
platform.openapi(
  def({
    method: "post",
    path: "/transactions/bulk-categorise",
    tag: "Transactions",
    summary: "Categorise up to 200 transactions; partial success, per-item results",
    body: z.object({ items: z.array(BulkItem).min(1).max(200) }),
    response: z
      .object({
        succeeded: z.number(),
        failed: z.number(),
        results: z.array(z.object({ id: z.string(), status: z.number(), error: z.object({ code: z.string(), message: z.string() }).optional() })),
      })
      .openapi("BulkResult"),
  }),
  async (c) => {
    const db = scope(c);
    const results = [];
    const seen = new Set<string>();
    const outbox = new Outbox(db);
    for (const it of c.req.valid("json").items) {
      if (seen.has(it.id)) {
        results.push({ id: it.id, status: 409, error: { code: "conflict", message: "Duplicate id in request" } });
        continue;
      }
      seen.add(it.id);
      try {
        await categoriseTransaction(db, actor(c), it.id, it.categoryCode, it.vatRateCode, it.vatPence, { outbox, method: "bulk" });
        results.push({ id: it.id, status: 200 });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError(500, "internal", "Internal error");
        results.push({ id: it.id, status: err.status, error: { code: err.code, message: err.message } });
      }
    }
    await outbox.publish(c.env);
    const ok = results.filter((r) => r.status === 200).length;
    return c.json({ succeeded: ok, failed: results.length - ok, results }, 200);
  },
);

// ---------------- invoices: get/patch (ETag + If-Match), soft delete, restore ----------------
type InvRow = {
  id: string;
  number: string;
  customer_name: string;
  customer_email: string | null;
  issue_date: string;
  due_date: string;
  status: string;
  net_pence: number;
  vat_pence: number;
  gross_pence: number;
  lines_json: string;
  version: number;
  deleted_at: string | null;
};
const INV_COLS = "id, number, customer_name, customer_email, issue_date, due_date, status, net_pence, vat_pence, gross_pence, lines_json, version, deleted_at";
const InvoiceV = z
  .object({
    id: z.string(),
    number: z.string(),
    customer_name: z.string(),
    customer_email: z.string().nullable(),
    issue_date: z.string(),
    due_date: z.string(),
    status: z.string(),
    net_pence: z.number(),
    vat_pence: z.number(),
    gross_pence: z.number(),
    lines_json: z.string(),
    version: z.number(),
    deleted_at: z.string().nullable(),
  })
  .openapi("InvoiceVersioned");
const getInv = async (db: TenantDb, id: string, withDeleted = false) => {
  const r = await db.first<InvRow>(`select ${INV_COLS} from invoices where tenant_id = ?1 and id = ?2${withDeleted ? "" : " and deleted_at is null"}`, id);
  if (!r) throw notFound("Invoice");
  return r;
};
platform.openapi(
  def({
    method: "get",
    path: "/invoices/{id}",
    tag: "Invoices",
    summary: "Get invoice (ETag; send If-None-Match for 304)",
    params: IdParam,
    response: InvoiceV,
  }),
  async (c) => {
    const r = await getInv(scope(c), c.req.valid("param").id);
    const tag = etagFor(r.id, r.version);
    c.header("etag", tag);
    if (ifNoneMatchHits(c.req.header("if-none-match"), tag)) return c.body(null, 304) as never;
    return c.json(r, 200);
  },
);
platform.openapi(
  def({
    method: "patch",
    path: "/invoices/{id}",
    tag: "Invoices",
    summary: "Edit a draft invoice (If-Match or version required)",
    params: IdParam,
    body: z.object({
      version: z.number().int().optional(),
      customerName: z.string().min(1).max(120).optional(),
      customerEmail: z.string().email().nullable().optional(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    response: InvoiceV,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = scope(c);
    const cur = await getInv(db, id);
    const ifMatch = c.req.header("if-match");
    if (!ifMatch && b.version === undefined) throw new AppError(428 as 400, "precondition_failed", "Send If-Match or version to edit an invoice");
    if (ifMatchFails(ifMatch, etagFor(cur.id, cur.version)))
      throw new AppError(412, "precondition_failed", "Invoice changed since you fetched it", { currentVersion: cur.version });
    if (cur.status !== "draft") throw new AppError(409, "conflict", `Only draft invoices can be edited (status ${cur.status})`);
    if (b.dueDate && b.dueDate < cur.issue_date) throw badRequest("dueDate is before issueDate");
    const expected = b.version ?? cur.version;
    const n = await db.run(
      "update invoices set customer_name = coalesce(?4, customer_name), customer_email = case when ?5 = 1 then ?6 else customer_email end, due_date = coalesce(?7, due_date), version = version + 1 where tenant_id = ?1 and id = ?2 and version = ?3 and status = 'draft' and deleted_at is null",
      id,
      expected,
      b.customerName ?? null,
      b.customerEmail !== undefined ? 1 : 0,
      b.customerEmail ?? null,
      b.dueDate ?? null,
    );
    if (!n) throw new AppError(409, "version_conflict", `Invoice was modified (current version ${cur.version})`, { currentVersion: cur.version });
    await db.run(
      "insert into audit_log (tenant_id, id, actor, action, subject, meta_json) values (?1, ?2, ?3, 'invoice.updated', ?4, ?5)",
      newId(),
      actor(c),
      id,
      JSON.stringify(b),
    );
    const r = await getInv(db, id);
    c.header("etag", etagFor(r.id, r.version));
    return c.json(r, 200);
  },
);
platform.openapi(
  def({ method: "delete", path: "/invoices/{id}", tag: "Invoices", summary: "Soft-delete a draft or void invoice", params: IdParam, response: InvoiceV }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    const cur = await getInv(db, id);
    if (!["draft", "void"].includes(cur.status)) throw new AppError(409, "conflict", "Only draft or void invoices can be deleted; void it first");
    await db.batch([
      db.stmt("update invoices set deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 where tenant_id = ?1 and id = ?2", id),
      auditStmt(db, actor(c), "invoice.deleted", id),
    ]);
    return c.json(await getInv(db, id, true), 200);
  },
);
platform.openapi(
  def({ method: "post", path: "/invoices/{id}/restore", tag: "Invoices", summary: "Restore a soft-deleted invoice", params: IdParam, response: InvoiceV }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    const cur = await getInv(db, id, true);
    if (!cur.deleted_at) throw badRequest("Invoice is not deleted");
    await db.batch([
      db.stmt("update invoices set deleted_at = null, version = version + 1 where tenant_id = ?1 and id = ?2", id),
      auditStmt(db, actor(c), "invoice.restored", id),
    ]);
    return c.json(await getInv(db, id), 200);
  },
);

// ---------------- usage, flags, realtime ----------------
platform.openapi(
  def({
    method: "get",
    path: "/usage",
    tag: "Billing",
    summary: "This month's metered usage vs plan quota",
    response: z.object({
      period: z.string(),
      plan: z.string(),
      metrics: z.array(z.object({ metric: z.string(), used: z.number(), limit: z.number(), remaining: z.number() })),
    }),
  }),
  async (c) => {
    const db = scope(c);
    const planRaw = (await db.tenantRowStmt("plan").first<{ plan: string | null }>())?.plan ?? "free";
    const plan = planRaw === "trial" ? "starter" : planRaw;
    const rows = await db.all<{ metric: string; count: number }>("select metric, count from usage_counters where tenant_id = ?1 and period = ?2", period());
    const used = new Map(rows.map((r) => [r.metric, r.count]));
    const metrics = Object.keys(PLAN_QUOTAS.free!).map((m) => {
      const u = used.get(m) ?? 0;
      const q = quotaCheck(plan, m, u, 0);
      return { metric: m, used: u, limit: q.limit, remaining: q.remaining };
    });
    return c.json({ period: period(), plan, metrics }, 200);
  },
);
platform.openapi(
  def({ method: "get", path: "/flags", tag: "Account", summary: "Feature flags effective for this tenant", response: z.record(z.string(), z.boolean()) }),
  async (c) => {
    const flags = parseFlags(await c.env.CONFIG.get("flags"));
    const t = c.get("principal").tenantId;
    return c.json(Object.fromEntries(Object.keys(flags).map((k) => [k, isEnabled(flags, k, t)])), 200);
  },
);
platform.get("/realtime", async (c) => {
  if (!c.env.REALTIME) {
    c.header("retry-after", "30");
    return c.json(
      { error: { code: "not_implemented", message: "Realtime is not bound in this environment; poll GET /v1/events instead", requestId: c.get("requestId") } },
      503,
    );
  }
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(c.get("principal").tenantId));
  const u = new URL(c.req.url);
  return stub.fetch(`https://realtime/connect?types=${encodeURIComponent(u.searchParams.get("types") ?? "")}`, {
    headers: c.req.raw.headers,
    signal: c.req.raw.signal,
  });
});
platform.openAPIRegistry.registerPath({
  method: "get",
  path: "/realtime",
  tags: ["Events"],
  summary: "Live event stream (SSE, or WebSocket with Upgrade); ?types=transaction.*",
  security: [{ accessJwt: [] }],
  responses: { 200: { description: "text/event-stream" }, 503: { description: "Not bound here: poll /v1/events" } },
});
