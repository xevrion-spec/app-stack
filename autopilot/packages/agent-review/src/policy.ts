import { z } from "zod";
import { RISK_LEVELS, type RiskLevel } from "./schemas.js";

/**
 * Policy-as-code for routing review requests. Rules are evaluated in order and the first match wins.
 * Hard guardrails apply regardless of what a policy says (they are enforced here and at save time):
 *  - critical risk is never auto-approved and always needs at least 2 approvers;
 *  - an auto_approve rule must state minConfidence >= 0.5, and the request must carry a confidence at or above it;
 *  - callers may raise the approver count (minApprovals) but never lower it.
 */
const PAYLOAD_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "exists"] as const;
const Cond = z.object({
  path: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "dot path, e.g. amount or customer.tier"),
  op: z.enum(PAYLOAD_OPS),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]).optional(),
});
const When = z
  .object({
    /** Action glob: "refund.*", "email.send", "*". */
    action: z.string().max(120).optional(),
    risk: z.array(z.enum(RISK_LEVELS)).min(1).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    maxConfidence: z.number().min(0).max(1).optional(),
    tagsAny: z.array(z.string().max(40)).max(20).optional(),
    payload: z.array(Cond).max(20).optional(),
  })
  .default({});
/** One chain step (R3). Give `approvals`, or `quorumPercent` of the step group's active members (resolved at request time). */
const StepSpec = z
  .object({
    name: z.string().min(1).max(60),
    group: z.string().max(60).optional(),
    approvals: z.number().int().min(1).max(10).optional(),
    quorumPercent: z.number().int().min(1).max(100).optional(),
  })
  .refine((st) => (st.approvals === undefined) !== (st.quorumPercent === undefined), "give exactly one of approvals or quorumPercent")
  .refine((st) => st.quorumPercent === undefined || !!st.group, "quorumPercent needs a group");
export type StepSpec = z.infer<typeof StepSpec>;
const Then = z.object({
  outcome: z.enum(["auto_approve", "human", "reject"]),
  approvals: z.number().int().min(1).max(5).default(1),
  group: z.string().max(60).optional(),
  timeoutSeconds: z
    .number()
    .int()
    .min(10)
    .max(30 * 86400)
    .optional(),
  escalateAfterSeconds: z
    .number()
    .int()
    .min(10)
    .max(30 * 86400)
    .optional(),
  escalateToGroup: z.string().max(60).optional(),
  /** Ordered approval chain, e.g. team lead then finance. Replaces approvals/group when present. */
  steps: z.array(StepSpec).min(1).max(5).optional(),
  /** "business": timeout and escalation count only the project's business hours. */
  clock: z.enum(["wall", "business"]).optional(),
});
export const PolicyRule = z
  .object({ id: z.string().min(1).max(60), description: z.string().max(300).optional(), when: When, then: Then })
  .superRefine((r, ctx) => {
    if (r.then.steps && r.then.outcome !== "human") ctx.addIssue({ code: "custom", path: ["then", "steps"], message: "approval chains need outcome human" });
    if (r.then.outcome !== "auto_approve") return;
    if (r.when.minConfidence === undefined || r.when.minConfidence < 0.5)
      ctx.addIssue({ code: "custom", path: ["when", "minConfidence"], message: "auto_approve rules must require minConfidence >= 0.5" });
    if (!r.when.risk || r.when.risk.includes("critical"))
      ctx.addIssue({ code: "custom", path: ["when", "risk"], message: "auto_approve rules must list risk levels and may not include critical" });
  });
export const PolicyDocument = z
  .object({
    rules: z.array(PolicyRule).max(200),
    default: Then.default({ outcome: "human", approvals: 1 }),
  })
  .superRefine((p, ctx) => {
    const ids = new Set<string>();
    p.rules.forEach((r, i) => {
      if (ids.has(r.id)) ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: `duplicate rule id ${r.id}` });
      ids.add(r.id);
    });
    if (p.default.outcome === "auto_approve")
      ctx.addIssue({ code: "custom", path: ["default", "outcome"], message: "the default outcome cannot be auto_approve" });
  });
export type PolicyDocument = z.infer<typeof PolicyDocument>;
export type PolicyRule = z.infer<typeof PolicyRule>;

export interface EvalInput {
  action: string;
  risk: RiskLevel;
  confidence?: number | null;
  tags?: string[];
  payload: Record<string, unknown>;
  minApprovals?: number;
}
export interface Routing {
  outcome: "auto_approve" | "human" | "reject";
  approvals: number;
  group: string | null;
  ruleId: string | null;
  timeoutSeconds: number | null;
  escalateAfterSeconds: number | null;
  escalateToGroup: string | null;
  steps: StepSpec[] | null;
  clock: "wall" | "business";
  /** Guardrails that changed the policy's answer (empty when the policy was followed as written). */
  guardrails: string[];
  trace: { ruleId: string; matched: boolean; failed: string[] }[];
}

