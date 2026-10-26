/**
 * R4 action templates: per project and action, a payload schema (JSON Schema subset, enforced when agents create
 * requests: 422 payload_invalid) plus a reviewer-facing title (`{{field}}` placeholders) and instructions.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import * as R from "@xevrion/agent-review";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { auditStmt } from "../lib/audit.js";
import { scope } from "./agent-reviews.js";
import { TEMPLATE_COLS, type TemplateRow } from "../services/review-templates.js";

export const reviewTemplates = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
reviewTemplates.put("/review-projects/:id/templates/*", requireRole("owner"));
reviewTemplates.delete("/review-projects/:id/templates/*", requireRole("owner"));

const Action = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/, "action name");
const Params = IdParam.extend({ action: Action });
const TemplateOut = z
  .object({
    action: z.string(),
    title: z.string().nullable(),
    instructions: z.string().nullable(),
    schema: z.record(z.string(), z.unknown()),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .openapi("ReviewActionTemplate");
const out = (t: TemplateRow) => ({
  action: t.action,
  title: t.title,
  instructions: t.instructions,
  schema: JSON.parse(t.schema_json) as Record<string, unknown>,
  updatedBy: t.updated_by,
  updatedAt: t.updated_at,
});
async function project(c: Parameters<typeof scope>[0], id: string) {
  if (!(await scope(c).first("select 1 from review_projects where tenant_id = ?1 and id = ?2", id))) throw notFound("Review project");
}

reviewTemplates.openapi(
  def({
    method: "get",
    path: "/review-projects/{id}/templates",
    tag: "Agent review",
    summary: "Action templates for a project",
    params: IdParam,
    response: z.object({ items: z.array(TemplateOut) }),
  }),
  async (c) => {
    const id = c.req.valid("param").id;
    await project(c, id);
    const rows = await scope(c).all<TemplateRow>(
      `select ${TEMPLATE_COLS} from review_action_templates where tenant_id = ?1 and project_id = ?2 order by action`,
      id,
    );
    return c.json({ items: rows.map(out) }, 200);
  },
);
reviewTemplates.openapi(
  def({
    method: "put",
    path: "/review-projects/{id}/templates/{action}",
    tag: "Agent review",
    summary: "Create or replace the template for an action. New requests whose payload breaks the schema get 422 payload_invalid.",
    params: Params,
    body: z.object({
      schema: z
        .record(z.string(), z.unknown())
        .openapi({ description: "JSON Schema subset: type, properties, required, additionalProperties, items, enum, const, min/max, length, pattern, format" }),
      title: z.string().max(200).optional().openapi({ example: "Refund £{{amount}} on {{orderId}}" }),
      instructions: z.string().max(2000).optional(),
    }),
    response: TemplateOut,
  }),
  async (c) => {
    const { id, action } = c.req.valid("param");
    await project(c, id);
    const b = c.req.valid("json");
    const parsed = R.SchemaLite.safeParse(b.schema);
    if (!parsed.success) throw badRequest(`schema: ${parsed.error.issues.map((i) => `${i.path.join(".") || "$"} ${i.message}`).join("; ")}`);
    if (R.schemaDepth(parsed.data) > 8) throw badRequest("schema: nested deeper than 8 levels");
    const db = scope(c);
    const who = c.get("principal").email;
    const at = new Date().toISOString();
    await db.batch([
      db.stmt(
        `insert into review_action_templates (tenant_id, project_id, ${TEMPLATE_COLS}) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           on conflict (tenant_id, project_id, action) do update set title = excluded.title, instructions = excluded.instructions, schema_json = excluded.schema_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        id,
        action,
        b.title ?? null,
        b.instructions ?? null,
        JSON.stringify(parsed.data),
        who,
        at,
      ),
      auditStmt(db, who, "review.template_set", `${id}:${action}`),
    ]);
    const row = await db.first<TemplateRow>(
      `select ${TEMPLATE_COLS} from review_action_templates where tenant_id = ?1 and project_id = ?2 and action = ?3`,
      id,
      action,
    );
    return c.json(out(row!), 200);
  },
);
reviewTemplates.openapi(
  def({
    method: "delete",
    path: "/review-projects/{id}/templates/{action}",
    tag: "Agent review",
    summary: "Remove an action template",
    params: Params,
    response: z.object({ deleted: z.boolean() }),
  }),
  async (c) => {
    const { id, action } = c.req.valid("param");
    const db = scope(c);
    const n = await db.run("delete from review_action_templates where tenant_id = ?1 and project_id = ?2 and action = ?3", id, action);
    if (!n) throw notFound("Template");
    await auditStmt(db, c.get("principal").email, "review.template_deleted", `${id}:${action}`).run();
    return c.json({ deleted: true }, 200);
  },
);
