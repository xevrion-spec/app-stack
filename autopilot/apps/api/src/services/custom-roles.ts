/**
 * Custom roles (A8c). A custom role narrows what a reviewer/accountant may do in agent review: which decisions
 * (permissions) and on which requests (ABAC: projects, environments, maximum risk). Owners are never restricted.
 * Visibility filtering happens in SQL so lists and lookups can't leak hidden requests (they read as 404).
 */
import type { TenantDb } from "../lib/db.js";

export const PERMISSIONS = ["reviews.approve", "reviews.reject", "reviews.edit", "reviews.escalate"] as const;
export type Permission = (typeof PERMISSIONS)[number];
const RISKS = ["low", "medium", "high", "critical"] as const;
export type Risk = (typeof RISKS)[number];
export type RoleRow = {
  id: string;
  name: string;
  permissions_json: string;
  projects_json: string | null;
  environments_json: string | null;
  max_risk: Risk | null;
  created_at: string;
  updated_at: string;
};
export type EffectiveRole = { id: string; permissions: Set<Permission>; projects: string[] | null; environments: string[] | null; maxRisk: Risk | null };

export async function roleOfUser(db: TenantDb, userId: string): Promise<EffectiveRole | null> {
  const r = await db.first<RoleRow>(
    "select r.* from users u join custom_roles r on r.tenant_id = u.tenant_id and r.id = u.custom_role_id where u.tenant_id = ?1 and u.id = ?2 and u.role != 'owner'",
    userId,
  );
  if (!r) return null;
  return {
    id: r.id,
    permissions: new Set(JSON.parse(r.permissions_json) as Permission[]),
    projects: r.projects_json ? (JSON.parse(r.projects_json) as string[]) : null,
    environments: r.environments_json ? (JSON.parse(r.environments_json) as string[]) : null,
    maxRisk: r.max_risk,
  };
}

/** Project ids the role may see (null = no project restriction). Projects AND environments both apply. */
export async function visibleProjects(db: TenantDb, role: EffectiveRole): Promise<string[] | null> {
  if (!role.projects && !role.environments) return null;
  const rows = await db.all<{ id: string; environment: string }>("select id, environment from review_projects where tenant_id = ?1");
  return rows
    .filter((p) => (!role.projects || role.projects.includes(p.id)) && (!role.environments || role.environments.includes(p.environment)))
    .map((p) => p.id);
}

export const riskAllowed = (role: EffectiveRole, risk: Risk) => !role.maxRisk || RISKS.indexOf(risk) <= RISKS.indexOf(role.maxRisk);
export const permissionFor = (decision: string): Permission =>
  decision === "approve" ? "reviews.approve" : decision === "reject" ? "reviews.reject" : decision === "edit" ? "reviews.edit" : "reviews.escalate";
