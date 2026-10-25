import type { Context } from "hono";
import { SIGNATURE_HEADER, verifySignature } from "@xevrion/platform";
import type { AppEnv } from "../env.js";
import { TenantDb } from "../lib/db.js";
import { AppError, notFound } from "../lib/errors.js";
import { Outbox } from "../services/events.js";

/**
 * POST /hooks/inbound/:id with `Autopilot-Signature: t=..,v1=hmac(secret, "t.body")`. Unauthenticated by design (the
 * signature is the auth); responds 404 for unknown AND revoked triggers so ids can't be probed. Body <= 16 KB JSON object.
 */
export async function inboundHook(c: Context<AppEnv>) {
  const id = c.req.param("id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Trigger");
  const row = await c.env.DB.prepare("select tenant_id, id, name, secret from inbound_triggers where id = ?1 and revoked_at is null")
    .bind(id)
    .first<{ tenant_id: string; id: string; name: string; secret: string }>();
  if (!row) throw notFound("Trigger");
  const body = await c.req.text();
  if (body.length > 16_384) throw new AppError(413, "payload_too_large", "Inbound payload over 16 KB");
  const v = await verifySignature([row.secret], c.req.header(SIGNATURE_HEADER), body, Math.floor(Date.now() / 1000));
  if (!v.ok) throw new AppError(401, "unauthenticated", `Signature ${v.reason}`);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new AppError(400, "bad_request", "Body must be JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AppError(400, "bad_request", "Body must be a JSON object");
  const db = new TenantDb(c.env.DB, row.tenant_id);
  const ob = new Outbox(db);
  const ev = ob.add("trigger.received", { triggerId: row.id, name: row.name, payload: payload as Record<string, unknown> }, `trigger:${row.id}`);
  await db.batch(ob.stmts);
  await ob.publish(c.env);
  return c.json({ accepted: true, eventId: ev.id }, 202);
}
