/** R1/R3: enqueue statements for reviewer notifications (kept separate so agent-review.ts can import it without a cycle). */
import { TenantDb, newId } from "../lib/db.js";

export const RISKS = ["low", "medium", "high", "critical"] as const;
const COLS = "id, kind, project_id, min_risk, recipients_json";

export interface EnqueueTarget {
  id: string;
  project_id: string;
  risk: string;
  /** Group deciding now; email channels with no fixed recipients notify its active members. */
  group?: string | null | undefined;
  /** Chain step index (0 for single-step requests); one delivery per recipient per step. */
  step?: number | undefined;
}

/** Active reviewer-capable members of a group (lower-cased emails). */
async function groupMembers(db: TenantDb, group: string): Promise<string[]> {
  const rows = await db.all<{ email: string }>(
    `select m.email from review_group_members m join users u on u.tenant_id = m.tenant_id and lower(u.email) = m.email
       where m.tenant_id = ?1 and m.group_name = ?2 and u.deactivated_at is null and u.role in ('owner', 'reviewer', 'accountant') order by m.email`,
    group,
  );
  return rows.map((r) => r.email);
}

/** Active delegations at `at`: delegator -> delegate (first created wins, matching decideAs). */
export async function delegateMap(db: TenantDb, emails: string[], at: string): Promise<Map<string, string>> {
  if (!emails.length) return new Map();
  const rows = await db.all<{ from_email: string; to_email: string }>(
    `select from_email, to_email from review_delegations where tenant_id = ?1 and revoked_at is null and starts_at <= ?2 and ends_at > ?2
       and from_email in (select value from json_each(?3)) order by created_at`,
    at,
    JSON.stringify(emails),
  );
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.from_email)) out.set(r.from_email, r.to_email);
  return out;
}

/** Recipients with delegations applied: a delegator is replaced by their delegate, de-duplicated, order kept. */
export function redirect(recipients: string[], delegates: Map<string, string>): string[] {
  const out: string[] = [];
  for (const r of recipients) {
    const to = delegates.get(r.toLowerCase()) ?? r;
    if (!out.includes(to)) out.push(to);
  }
  return out;
}

/** Statements that enqueue one delivery per matching channel (per recipient for email); duplicates are ignored. */
export async function enqueueStmts(db: TenantDb, r: EnqueueTarget, at: string): Promise<D1PreparedStatement[]> {
  const chans = await db.all<{ id: string; kind: string; project_id: string | null; min_risk: (typeof RISKS)[number]; recipients_json: string }>(
    `select ${COLS} from notify_channels where tenant_id = ?1 and active = 1`,
  );
  const members = r.group ? await groupMembers(db, r.group) : [];
  const out: D1PreparedStatement[] = [];
  for (const ch of chans) {
    if (ch.project_id && ch.project_id !== r.project_id) continue;
    if (RISKS.indexOf(r.risk as (typeof RISKS)[number]) < RISKS.indexOf(ch.min_risk)) continue;
    let recipients: (string | null)[] = [null];
    if (ch.kind === "email") {
      const fixed = (JSON.parse(ch.recipients_json) as string[]).map((e) => e.toLowerCase());
      const base = fixed.length ? fixed : members;
      recipients = redirect(base, await delegateMap(db, base, at));
    }
    for (const to of recipients)
      out.push(
        db.stmt(
          "insert or ignore into notify_deliveries (tenant_id, id, channel_id, request_id, recipient, status, attempt, next_attempt_at, created_at, updated_at, step) values (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6, ?6, ?7)",
          newId(),
          ch.id,
          r.id,
          to,
          at,
          r.step ?? 0,
        ),
      );
  }
  return out;
}
