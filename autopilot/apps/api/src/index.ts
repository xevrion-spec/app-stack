import type { Env, QueueMessage } from "./env.js";
import { createApp } from "./app.js";
import { handleDeadLetters, handlePipelineBatch } from "./queue.js";
import { sweep } from "./services/dispatch.js";
import { log } from "./lib/log.js";

export { TenantRealtime } from "./realtime.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    if (batch.queue.endsWith("-dlq")) return handleDeadLetters(batch, env);
    return handlePipelineBatch(batch, env);
  },
  /** Cron (every minute): outbox sweeper + webhook retries. */
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweep(env).then((r) => log("info", "sweep", r)));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
