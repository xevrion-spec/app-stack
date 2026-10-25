/** Custom role admin (A8c): owner humans only. Assignment applies to reviewers/accountants; owners are never narrowed. */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { auditStmt } from "../lib/audit.js";
import { AppError, conflict, notFound } from "../lib/errors.js";
import { newId } from "../lib/db.js";
import { PERMISSIONS, type RoleRow } from "../services/custom-roles.js";
import { scope } from "./agent-reviews.js";

export const customRoles = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
const ownerHuman: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal").apiKey) throw new AppError(403, "forbidden", "API keys cannot manage roles");
  return requireRole("owner")(c, next);
};
for (const p of ["/roles", "/roles/*", "/users/:id/custom-role"]) customRoles.use(p, ownerHuman);
const actor = (c: { get: (k: "principal") => { email: string } }) => c.get("principal").email;
const RISK = z.enum(["low", "medium", "high", "critical"]);
const RoleIn = z
  .object({
    name: z.string().min(1).max(60),
    permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
    /** ABAC: limit to these review projects (null/omitted = any). */
    projects: z.array(z.string().max(64)).min(1).max(100).nullable().optional(),
    environments: z
      .array(z.enum(["development", "staging", "production"]))
      .min(1)
      .nullable()
      .optional(),
    maxRisk: RISK.nullable().optional(),
  })
  .openapi("CustomRoleIn");
const RoleOut = z
  .object({
    id: z.string(),
    name: z.string(),
    permissions: z.array(z.string()),
    projects: z.array(z.string()).nullable(),
    environments: z.array(z.string()).nullable(),
    maxRisk: RISK.nullable(),
    assigned: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("CustomRole");
const out = (r: RoleRow & { assigned?: number }) => ({
  id: r.id,
  name: r.name,
  permissions: JSON.parse(r.permissions_json) as string[],
  projects: r.projects_json ? (JSON.parse(r.projects_json) as string[]) : null,
  environments: r.environments_json ? (JSON.parse(r.environments_json) as string[]) : null,
  maxRisk: r.max_risk,
  assigned: r.assigned ?? 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const SELECT =
  "select r.*, (select count(*) from users u where u.tenant_id = r.tenant_id and u.custom_role_id = r.id) assigned from custom_roles r where r.tenant_id = ?1";
type Db = ReturnType<typeof scope>;
async function checkProjects(db: Db, ids: string[] | null | undefined) {
  if (!ids) return;
  const n = (
    await db.first<{ n: number }>(
      "select count(*) n from review_projects where tenant_id = ?1 and id in (select value from json_each(?2))",
      JSON.stringify(ids),
    )
  )?.n;
  if (n !== new Set(ids).size) throw notFound("Project");
}
const vals = (b: z.infer<typeof RoleIn>) =>
  [
    b.name,
    JSON.stringify([...new Set(b.permissions)].sort()),
    b.projects ? JSON.stringify(b.projects) : null,
    b.environments ? JSON.stringify(b.environments) : null,
    b.maxRisk ?? null,
  ] as const;

customRoles.openapi(
  def({ method: "get", path: "/roles", tag: "Account", summary: "List custom roles", response: z.object({ items: z.array(RoleOut) }) }),
  async (c) => c.json({ items: (await scope(c).all<RoleRow & { assigned: number }>(`${SELECT} order by r.name`)).map(out) }, 200),
);
customRoles.openapi(
  def({
    method: "post",
    path: "/roles",
    tag: "Account",
    summary: "Create a custom role (permissions + project/environment/risk conditions)",
    body: RoleIn,
    response: RoleOut,
    status: 201,
  }),
  async (c) => {
    const db = scope(c);
    const b = c.req.valid("json");
    await checkProjects(db, b.projects);
    if (await db.first("select 1 from custom_roles where tenant_id = ?1 and name = ?2", b.name)) throw conflict("A role with that name exists");
    const id = newId();
    const t = new Date().toISOString();
    await db.batch([
      db.stmt(
        "insert into custom_roles (tenant_id, id, name, permissions_json, projects_json, environments_json, max_risk, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        id,
        ...vals(b),
        t,
      ),
      auditStmt(db, actor(c), "role.created", id, b),
    ]);
    return c.json(out((await db.first<RoleRow & { assigned: number }>(`${SELECT} and r.id = ?2`, id))!), 201);
  },
);
customRoles.openapi(
  def({
    method: "put",
    path: "/roles/{id}",
    tag: "Account",
    summary: "Replace a custom role (takes effect on the next request)",
    params: IdParam,
    body: RoleIn,
    response: RoleOut,
  }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    if (!(await db.first("select 1 from custom_roles where tenant_id = ?1 and id = ?2", id))) throw notFound("Role");
    await checkProjects(db, b.projects);
    if (await db.first("select 1 from custom_roles where tenant_id = ?1 and name = ?2 and id != ?3", b.name, id))
      throw conflict("A role with that name exists");
    await db.batch([
      db.stmt(
        "update custom_roles set name = ?3, permissions_json = ?4, projects_json = ?5, environments_json = ?6, max_risk = ?7, updated_at = ?8 where tenant_id = ?1 and id = ?2",
        id,
        ...vals(b),
        new Date().toISOString(),
      ),
      auditStmt(db, actor(c), "role.updated", id, b),
    ]);
    return c.json(out((await db.first<RoleRow & { assigned: number }>(`${SELECT} and r.id = ?2`, id))!), 200);
  },
);
customRoles.openapi(
  def({
    method: "delete",
    path: "/roles/{id}",
    tag: "Account",
    summary: "Delete an unassigned custom role",
    params: IdParam,
    response: z.object({ deleted: z.boolean() }),
  }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    if (!(await db.first("select 1 from custom_roles where tenant_id = ?1 and id = ?2", id))) throw notFound("Role");
    if (await db.first("select 1 from users where tenant_id = ?1 and custom_role_id = ?2", id)) throw conflict("Role is still assigned; unassign it first");
    await db.batch([db.stmt("delete from custom_roles where tenant_id = ?1 and id = ?2", id), auditStmt(db, actor(c), "role.deleted", id)]);
    return c.json({ deleted: true }, 200);
  },
);
customRoles.openapi(
  def({
    method: "put",
    path: "/users/{id}/custom-role",
    tag: "Account",
    summary: "Assign (or clear with null) a user's custom role. Owners cannot be narrowed.",
    params: IdParam,
    body: z.object({ customRoleId: z.string().max(64).nullable() }),
    response: z.object({ userId: z.string(), customRoleId: z.string().nullable() }),
  }),
  async (c) => {
    const db = scope(c);
    const { id } = c.req.valid("param");
    const { customRoleId } = c.req.valid("json");
    const u = await db.first<{ role: string }>("select role from users where tenant_id = ?1 and id = ?2", id);
    if (!u) throw notFound("User");
    if (u.role === "owner") throw new AppError(409, "conflict", "Owners cannot have a custom role");
    if (customRoleId && !(await db.first("select 1 from custom_roles where tenant_id = ?1 and id = ?2", customRoleId))) throw notFound("Role");
    await db.batch([
      db.stmt("update users set custom_role_id = ?3 where tenant_id = ?1 and id = ?2", id, customRoleId),
      auditStmt(db, actor(c), customRoleId ? "role.assigned" : "role.unassigned", id, { customRoleId }),
    ]);
    return c.json({ userId: id, customRoleId }, 200);
  },
);
