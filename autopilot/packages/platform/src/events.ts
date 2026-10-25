import { z } from "zod";

/**
 * Versioned event catalog. Event names are stable public contract (`<entity>.<verb>`); payload schemas are versioned and
 * only ever extended additively within a version. Breaking changes get a new version and both are emitted in parallel
 * for one deprecation window.
 */
const id = z.string().min(1).max(64);
const pence = z.number().int();
export const EVENT_CATALOG = {
  "transaction.created": {
    version: 1,
    description: "A bank line was imported",
    schema: z.object({ transactionId: id, jobId: id.nullable(), date: z.string(), description: z.string(), amountPence: pence, currency: z.string() }),
  },
  "transaction.categorised": {
    version: 1,
    description: "A transaction got a category (rule, model, automation or human)",
    schema: z.object({
      transactionId: id,
      categoryCode: z.string(),
      method: z.string(),
      confidence: z.number().min(0).max(1).nullable(),
      description: z.string(),
      amountPence: pence,
    }),
  },
  "invoice.created": {
    version: 1,
    description: "An invoice was issued",
    schema: z.object({ invoiceId: id, number: z.string(), customerName: z.string(), grossPence: pence }),
  },
  "invoice.paid": {
    version: 1,
    description: "An invoice was marked paid (manually or by reconciliation)",
    schema: z.object({ invoiceId: id, number: z.string(), grossPence: pence, transactionId: id.nullable() }),
  },
  "invoice.payment_recorded": {
    version: 1,
    description: "A (possibly partial) payment was recorded against an invoice",
    schema: z.object({ invoiceId: id, number: z.string(), amountPence: pence, outstandingPence: pence }),
  },
  "invoice.credit_note_issued": {
    version: 1,
    description: "A credit note was issued against an invoice",
    schema: z.object({ invoiceId: id, creditNoteId: id, number: z.string(), grossPence: pence }),
  },
  "invoice.reminder_due": {
    version: 1,
    description: "A payment reminder is due (an event only; Autopilot never emails customers itself)",
    schema: z.object({ invoiceId: id, number: z.string(), kind: z.string(), outstandingPence: pence, customerEmail: z.string().nullable() }),
  },
  "invoice.recurring_issued": {
    version: 1,
    description: "A recurring schedule issued a new draft invoice",
    schema: z.object({ invoiceId: id, scheduleId: id, number: z.string(), grossPence: pence }),
  },
  "exception.opened": {
    version: 1,
    description: "Something needs a human decision",
    schema: z.object({ exceptionId: id, reasonCode: z.string(), severity: z.enum(["low", "medium", "high"]), subjectId: id.nullable(), message: z.string() }),
  },
  "exception.resolved": {
    version: 1,
    description: "A reviewer resolved an exception",
    schema: z.object({ exceptionId: id, decision: z.string(), by: z.string() }),
  },
  "job.completed": {
    version: 1,
    description: "A pipeline job finished",
    schema: z.object({ jobId: id, status: z.string(), qaScore: z.number().nullable(), exceptions: z.number().int().nonnegative() }),
  },
  "trigger.received": {
    version: 1,
    description: "A signed inbound webhook arrived on a trigger URL",
    schema: z.object({ triggerId: id, name: z.string(), payload: z.record(z.string(), z.unknown()) }),
  },
  "vat_draft.ready": {
    version: 1,
    description: "A draft VAT return was computed (never submitted)",
    schema: z.object({ draftId: id, periodStart: z.string(), periodEnd: z.string(), box5Pence: pence }),
  },
} as const;

export type EventType = keyof typeof EVENT_CATALOG;
export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_CATALOG)[T]["schema"]>;

export interface EventEnvelope<T extends EventType = EventType> {
  id: string;
  type: T;
  version: number;
  tenantId: string;
  occurredAt: string;
  /** Chain of event ids that caused this one (automation loop protection). */
  causationChain: string[];
  /** Who/what produced it: user email, "pipeline", "automation:<id>", "api_key:<prefix>". */
  actor: string;
  data: EventPayload<T>;
}

export class EventValidationError extends Error {}

export const isEventType = (t: string): t is EventType => Object.prototype.hasOwnProperty.call(EVENT_CATALOG, t);

/** Build a validated envelope. Throws EventValidationError for unknown types or payloads that break the schema. */
export function makeEvent<T extends EventType>(
  type: T,
  data: EventPayload<T>,
  ctx: { id: string; tenantId: string; occurredAt: string; actor: string; causationChain?: string[] },
): EventEnvelope<T> {
  if (!isEventType(type)) throw new EventValidationError(`unknown event type ${String(type)}`);
  const spec = EVENT_CATALOG[type];
  const parsed = spec.schema.safeParse(data);
  if (!parsed.success)
    throw new EventValidationError(`invalid ${type} payload: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  return {
    id: ctx.id,
    type,
    version: spec.version,
    tenantId: ctx.tenantId,
    occurredAt: ctx.occurredAt,
    causationChain: ctx.causationChain ?? [],
    actor: ctx.actor,
    data: parsed.data as EventPayload<T>,
  };
}

/** Public catalog document (served at /v1/events/catalog and in the docs). */
export function catalogDocument() {
  return EVENT_TYPES.map((t) => ({
    type: t,
    version: EVENT_CATALOG[t].version,
    description: EVENT_CATALOG[t].description,
    fields: Object.keys(EVENT_CATALOG[t].schema.shape),
  }));
}

/** Subscription filter: exact type, "*" or "entity.*". */
export function matchesFilter(type: string, filters: string[]): boolean {
  return filters.some((f) => f === "*" || f === type || (f.endsWith(".*") && type.startsWith(f.slice(0, -1))));
}
