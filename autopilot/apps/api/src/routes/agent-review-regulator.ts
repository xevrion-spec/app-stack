/** D7: regulator-style evidence pack download (owner-only; reading it is itself audited). */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { auditStmt } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { regulatorPack } from "../services/agent-review-regulator.js";
import { scope } from "./agent-reviews.js";

export const agentReviewRegulator = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
agentReviewRegulator.use("/review-projects/:id/regulator-pack", requireRole("owner"));

const Control = z.object({
  id: z.string(),
  refs: z.array(z.string()),
  statement: z.string(),
  status: z.enum(["evidenced", "gap", "not_applicable"]),
  detail: z.string(),
});
const PackOut = z
  .object({
    pack: z
      .object({
        format: z.literal("xevrion.regulator-evidence/1"),
        scope: z.record(z.string(), z.unknown()),
        generatedAt: z.string(),
        disclaimer: z.string(),
        controls: z.array(Control),
        facts: z.record(z.string(), z.unknown()),
        policies: z.array(z.record(z.string(), z.unknown())),
        outcomes: z.record(z.string(), z.unknown()).nullable(),
        reviewers: z.array(z.record(z.string(), z.unknown())),
        integrity: z.object({ checked: z.number().int(), failedRequestIds: z.array(z.string()), truncated: z.boolean() }),
        requests: z.array(z.record(z.string(), z.unknown())),
        pseudonymised: z.boolean(),
      })
      .openapi({ description: "Signed content; verify over canonicalJson(pack)" }),
    manifestSha256: z.string(),
    signature: z.object({ alg: z.literal("Ed25519"), kid: z.string(), value: z.string() }).nullable(),
    publicKeys: z.array(z.record(z.string(), z.unknown())),
  })
  .openapi("RegulatorEvidencePack");
const Iso = z.string().datetime({ offset: true });

agentReviewRegulator.openapi(
  def({
    method: "get",
    path: "/review-projects/{id}/regulator-pack",
    tag: "Agent review",
    summary: "Regulator-style evidence pack for a period: control statements, policies, outcomes, reviewers, verified trails; signed",
    params: IdParam,
    query: z.object({ from: Iso, to: Iso, pseudonymise: z.enum(["true", "false"]).default("true") }),
    response: PackOut,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const from = new Date(q.from).toISOString(),
      to = new Date(q.to).toISOString();
    if (from >= to) throw badRequest("from must be before to");
    if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw badRequest("period may be at most 366 days");
    const db = scope(c);
    const p = await db.first<{ id: string; name: string; environment: string; retention_days: number | null }>(
      "select id, name, environment, retention_days from review_projects where tenant_id = ?1 and id = ?2",
      id,
    );
    if (!p) throw notFound("Project not found");
    const out = await regulatorPack(c.env, db, p, from, to, q.pseudonymise === "true");
    await db.batch([auditStmt(db, c.get("principal").email, "agent_review.regulator_pack", id, { from, to, manifest: out.manifestSha256 })]);
    c.header("content-disposition", `attachment; filename="regulator-pack-${id}.json"`);
    return c.json(out, 200);
  },
);
