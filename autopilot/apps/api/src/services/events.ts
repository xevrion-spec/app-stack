import { makeEvent, type EventEnvelope, type EventPayload, type EventType } from "@xevrion/platform";
import type { Env } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { log } from "../lib/log.js";
import { monotonicIso } from "../lib/audit.js";

/**
 * Transactional outbox: callers add `stmt` to the SAME db.batch as the state change, so an event exists iff the change
 * committed. After commit, `publish` nudges the dispatcher via the queue; the scheduled sweeper re-publishes anything a
 * crash left undispatched (at-least-once; consumers are idempotent).
 */
function eventStmt<T extends EventType>(db: TenantDb, type: T, data: EventPayload<T>, actor: string, causationChain: string[] = []) {
  const ev = makeEvent(type, data, { id: newId(), tenantId: db.tenantId, occurredAt: monotonicIso(), actor, causationChain });
  const stmt = db.stmt(
    "insert into events (tenant_id, id, type, version, actor, causation_json, payload_json, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ev.id,
    ev.type,
    ev.version,
    ev.actor,
    JSON.stringify(ev.causationChain),
    JSON.stringify(ev.data),
    ev.occurredAt,
  );
  return { ev, stmt };
}

/** Collects events during a request; `stmts` go into the batch, `publish` runs after it commits. */
export class Outbox {
  readonly events: EventEnvelope[] = [];
  readonly stmts: D1PreparedStatement[] = [];
  constructor(private readonly db: TenantDb) {}
  add<T extends EventType>(type: T, data: EventPayload<T>, actor: string, causationChain: string[] = []) {
    const { ev, stmt } = eventStmt(this.db, type, data, actor, causationChain);
    this.events.push(ev);
    this.stmts.push(stmt);
    return ev;
  }
  async publish(env: Env): Promise<void> {
    await publish(
      env,
      this.db.tenantId,
      this.events.map((e) => e.id),
    );
  }
}

export async function publish(env: Env, tenantId: string, eventIds: string[]): Promise<void> {
  if (!eventIds.length) return;
  try {
    // chunk to stay well under queue message size limits
    for (let i = 0; i < eventIds.length; i += 100) await env.PIPELINE.send({ kind: "events", tenantId, eventIds: eventIds.slice(i, i + 100) });
  } catch (e) {
    // Graceful degradation: events are durable in the outbox; the sweeper will pick them up.
    log("warn", "events.publish_failed", { tenantId, n: eventIds.length, err: String(e) });
  }
}

export interface EventRow {
  id: string;
  type: string;
  version: number;
  actor: string;
  causation_json: string;
  payload_json: string;
  created_at: string;
  dispatched_at: string | null;
}
export const rowToEnvelope = (tenantId: string, r: EventRow): EventEnvelope =>
  ({
    id: r.id,
    type: r.type,
    version: r.version,
    tenantId,
    occurredAt: r.created_at,
    actor: r.actor,
    causationChain: JSON.parse(r.causation_json),
    data: JSON.parse(r.payload_json),
  }) as EventEnvelope;
