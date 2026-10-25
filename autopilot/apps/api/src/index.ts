import type { Env, QueueMessage } from "./env.js";
import { createApp } from "./app.js";
import { handleDeadLetters, handlePipelineBatch } from "./queue.js";
import { sweep } from "./services/dispatch.js";
import { sweepAgentReviews } from "./services/agent-review.js";
import { sweepRetention } from "./services/agent-review-retention.js";
import { maybeRunDaily } from "./services/schedules.js";
import { log } from "./lib/log.js";

export { TenantRealtime } from "./realtime.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    if (batch.queue.endsWith("-dlq")) return handleDeadLetters(batch, env);
    return handlePipelineBatch(batch, env);
  },
  /** Cron (every minute): outbox sweeper + webhook retries; once a day: recurring invoices, reminder events, retention. */
  async scheduled(c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweep(env).then((r) => log("info", "sweep", r)));
    ctx.waitUntil(sweepAgentReviews(env).then((r) => log("info", "agent_review.sweep", r)));
    // agent review retention: hourly (minute 17), bounded batch; held requests are never touched
    if (new Date(c.scheduledTime).getUTCMinutes() === 17) ctx.waitUntil(sweepRetention(env).then((r) => log("info", "agent_review.retention", r)));
    ctx.waitUntil(maybeRunDaily(env).then((r) => (r ? log("info", "daily", { ...r }) : undefined)));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