export function globMatch(glob: string, s: string): boolean {
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(s);
}
export function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
function condHolds(c: z.infer<typeof Cond>, payload: Record<string, unknown>): boolean {
  const v = getPath(payload, c.path);
  switch (c.op) {
    case "exists":
      return v !== undefined;
    case "eq":
      return v === c.value;
    case "neq":
      return v !== c.value;
    case "in":
      return Array.isArray(c.value) && (c.value as unknown[]).includes(v);
    default: {
      if (typeof v !== "number" || typeof c.value !== "number") return false;
      return c.op === "gt" ? v > c.value : c.op === "gte" ? v >= c.value : c.op === "lt" ? v < c.value : v <= c.value;
    }
  }
}
function failures(r: PolicyRule, i: EvalInput): string[] {
  const f: string[] = [];
  const w = r.when;
  if (w.action && !globMatch(w.action, i.action)) f.push("action");
  if (w.risk && !w.risk.includes(i.risk)) f.push("risk");
  if (w.minConfidence !== undefined && !(typeof i.confidence === "number" && i.confidence >= w.minConfidence)) f.push("minConfidence");
  if (w.maxConfidence !== undefined && !(typeof i.confidence === "number" && i.confidence <= w.maxConfidence)) f.push("maxConfidence");
  if (w.tagsAny && !w.tagsAny.some((t) => i.tags?.includes(t))) f.push("tagsAny");
  w.payload?.forEach((c, k) => {
    if (!condHolds(c, i.payload)) f.push(`payload[${k}]`);
  });
  return f;
}

/** Hard guardrails: applied after the policy answers, so no policy can bypass them. */
function guard(policyOutcome: Routing["outcome"], policyApprovals: number, hit: PolicyRule | null, input: EvalInput) {
  const guardrails: string[] = [];
  let outcome = policyOutcome;
  let approvals = policyApprovals;
  const confident = typeof input.confidence === "number" && hit?.when.minConfidence !== undefined && input.confidence >= hit.when.minConfidence;
  if (outcome === "auto_approve" && input.risk === "critical") {
    outcome = "human";
    guardrails.push("critical_never_auto");
  }
  if (outcome === "auto_approve" && !confident) {
    outcome = "human";
    guardrails.push("confidence_required_for_auto");
  }
  if (input.risk === "critical" && approvals < 2 && outcome === "human") {
    approvals = 2;
    guardrails.push("critical_four_eyes");
  }
  if (input.minApprovals && input.minApprovals > approvals) {
    approvals = input.minApprovals;
    if (outcome === "auto_approve") {
      outcome = "human";
      guardrails.push("caller_requested_human");
    }
  }
  return { outcome, approvals, guardrails };
}

export function evaluate(policy: PolicyDocument, input: EvalInput): Routing {
  const trace: Routing["trace"] = [];
  let hit: PolicyRule | null = null;
  for (const r of policy.rules) {
    const failed = failures(r, input);
    trace.push({ ruleId: r.id, matched: failed.length === 0, failed });
    if (!failed.length) {
      hit = r;
      break;
    }
  }
  const t = hit ? hit.then : policy.default;
  const { outcome, approvals, guardrails } = guard(t.outcome, t.approvals, hit, input);
  return {
    outcome,
    approvals,
    group: t.group ?? null,
    ruleId: hit?.id ?? null,
    timeoutSeconds: t.timeoutSeconds ?? null,
    escalateAfterSeconds: t.escalateAfterSeconds ?? null,
    escalateToGroup: t.escalateToGroup ?? null,
    steps: outcome === "human" && t.steps ? t.steps : null,
    clock: t.clock ?? "wall",
    guardrails,
    trace,
  };
}

/** The policy used when a project has none: everything goes to one human, critical to two (guardrail). */
export const DEFAULT_POLICY: PolicyDocument = { rules: [], default: { outcome: "human", approvals: 1 } };

/** Deterministic canary bucketing: the same request id always lands in the same arm (0..99). */
export function bucket(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

/**
 * Turns chain step specs into concrete steps: quorum percentages become a count of the group's active members
 * (at least 1, at most 10), then the same hard guardrails as single-step routing apply to the chain total
 * (critical needs two people; callers may raise but never lower the count). Extra approvals go to the last step.
 */
export function resolveSteps(specs: StepSpec[], groupSize: (group: string) => number, input: Pick<EvalInput, "risk" | "minApprovals">) {
  const guardrails: string[] = [];
  const steps = specs.map((st) => {
    if (st.approvals !== undefined) return { name: st.name, group: st.group ?? null, approvals: st.approvals };
    const members = groupSize(st.group!);
    const raw = Math.ceil((st.quorumPercent! * members) / 100);
    const need = Math.min(10, Math.max(1, raw));
    if (raw > 10) guardrails.push(`quorum_capped:${st.name}`);
    if (members === 0) guardrails.push(`quorum_empty_group:${st.name}`);
    return { name: st.name, group: st.group!, approvals: need };
  });
  const total = () => steps.reduce((n, st) => n + st.approvals, 0);
  const last = steps[steps.length - 1]!;
  if (input.risk === "critical" && total() < 2) {
    last.approvals += 2 - total();
    guardrails.push("critical_four_eyes");
  }
  if (input.minApprovals && input.minApprovals > total()) last.approvals = Math.min(10, last.approvals + input.minApprovals - total());
  return { steps, guardrails };
}
