import type { Env, PipelineMessage, QueueMessage } from "./env.js";
import { dispatchEvents } from "./services/dispatch.js";
import { runPipeline } from "./services/pipeline.js";
import { TenantDb, newId } from "./lib/db.js";
import { log } from "./lib/log.js";

/** Main queue: run the pipeline; on error retry with backoff (Cloudflare moves to DLQ after max_retries). */
export async function handlePipelineBatch(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const m of batch.messages) {
    try {
      if (m.body.kind === "events") await dispatchEvents(env, m.body.tenantId, m.body.eventIds);
      else await runPipeline(env, m.body.tenantId, m.body.jobId);
      m.ack();
    } catch (e) {
      log("error", m.body.kind === "events" ? "dispatch.failed" : "pipeline.failed", { tenantId: m.body.tenantId, attempt: m.attempts, err: String(e) });
      m.retry({ delaySeconds: Math.min(300, 10 * 2 ** (m.attempts - 1)) });
    }
  }
}

/** DLQ: mark job failed and raise an exception for humans. Never silently drop. */
export async function handleDeadLetters(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const m of batch.messages) {
    if (m.body.kind === "events") {
      // Outbox rows stay undispatched; the sweeper retries them. Nothing is lost, so just record and ack.
      log("error", "dispatch.dead_letter", { tenantId: m.body.tenantId, events: m.body.eventIds.length, attempts: m.attempts });
      m.ack();
      continue;
    }
    const db = new TenantDb(env.DB, m.body.tenantId);
    await db.batch([
      db.stmt("update jobs set status = 'failed', updated_at = datetime('now') where tenant_id = ?1 and id = ?2", (m.body as PipelineMessage).jobId),
      db.stmt(
        "insert into exceptions (tenant_id, id, job_id, stage, reason, reason_code, payload_json) values (?1, ?2, ?3, 'pipeline', 'Job failed after retries', 'JOB_FAILED', ?4)",
        newId(),
        (m.body as PipelineMessage).jobId,
        JSON.stringify({ attempts: m.attempts }),
      ),
    ]);
    m.ack();
  }
}
