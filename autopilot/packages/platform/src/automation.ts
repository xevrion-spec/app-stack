import { z } from "zod";
import { EVENT_TYPES, type EventEnvelope } from "./events.js";

/**
 * Automation engine: trigger (event type) + conditions (all must hold) + actions. Definitions are JSON, validated by zod,
 * evaluated purely (no I/O). The API executes the returned plan idempotently (key = automationId + eventId + action index).
 */
const Path = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/, "dot path like data.amountPence")
  .max(80);
const Scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
export const ConditionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("eq"), path: Path, value: Scalar }),
  z.object({ op: z.literal("neq"), path: Path, value: Scalar }),
  z.object({ op: z.literal("gt"), path: Path, value: z.number() }),
  z.object({ op: z.literal("gte"), path: Path, value: z.number() }),
  z.object({ op: z.literal("lt"), path: Path, value: z.number() }),
  z.object({ op: z.literal("lte"), path: Path, value: z.number() }),
  z.object({ op: z.literal("contains"), path: Path, value: z.string().min(1).max(120) }),
  z.object({ op: z.literal("in"), path: Path, value: z.array(Scalar).min(1).max(50) }),
  z.object({ op: z.literal("exists"), path: Path }),
]);
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("categorise_transaction"),
    categoryCode: z.string().regex(/^\d{4}$/),
    vatRateCode: z.enum(["STD", "RED", "ZERO", "EXEMPT", "OUTSIDE"]).nullable().default(null),
  }),
  z.object({
    type: z.literal("open_exception"),
    reasonCode: z.string().regex(/^[A-Z_]{3,40}$/),
    severity: z.enum(["low", "medium", "high"]),
    message: z.string().min(1).max(300),
  }),
  z.object({ type: z.literal("emit_notification"), channel: z.literal("event"), message: z.string().min(1).max(300) }),
  z.object({ type: z.literal("tag_transaction"), tag: z.string().regex(/^[a-z0-9-]{1,30}$/) }),
]);
export const AutomationDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  trigger: z.object({ event: z.enum(EVENT_TYPES as [string, ...string[]]) }),
  conditions: z.array(ConditionSchema).max(20).default([]),
  actions: z.array(ActionSchema).min(1).max(10),
  enabled: z.boolean().default(true),
  /** Max executions per tenant per hour for this automation. */
  maxRunsPerHour: z.number().int().min(1).max(10_000).default(500),
});
export type AutomationDefinition = z.infer<typeof AutomationDefinitionSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type Action = z.infer<typeof ActionSchema>;

/** Actions that only make sense with a transaction subject. */
const NEEDS_TXN = new Set(["categorise_transaction", "tag_transaction"]);

