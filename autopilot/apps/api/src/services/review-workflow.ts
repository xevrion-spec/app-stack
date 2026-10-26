/**
 * R3 workflow services: approval-chain resolution (quorum against live group membership), business-hours clocks and
 * delegation lookups. Pure rules live in @xevrion/agent-review; this file only reads the tenant's data.
 */
import * as R from "@xevrion/agent-review";
import type { TenantDb } from "../lib/db.js";

/** Active people who can review (owner/reviewer/accountant, not deactivated) in each named group. */
export async function groupSizes(db: TenantDb, groups: string[]): Promise<Map<string, number>> {
  if (!groups.length) return new Map();
  const rows = await db.all<{ group_name: string; n: number }>(
    `select m.group_name, count(*) as n from review_group_members m join users u on u.tenant_id = m.tenant_id and lower(u.email) = m.email
       where m.tenant_id = ?1 and m.group_name in (select value from json_each(?2)) and u.deactivated_at is null and u.role in ('owner', 'reviewer', 'accountant')
       group by m.group_name`,
    JSON.stringify(groups),
  );
  return new Map(rows.map((r) => [r.group_name, r.n]));
}

export async function projectCalendar(db: TenantDb, projectId: string): Promise<R.Calendar | null> {
  const row = await db.first<{ business_hours_json: string | null }>(
    "select business_hours_json from review_projects where tenant_id = ?1 and id = ?2",
    projectId,
  );
  return row?.business_hours_json ? R.Calendar.parse(JSON.parse(row.business_hours_json)) : null;
}

/** "In `seconds`" on the routing's clock. Business clocks fall back to wall time (flagged) when no calendar is set. */
export function clockFor(calendar: R.Calendar | null, clock: "wall" | "business", from = Date.now()) {
  const business = clock === "business" && calendar;
  return {
    guardrail: clock === "business" && !calendar ? "business_clock_without_calendar" : null,
    at: (seconds: number) => new Date(business ? R.addBusinessSeconds(from, seconds, calendar) : from + seconds * 1000).toISOString(),
  };
}

/** A person someone in `group` has delegated to, active now (one hop; the delegator must still be active). */
export async function delegatorFor(db: TenantDb, group: string, toEmail: string, at: string): Promise<string | null> {
  const row = await db.first<{ from_email: string }>(
    `select d.from_email from review_delegations d
       join review_group_members m on m.tenant_id = d.tenant_id and m.group_name = ?2 and m.email = d.from_email
       join users u on u.tenant_id = d.tenant_id and lower(u.email) = d.from_email and u.deactivated_at is null
       where d.tenant_id = ?1 and d.to_email = ?3 and d.revoked_at is null and d.starts_at <= ?4 and d.ends_at > ?4
       order by d.created_at limit 1`,
    group,
    toEmail.toLowerCase(),
    at,
  );
  return row?.from_email ?? null;
}
