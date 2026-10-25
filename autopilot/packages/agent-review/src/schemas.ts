import { z } from "zod";
import { DECISIONS, STATUSES } from "./state.js";

/** Public wire contract for review requests (shared by the API, the SDK and adapters). */
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
const MAX_JSON_BYTES = 64 * 1024;
const boundedJson = z.record(z.string(), z.unknown()).refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= MAX_JSON_BYTES, {
  message: `must be at most ${MAX_JSON_BYTES} bytes as JSON`,
});

export const CreateReviewRequest = z.object({
  /** What the agent wants to do, e.g. "refund.issue" or "email.send". */
  action: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9_.:-]*$/, "lowercase letters, digits and . _ : -"),
  /** The proposed action input the reviewer may approve or edit. */
  payload: boundedJson,
  /** Read-only context for the reviewer (agent reasoning, sources, conversation excerpt). */
  context: boundedJson.optional(),
  risk: z.enum(RISK_LEVELS).default("medium"),
  /** Model or agent confidence, if any: input to the policy engine (A2). */
  confidence: z.number().min(0).max(1).optional(),
  /** Absolute deadline (ISO 8601), or seconds from now. If both are given, deadlineAt wins. */
  deadlineAt: z.iso.datetime({ offset: true }).optional(),
  timeoutSeconds: z
    .number()
    .int()
    .min(10)
    .max(30 * 24 * 3600)
    .optional(),
  /** Overrides the policy's approver count (it can only raise it, never lower it). */
  minApprovals: z.number().int().min(1).max(5).optional(),
  /** Caller's own correlation id (for example the agent run id), returned on every event. */
  externalId: z.string().max(200).optional(),
  /** Free-form labels for routing and search. */
  tags: z.array(z.string().max(40)).max(20).default([]),
});
export type CreateReviewRequest = z.infer<typeof CreateReviewRequest>;

export const DecideReviewRequest = z
  .object({
    decision: z.enum(DECISIONS),
    reason: z.string().max(2000).optional(),
    /** Required for "edit": the full replacement payload. */
    payload: boundedJson.optional(),
  })
  .refine((d) => d.decision !== "edit" || d.payload !== undefined, { message: "payload is required for edit", path: ["payload"] });
export type DecideReviewRequest = z.infer<typeof DecideReviewRequest>;

export const ReviewStatus = z.enum(STATUSES);
