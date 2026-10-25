/**
 * D3 reviewer-quality analytics and D4 auto-approve suggestions. Owner-only (it is data about people) and read-only:
 * suggestions return a validated draft policy document; saving/activating it uses the normal policy + canary flow.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import * as R from "@xevrion/agent-review";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import * as S from "../services/agent-review.js";
import * as A from "../services/agent-review-analytics.js";
import { scope } from "./agent-reviews.js";

export const agentReviewAnalytics = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
agentReviewAnalytics.use("/agent-review/analytics/*", requireRole("owner"));
agentReviewAnalytics.use("/review-projects/:id/suggestions", requireRole("owner"));

const Days = z.coerce.number().int().min(1).max(365).default(30);
const ReviewerOut = z
  .object({
    reviewer: z.string(),
    decisions: z.number().int(),
    counts: z.object({ approve: z.number().int(), reject: z.number().int(), edit: z.number().int(), escalate: z.number().int() }),
    medianSeconds: z.number().nullable(),
    p90Seconds: z.number().nullable(),
    approveRate: z.number().nullable(),
    approveRateHighRisk: z.number().nullable(),
    disagreementRate: z.number().nullable().openapi({ description: "Share of co-reviewed requests where another reviewer gave the opposite verdict" }),
    flags: z.array(z.enum(["low_sample", "fast_approvals", "approves_high_risk_more"])),
  })
  .openapi("ReviewerQuality");
const ReviewersOut = z
  .object({ from: z.string(), minSample: z.number().int(), truncated: z.boolean(), reviewers: z.array(ReviewerOut) })
  .openapi("ReviewerQualityReport");

agentReviewAnalytics.openapi(
  def({
    method: "get",
    path: "/agent-review/analytics/reviewers",
    tag: "Agent review",
    summary: "Reviewer quality: latency, approve rates, co-reviewer disagreement and rubber-stamp signals",
    query: z.object({ days: Days, projectId: z.string().max(64).optional() }),
    response: ReviewersOut,
  }),
  async (c) => {
    const { days, projectId } = c.req.valid("query");
    const from = A.since(days);
    const rows = await A.decisionRows(scope(c), from, projectId ?? null);
    return c.json({ from, minSample: R.MIN_REVIEWER_SAMPLE, truncated: rows.length >= A.MAX_ROWS, reviewers: R.reviewerStats(rows) }, 200);
  },
);

const SuggestionOut = z
  .object({
    action: z.string(),
    risk: z.enum(["low", "medium"]),
    minConfidence: z.number(),
    sample: z.number().int(),
    cleanApprovals: z.number().int(),
    wilsonLower: z.number(),
    shadow: z.object({
      wouldAutoApprove: z.number().int(),
      wouldHaveBeenRejected: z.number().int(),
      wouldHaveBeenEdited: z.number().int(),
      excludedLowConfidence: z.number().int(),
    }),
    rule: z.record(z.string(), z.unknown()),
  })
  .openapi("AutoApproveSuggestion");
const SuggestionsOut = z
  .object({
    from: z.string(),
    basedOnVersion: z.number().int().nullable(),
    considered: z.number().int(),
    suggestions: z.array(SuggestionOut),
    draft: z.record(z.string(), z.unknown()).nullable().openapi({ description: "Validated policy document (current rules + suggestions); not saved" }),
  })
  .openapi("AutoApproveSuggestions");

agentReviewAnalytics.openapi(
  def({
    method: "get",
    path: "/review-projects/{id}/suggestions",
    tag: "Agent review",
    summary: "Learn when to stop asking: guarded auto-approve rule suggestions with a shadow replay (draft only)",
    params: IdParam,
    query: z.object({
      days: Days.default(90),
      minSample: z.coerce.number().int().min(20).max(10_000).default(50),
      target: z.coerce.number().min(0.9).max(0.999).default(0.97),
    }),
    response: SuggestionsOut,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { days, minSample, target } = c.req.valid("query");
    const db = scope(c);
    if (!(await db.first("select id from review_projects where tenant_id = ?1 and id = ?2 and archived_at is null", id))) throw notFound("Project not found");
    const active = (await S.livePolicies(db, id)).find((p) => p.status === "active");
    const current: R.PolicyDocument = active ? JSON.parse(active.document_json) : R.DEFAULT_POLICY;
    const from = A.since(days);
    const rows = await A.outcomeRows(db, from, id);
    const suggestions = R.suggestAutoApprove(rows, { minSample, target });
    return c.json(
      {
        from,
        basedOnVersion: active?.version ?? null,
        considered: rows.length,
        suggestions,
        draft: suggestions.length ? R.draftPolicy(current, suggestions) : null,
      },
      200,
    );
  },
);

const Latency = z.object({ p50Seconds: z.number().nullable(), p90Seconds: z.number().nullable(), p99Seconds: z.number().nullable() });
const ActionOut = z
  .object({
    action: z.string(),
    requests: z.number().int(),
    outcomes: z.record(z.string(), z.number().int()),
    autoDecidedRate: z.number(),
    escalationRate: z.number(),
    expiryRate: z.number(),
    humanDecisions: z.number().int(),
    decisionLatency: Latency,
    estimatedHumanCost: z.number().nullable(),
    estimatedCostAvoided: z.number().nullable(),
  })
  .openapi("AgentReviewActionOutcomes");
const OutcomesOut = z
  .object({ from: z.string(), truncated: z.boolean(), currency: z.string().nullable(), total: ActionOut.nullable(), byAction: z.array(ActionOut) })
  .openapi("AgentReviewOutcomes");

agentReviewAnalytics.openapi(
  def({
    method: "get",
    path: "/agent-review/analytics/outcomes",
    tag: "Agent review",
    summary: "Cost, latency and outcome analytics per action (cost only from your own reviewer-cost inputs)",
    query: z.object({
      days: Days,
      projectId: z.string().max(64).optional(),
      hourlyCost: z.coerce.number().min(0).max(10_000).optional(),
      minutesPerDecision: z.coerce.number().min(0).max(600).optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
    }),
    response: OutcomesOut,
  }),
  async (c) => {
    const { days, projectId, hourlyCost, minutesPerDecision, currency } = c.req.valid("query");
    const from = A.since(days);
    const rows = await A.requestFacts(scope(c), from, projectId ?? null);
    const costed = hourlyCost !== undefined && minutesPerDecision !== undefined;
    return c.json(
      {
        from,
        truncated: rows.length >= A.MAX_ROWS,
        currency: costed ? (currency ?? null) : null,
        ...R.outcomeSummary(rows, costed ? { hourlyCost, minutesPerDecision } : {}),
      },
      200,
    );
  },
);
