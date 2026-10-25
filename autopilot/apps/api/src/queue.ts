import type { Env, PipelineMessage } from "./env.js";
import { runPipeline } from "./services/pipeline.js";
import { TenantDb, newId } from "./lib/db.js";
import { log } from "./lib/log.js";

/** Main queue: run the pipeline; on error retry with backoff (Cloudflare moves to DLQ after max_retries). */
export async function handlePipelineBatch(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
  for (const m of batch.messages) {
    try {
      await runPipeline(env, m.body.tenantId, m.body.jobId);
      m.ack();
    } catch (e) {
      log("error", "pipeline.failed", { jobId: m.body.jobId, attempt: m.attempts, err: String(e) });
      m.retry({ delaySeconds: Math.min(300, 10 * 2 ** (m.attempts - 1)) });
    }
  }
}

/** DLQ: mark job failed and raise an exception for humans. Never silently drop. */
export async function handleDeadLetters(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
  for (const m of batch.messages) {
    const db = new TenantDb(env.DB, m.body.tenantId);
    await db.batch([
      db.stmt("update jobs set status = 'failed', updated_at = datetime('now') where tenant_id = ?1 and id = ?2", m.body.jobId),
      db.stmt(
        "insert into exceptions (tenant_id, id, job_id, stage, reason, reason_code, payload_json) values (?1, ?2, ?3, 'pipeline', 'Job failed after retries', 'JOB_FAILED', ?4)",
        newId(),
        m.body.jobId,
        JSON.stringify({ attempts: m.attempts }),
      ),
    ]);
    m.ack();
  }
}
