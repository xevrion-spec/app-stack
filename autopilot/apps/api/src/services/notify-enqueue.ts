/** R1: enqueue statements for reviewer notifications (kept separate so agent-review.ts can import it without a cycle). */
import { TenantDb, newId } from "../lib/db.js";

export const RISKS = ["low", "medium", "high", "critical"] as const;
const COLS = "id, kind, project_id, min_risk, recipients_json";

/** Statements that enqueue one delivery per matching channel (per recipient for email). */
export async function enqueueStmts(db: TenantDb, r: { id: string; project_id: string; risk: string }, at: string): Promise<D1PreparedStatement[]> {
  const chans = await db.all<{ id: string; kind: string; project_id: string | null; min_risk: (typeof RISKS)[number]; recipients_json: string }>(
    `select ${COLS} from notify_channels where tenant_id = ?1 and active = 1`,
  );
  const out: D1PreparedStatement[] = [];
  for (const ch of chans) {
    if (ch.project_id && ch.project_id !== r.project_id) continue;
    if (RISKS.indexOf(r.risk as (typeof RISKS)[number]) < RISKS.indexOf(ch.min_risk)) continue;
    const recipients = ch.kind === "email" ? (JSON.parse(ch.recipients_json) as string[]) : [null];
    for (const to of recipients)
      out.push(
        db.stmt(
          "insert into notify_deliveries (tenant_id, id, channel_id, request_id, recipient, status, attempt, next_attempt_at, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6, ?6)",
          newId(),
          ch.id,
          r.id,
          to,
          at,
        ),
      );
  }
  return out;
}
