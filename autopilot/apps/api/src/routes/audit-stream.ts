/** Audit sink management (A10b), owner humans only. The signing secret is shown once, on create or rotate. */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { randomToken, validateWebhookUrl } from "@xevrion/platform";
import type { AppEnv } from "../env.js";
import { def, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { auditStmt } from "../lib/audit.js";
import { AppError, badRequest, notFound } from "../lib/errors.js";
import { devHttpHosts } from "../services/webhooks.js";
import type { SinkRow } from "../services/audit-stream.js";
import { scope } from "./agent-reviews.js";

export const auditStream = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
const ownerHuman: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal").apiKey) throw new AppError(403, "forbidden", "API keys cannot manage audit sinks");
  return requireRole("owner")(c, next);
};
auditStream.use("/agent-review/audit-sink", ownerHuman);
auditStream.use("/agent-review/audit-sink/*", ownerHuman);

const SinkIn = z
  .object({
    url: z.string().url().max(2000),
    format: z.enum(["ndjson", "cef"]).default("ndjson"),
    /** Start from now (default) or replay the whole ledger history. */
    from: z.enum(["now", "beginning"]).default("now"),
  })
  .openapi("AuditSinkIn");
const SinkOut = z
  .object({
    url: z.string(),
    format: z.enum(["ndjson", "cef"]),
    status: z.enum(["active", "paused"]),
    cursor: z.object({ at: z.string(), requestId: z.string(), seq: z.number() }),
    attempt: z.number(),
    nextAttemptAt: z.string().nullable(),
    lastStatus: z.number().nullable(),
    lastError: z.string().nullable(),
    delivered: z.number(),
    lastDeliveredAt: z.string().nullable(),
    secret: z.string().optional().openapi({ description: "HMAC signing secret, returned only on create/rotate" }),
  })
  .openapi("AuditSink");
const out = (s: SinkRow, secret?: string) => ({
  url: s.url,
  format: s.format,
  status: s.status,
  cursor: { at: s.cursor_at, requestId: s.cursor_request, seq: s.cursor_seq },
  attempt: s.attempt,
  nextAttemptAt: s.next_attempt_at || null,
  lastStatus: s.last_status,
  lastError: s.last_error,
  delivered: s.delivered,
  lastDeliveredAt: s.last_delivered_at,
  ...(secret ? { secret } : {}),
});
const load = (db: ReturnType<typeof scope>) => db.first<SinkRow>("select * from audit_sinks where tenant_id = ?1");
const actor = (c: { get: (k: "principal") => { email: string } }) => c.get("principal").email;

auditStream.openapi(
  def({
    method: "put",
    path: "/agent-review/audit-sink",
    tag: "Agent review",
    summary: "Create or replace the tenant's audit sink (signed push of ledger entries, NDJSON or CEF)",
    body: SinkIn,
    response: SinkOut,
  }),
  async (c) => {
    const b = c.req.valid("json");
    const check = validateWebhookUrl(b.url, { allowHttpHosts: devHttpHosts(c.env) });
    if (!check.ok) throw badRequest(`Sink URL not allowed: ${check.reason}`);
    const db = scope(c);
    const t = new Date().toISOString();
    const secret = `whsec_${randomToken(24)}`;
    // "now" = cursor at the newest existing entry; "beginning" = empty cursor (replays everything)
    const head =
      b.from === "now"
        ? await db.first<{ at: string; request_id: string; seq: number }>(
            "select at, request_id, seq from review_ledger where tenant_id = ?1 order by at desc, request_id desc, seq desc limit 1",
          )
        : null;
    await db.batch([
      db.stmt(
        `insert into audit_sinks (tenant_id, url, secret, format, status, cursor_at, cursor_request, cursor_seq, created_by, created_at, updated_at)
         values (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?8, ?9, ?9)
         on conflict(tenant_id) do update set url = excluded.url, secret = excluded.secret, format = excluded.format, status = 'active',
           cursor_at = excluded.cursor_at, cursor_request = excluded.cursor_request, cursor_seq = excluded.cursor_seq, attempt = 0, next_attempt_at = '',
           last_error = null, last_status = null, updated_at = excluded.updated_at`,
        b.url,
        secret,
        b.format,
        head?.at ?? "",
        head?.request_id ?? "",
        head?.seq ?? 0,
        actor(c),
        t,
      ),
      auditStmt(db, actor(c), "audit_sink.configured", "audit_sink", { url: b.url, format: b.format, from: b.from }),
    ]);
    return c.json(out((await load(db))!, secret), 200);
  },
);
auditStream.openapi(
  def({ method: "get", path: "/agent-review/audit-sink", tag: "Agent review", summary: "Audit sink status and cursor", response: SinkOut }),
  async (c) => {
    const s = await load(scope(c));
    if (!s) throw notFound("Audit sink");
    return c.json(out(s), 200);
  },
);
auditStream.openapi(
  def({
    method: "post",
    path: "/agent-review/audit-sink/resume",
    tag: "Agent review",
    summary: "Resume a paused sink from its cursor (nothing is skipped)",
    response: SinkOut,
  }),
  async (c) => {
    const db = scope(c);
    const s = await load(db);
    if (!s) throw notFound("Audit sink");
    await db.batch([
      db.stmt("update audit_sinks set status = 'active', attempt = 0, next_attempt_at = '', updated_at = ?2 where tenant_id = ?1", new Date().toISOString()),
      auditStmt(db, actor(c), "audit_sink.resumed", "audit_sink"),
    ]);
    return c.json(out((await load(db))!), 200);
  },
);
auditStream.openapi(
  def({
    method: "post",
    path: "/agent-review/audit-sink/rotate-secret",
    tag: "Agent review",
    summary: "Rotate the signing secret (returned once)",
    response: SinkOut,
  }),
  async (c) => {
    const db = scope(c);
    if (!(await load(db))) throw notFound("Audit sink");
    const secret = `whsec_${randomToken(24)}`;
    await db.batch([
      db.stmt("update audit_sinks set secret = ?2, updated_at = ?3 where tenant_id = ?1", secret, new Date().toISOString()),
      auditStmt(db, actor(c), "audit_sink.secret_rotated", "audit_sink"),
    ]);
    return c.json(out((await load(db))!, secret), 200);
  },
);
auditStream.openapi(
  def({
    method: "delete",
    path: "/agent-review/audit-sink",
    tag: "Agent review",
    summary: "Remove the audit sink",
    response: z.object({ deleted: z.boolean() }),
  }),
  async (c) => {
    const db = scope(c);
    if (!(await load(db))) throw notFound("Audit sink");
    await db.batch([db.stmt("delete from audit_sinks where tenant_id = ?1"), auditStmt(db, actor(c), "audit_sink.deleted", "audit_sink")]);
    return c.json({ deleted: true }, 200);
  },
);
