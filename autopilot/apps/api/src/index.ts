import type { Env, PipelineMessage } from "./env.js";
import { createApp } from "./app.js";
import { handleDeadLetters, handlePipelineBatch } from "./queue.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<PipelineMessage>, env: Env) {
    if (batch.queue.endsWith("-dlq")) return handleDeadLetters(batch, env);
    return handlePipelineBatch(batch, env);
  },
} satisfies ExportedHandler<Env, PipelineMessage>;
