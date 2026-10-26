/**
 * One authorization path for every way a person can decide (API, inbox, one-click notification action): custom-role
 * permission + max risk, routed-group membership, then the version-checked state transition.
 */
import { delegatorFor } from "./review-workflow.js";
import { auditStmt } from "../lib/audit.js";
import * as R from "@xevrion/agent-review";
import type { Env } from "../env.js";
import type { TenantDb } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { permissionFor, riskAllowed, roleOfUser, visibleProjects } from "./custom-roles.js";
import * as S from "./agent-review.js";

export interface Decider {
  userId: string | null;
  email: string;
  role: string | null;
  apiKey: boolean;
}
export interface DecideBody {
  decision: R.Decision;
  reason?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

/** Project visibility for a person (null = all). API-key project binding is handled by the caller. */
export async function scopeFor(db: TenantDb, who: Decider): Promise<string[] | null> {
  if (who.apiKey || who.role === "owner" || !who.userId) return null;
  const role = await roleOfUser(db, who.userId);
  return role ? visibleProjects(db, role) : null;
}

export async function decideAs(env: Env, db: TenantDb, r: S.RequestRow, who: Decider, b: DecideBody): Promise<S.RequestRow> {
  const role = who.apiKey || who.role === "owner" || !who.userId ? null : await roleOfUser(db, who.userId);
  if (role && !role.permissions.has(permissionFor(b.decision)))
    throw new AppError(403, "forbidden_by_role", `Your role does not allow ${b.decision} decisions`);
  if (role && !riskAllowed(role, r.risk)) throw new AppError(403, "forbidden_by_role", `Your role cannot decide ${r.risk}-risk requests`);
  const group = S.decidingGroup(r);
  if (group && !who.apiKey && who.role !== "owner" && !R.FINAL.has(r.status)) {
    const member = await db.first("select 1 from review_group_members where tenant_id = ?1 and group_name = ?2 and email = ?3", group, who.email.toLowerCase());
    const onBehalfOf = member ? null : await delegatorFor(db, group, who.email, new Date().toISOString());
    if (!member && !onBehalfOf) throw new AppError(403, "not_in_group", `This request is routed to the ${group} group`);
    if (onBehalfOf) {
      const next = await S.transition(
        env,
        db,
        r,
        { type: "decide", decision: b.decision, reviewer: who.email },
        { actor: who.email, reason: b.reason, payload: b.payload },
      );
      await auditStmt(db, who.email, "review.delegated_decision", r.id, { onBehalfOf, group, decision: b.decision }).run();
      return next;
    }
  }
  return S.transition(env, db, r, { type: "decide", decision: b.decision, reviewer: who.email }, { actor: who.email, reason: b.reason, payload: b.payload });
}
