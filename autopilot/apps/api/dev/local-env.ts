/** Builds a Node-side Env for the Docker-free local run: SQLite-backed D1, filesystem R2, in-process queue. */
import { sweep } from "../src/services/dispatch.js";
import { maybeRunDaily } from "../src/services/schedules.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Env, QueueMessage } from "../src/env.js";
import { makeSqliteD1 } from "./sqlite-d1.js";
import { handlePipelineBatch, handleDeadLetters } from "../src/queue.js";

export function makeLocalEnv(dataDir: string, over: Partial<Env> = {}) {
  mkdirSync(join(dataDir, "r2"), { recursive: true });
  const { d1, raw } = makeSqliteD1(join(dataDir, "autopilot.db"));
  const kv = new Map<string, string>();
  const r2Path = (k: string) => join(dataDir, "r2", k.replace(/\.\./g, "_"));
  const DOCS = {
    put: async (k: string, v: ArrayBuffer) => {
      mkdirSync(dirname(r2Path(k)), { recursive: true });
      writeFileSync(r2Path(k), Buffer.from(v));
      return { key: k };
    },
    get: async (k: string) =>
      existsSync(r2Path(k)) ? { arrayBuffer: async () => readFileSync(r2Path(k)).buffer, text: async () => readFileSync(r2Path(k), "utf8") } : null,
    delete: async (k: string) => rmSync(r2Path(k), { force: true }),
  } as unknown as R2Bucket;
  const env: Env = {
    DB: d1,
    DOCS,
    CONFIG: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) } as unknown as KVNamespace,
    PIPELINE: undefined as unknown as Queue<QueueMessage>,
    ENVIRONMENT: "development",
    ALLOWED_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
    ...over,
  };
  /** In-process queue with the same retry/DLQ semantics as Cloudflare Queues (max 3 retries). */
  const deliver = (body: QueueMessage, attempts = 1): void => {
    setTimeout(async () => {
      let outcome = "ack" as "ack" | "retry";
      const msg = { id: crypto.randomUUID(), timestamp: new Date(), body, attempts, ack: () => (outcome = "ack"), retry: () => (outcome = "retry") };
      await handlePipelineBatch({ queue: "autopilot-pipeline", messages: [msg] } as unknown as MessageBatch<QueueMessage>, env);
      if (outcome === "retry") {
        if (attempts >= 4)
          await handleDeadLetters({ queue: "autopilot-pipeline-dlq", messages: [{ ...msg, ack: () => {} }] } as unknown as MessageBatch<QueueMessage>, env);
        else deliver(body, attempts + 1);
      }
    }, 25);
  };
  env.PIPELINE = {
    send: async (m: QueueMessage) => deliver(m),
    sendBatch: async (ms: { body: QueueMessage }[]) => ms.forEach((m) => deliver(m.body)),
  } as unknown as Queue<QueueMessage>;
  // Local cron: outbox sweeper + webhook retries every 30 s (what the Workers cron does in production).
  if (over.ENVIRONMENT !== "test")
    setInterval(() => {
      void sweep(env).catch(() => {});
      void maybeRunDaily(env).catch(() => {});
    }, 30_000).unref?.();
  env.WEBHOOK_DEV_HTTP_HOSTS ??= "127.0.0.1,localhost";
  if (process.env.RATE_LIMIT_PER_MINUTE) env.RATE_LIMIT_PER_MINUTE = process.env.RATE_LIMIT_PER_MINUTE;
  return { env, raw };
}
