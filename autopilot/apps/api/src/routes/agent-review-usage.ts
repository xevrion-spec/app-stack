/** Agent review usage (A10a): this month's metered counters plus the plan quota, so customers can see cost drivers. */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { quotaCheck } from "@xevrion/platform";
import type { AppEnv } from "../env.js";
import { def, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { period } from "../services/usage.js";
import { scope } from "./agent-reviews.js";

export const agentReviewUsage = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
agentReviewUsage.get("/agent-review/usage", requireRole("owner"));
const METRICS = ["agent_reviews", "agent_reviews_auto", "agent_review_decisions", "agent_review_system_decisions"] as const;
const UsageOut = z
  .object({
    period: z.string(),
    plan: z.string(),
    requests: z.number(),
    autoDecided: z.number(),
    humanDecisions: z.number(),
    systemDecisions: z.number(),
    autoRate: z.number().nullable().openapi({ description: "Share of requests a policy decided without a human (null when none)" }),
    limit: z.number().nullable().openapi({ description: "Monthly request quota for the plan (null = unlimited)" }),
    remaining: z.number().nullable(),
  })
  .openapi("AgentReviewUsage");
agentReviewUsage.openapi(
  def({ method: "get", path: "/agent-review/usage", tag: "Agent review", summary: "This month's agent review usage vs plan quota", response: UsageOut }),
  async (c) => {
    const db = scope(c);
    const raw = (await db.tenantRowStmt("plan").first<{ plan: string | null }>())?.plan ?? "free";
    const plan = raw === "trial" ? "starter" : raw;
    const rows = await db.all<{ metric: string; count: number }>(
      `select metric, count from usage_counters where tenant_id = ?1 and period = ?2 and metric in (${METRICS.map((m) => `'${m}'`).join(", ")})`,
      period(),
    );
    const n = (m: (typeof METRICS)[number]) => rows.find((r) => r.metric === m)?.count ?? 0;
    const q = quotaCheck(plan, "agent_reviews", n("agent_reviews"), 0);
    const finite = Number.isFinite(q.limit);
    return c.json(
      {
        period: period(),
        plan,
        requests: n("agent_reviews"),
        autoDecided: n("agent_reviews_auto"),
        humanDecisions: n("agent_review_decisions"),
        systemDecisions: n("agent_review_system_decisions"),
        autoRate: n("agent_reviews") ? Math.round((n("agent_reviews_auto") / n("agent_reviews")) * 1000) / 1000 : null,
        limit: finite ? q.limit : null,
        remaining: finite ? q.remaining : null,
      },
      200,
    );
  },
);