export function parseAutomation(input: unknown): { ok: true; value: AutomationDefinition } | { ok: false; errors: string[] } {
  const r = AutomationDefinitionSchema.safeParse(input);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const v = r.data;
  const txnTrigger = v.trigger.event.startsWith("transaction.");
  const bad = v.actions.filter((a) => NEEDS_TXN.has(a.type) && !txnTrigger);
  if (bad.length) return { ok: false, errors: bad.map((a) => `actions: ${a.type} requires a transaction.* trigger`) };
  // categorise on transaction.categorised would re-trigger itself forever without loop protection; make it explicit.
  if (v.trigger.event === "transaction.categorised" && v.actions.some((a) => a.type === "categorise_transaction") && !v.conditions.length)
    return { ok: false, errors: ["conditions: re-categorising on transaction.categorised needs at least one condition"] };
  return { ok: true, value: v };
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function evaluateCondition(c: Condition, ctx: unknown): boolean {
  const v = getPath(ctx, c.path);
  switch (c.op) {
    case "exists":
      return v !== undefined && v !== null;
    case "eq":
      return v === c.value;
    case "neq":
      return v !== c.value;
    case "gt":
      return typeof v === "number" && v > c.value;
    case "gte":
      return typeof v === "number" && v >= c.value;
    case "lt":
      return typeof v === "number" && v < c.value;
    case "lte":
      return typeof v === "number" && v <= c.value;
    case "contains":
      return typeof v === "string" && v.toUpperCase().includes(c.value.toUpperCase());
    case "in":
      return c.value.some((x) => x === v);
  }
}

export const LOOP_LIMIT = 3;

export type Skip = "disabled" | "trigger_mismatch" | "conditions_false" | "loop_detected" | "rate_capped";
export interface Plan {
  automationId: string;
  eventId: string;
  matched: boolean;
  skipped?: Skip;
  failedCondition?: number;
  actions: { index: number; idempotencyKey: string; action: Action }[];
}

/**
 * Decide what an automation would do for one event. Pure: callers pass recent run count for rate capping.
 * Loop protection: an event whose causation chain already contains this automation's own output LOOP_LIMIT times, or any
 * chain deeper than 10, is dropped.
 */
export function planAutomation(a: { id: string; def: AutomationDefinition }, ev: EventEnvelope, runsLastHour: number): Plan {
  const base = { automationId: a.id, eventId: ev.id, actions: [] as Plan["actions"] };
  if (!a.def.enabled) return { ...base, matched: false, skipped: "disabled" };
  if (a.def.trigger.event !== ev.type) return { ...base, matched: false, skipped: "trigger_mismatch" };
  const own = ev.actor === `automation:${a.id}` ? 1 : 0;
  const depth = ev.causationChain.length;
  if (depth >= 10 || own + ev.causationChain.filter((c) => c.startsWith(`automation:${a.id}:`)).length >= LOOP_LIMIT)
    return { ...base, matched: false, skipped: "loop_detected" };
  const ctx = { event: { type: ev.type, actor: ev.actor }, data: ev.data };
  const failed = a.def.conditions.findIndex((c) => !evaluateCondition(c, ctx));
  if (failed >= 0) return { ...base, matched: false, skipped: "conditions_false", failedCondition: failed };
  if (runsLastHour >= a.def.maxRunsPerHour) return { ...base, matched: true, skipped: "rate_capped" };
  return { ...base, matched: true, actions: a.def.actions.map((action, index) => ({ index, action, idempotencyKey: `${a.id}:${ev.id}:${index}` })) };
}

/** Starter templates shown in the UI / docs. */
export const TEMPLATES: { id: string; title: string; build: (p: Record<string, string>) => unknown }[] = [
  {
    id: "auto-categorise-merchant",
    title: "Auto-categorise a merchant",
    build: (p) => ({
      name: `Categorise ${p.merchant} as ${p.categoryCode}`,
      trigger: { event: "transaction.created" },
      conditions: [{ op: "contains", path: "data.description", value: p.merchant }],
      actions: [{ type: "categorise_transaction", categoryCode: p.categoryCode, vatRateCode: p.vatRateCode ?? null }],
    }),
  },
  {
    id: "notify-exception-opened",
    title: "Notify (event only) when a high-severity exception opens",
    build: () => ({
      name: "Notify on high-severity exception",
      trigger: { event: "exception.opened" },
      conditions: [{ op: "eq", path: "data.severity", value: "high" }],
      actions: [{ type: "emit_notification", channel: "event", message: "A high-severity exception needs review" }],
    }),
  },
  {
    id: "flag-large-outflow",
    title: "Flag outflows above a threshold for review",
    build: (p) => ({
      name: `Flag outflows over ${p.pounds}`,
      trigger: { event: "transaction.created" },
      conditions: [{ op: "lt", path: "data.amountPence", value: -Math.round(Number(p.pounds) * 100) }],
      actions: [{ type: "open_exception", reasonCode: "LARGE_OUTFLOW", severity: "medium", message: `Outflow above £${p.pounds}` }],
    }),
  },
];
