import { parseAutomation, planAutomation, type AutomationDefinition, type EventEnvelope, type Plan } from "@xevrion/platform";
import { TenantDb, newId } from "../lib/db.js";
import { log } from "../lib/log.js";
import { categoriseTransaction } from "./categorise.js";
import { Outbox } from "./events.js";
import { meterStmt } from "./usage.js";

export interface AutomationRow {
  id: string;
  name: string;
  definition_json: string;
  enabled: number;
}
const loadDef = (r: AutomationRow): AutomationDefinition | null => {
  const p = parseAutomation({ ...JSON.parse(r.definition_json), enabled: !!r.enabled });
  return p.ok ? p.value : null;
};

async function runsLastHour(db: TenantDb, automationId: string): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  return (
    (
      await db.first<{ n: number }>(
        "select count(*) n from automation_runs where tenant_id = ?1 and automation_id = ?2 and dry_run = 0 and status = 'succeeded' and created_at >= ?3",
        automationId,
        since,
      )
    )?.n ?? 0
  );
}

export interface ActionResult {
  index: number;
  type: string;
  outcome: "done" | "already_done" | "would_do" | "error";
  detail?: string;
}

/**
 * Execute (or dry-run) one automation for one event. Each action is idempotent: action_executions is keyed by
 * `<automation>:<event>:<index>`, so queue redelivery or a replayed event never applies an action twice.
 * Events emitted by actions carry the causation chain for loop protection.
 */
// eslint-disable-next-line complexity -- known debt (docs/quality.md): split in a follow-up
export async function runAutomation(
  db: TenantDb,
  row: AutomationRow,
  ev: EventEnvelope,
  dryRun: boolean,
): Promise<{ plan: Plan; results: ActionResult[]; emitted: string[]; runId: string | null }> {
  const def = loadDef(row);
  if (!def) return { plan: { automationId: row.id, eventId: ev.id, matched: false, actions: [] }, results: [], emitted: [], runId: null };
  const plan = planAutomation({ id: row.id, def }, ev, dryRun ? 0 : await runsLastHour(db, row.id));
  const results: ActionResult[] = [];
  const outbox = new Outbox(db);
  const actor = `automation:${row.id}`;
  const chain = [...ev.causationChain, `automation:${row.id}:${ev.id}`];
  if (!dryRun && !plan.matched && plan.skipped !== "rate_capped") return { plan, results, emitted: [], runId: null }; // don't log non-matches
  for (const a of plan.actions) {
    if (dryRun) {
      results.push({ index: a.index, type: a.action.type, outcome: "would_do" });
      continue;
    }
    const done = await db.first("select outcome from action_executions where tenant_id = ?1 and idempotency_key = ?2", a.idempotencyKey);
    if (done) {
      results.push({ index: a.index, type: a.action.type, outcome: "already_done" });
      continue;
    }
    try {
      const txnId = (ev.data as { transactionId?: string }).transactionId;
      const mark = db.stmt(
        "insert or ignore into action_executions (tenant_id, idempotency_key, run_id, action_type, outcome) values (?1, ?2, ?3, ?4, 'done')",
        a.idempotencyKey,
        ev.id,
        a.action.type,
      );
      switch (a.action.type) {
        case "categorise_transaction":
          await categoriseTransaction(db, actor, txnId!, a.action.categoryCode, a.action.vatRateCode, 0, {
            outbox,
            method: "automation",
            causationChain: chain,
            extra: [mark],
          });
          break;
        case "tag_transaction":
          await db.batch([db.stmt("insert or ignore into transaction_tags (tenant_id, transaction_id, tag) values (?1, ?2, ?3)", txnId!, a.action.tag), mark]);
          break;
        case "open_exception": {
          const exId = newId();
          outbox.add(
            "exception.opened",
            { exceptionId: exId, reasonCode: a.action.reasonCode, severity: a.action.severity, subjectId: txnId ?? null, message: a.action.message },
            actor,
            chain,
          );
          const job = await db.first<{ job_id: string | null }>("select job_id from transactions where tenant_id = ?1 and id = ?2", txnId ?? "");
          if (!job?.job_id) throw new Error("open_exception needs a transaction that belongs to a job");
          await db.batch([
            db.stmt(
              "insert into exceptions (tenant_id, id, job_id, stage, reason, reason_code, subject_type, subject_id, payload_json) values (?1, ?2, ?3, 'automation', ?4, ?5, 'transaction', ?6, ?7)",
              exId,
              job.job_id,
              a.action.message,
              a.action.reasonCode,
              txnId ?? null,
              JSON.stringify({ severity: a.action.severity, automationId: row.id, eventId: ev.id }),
            ),
            ...outbox.stmts.splice(0),
            mark,
          ]);
          break;
        }
        case "emit_notification":
          // Event-only notification: shows up in the activity feed / webhooks / realtime. Never sends email.
          await db.batch([
            db.stmt(
              "insert into audit_log (tenant_id, id, actor, action, subject, meta_json) values (?1, ?2, ?3, 'automation.notification', ?4, ?5)",
              newId(),
              actor,
              ev.id,
              JSON.stringify({ message: a.action.message }),
            ),
            mark,
          ]);
          break;
      }
      results.push({ index: a.index, type: a.action.type, outcome: "done" });
    } catch (e) {
      results.push({ index: a.index, type: a.action.type, outcome: "error", detail: String((e as Error).message).slice(0, 200) });
      log("warn", "automation.action_failed", { tenant: db.tenantId, automation: row.id, event: ev.id, err: String(e) });
    }
  }
  const status = plan.skipped ? "skipped" : results.some((r) => r.outcome === "error") ? "failed" : "succeeded";
  const runId = newId();
  await db.batch([
    db.stmt(
      dryRun
        ? "insert into automation_runs (tenant_id, id, automation_id, event_id, dry_run, status, skipped_reason, result_json) values (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)"
        : "insert or ignore into automation_runs (tenant_id, id, automation_id, event_id, dry_run, status, skipped_reason, result_json) values (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)",
      runId,
      row.id,
      ev.id,
      status,
      plan.skipped ?? null,
      JSON.stringify({ results, failedCondition: plan.failedCondition ?? null }),
    ),
    ...(dryRun ? [] : [meterStmt(db, "automation_runs")]),
  ]);
  return { plan, results, emitted: outbox.events.map((e) => e.id), runId };
}
