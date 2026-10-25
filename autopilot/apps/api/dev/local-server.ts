/**
 * Docker-free local API: `npm run local` (from autopilot/). Real app code, SQLite file DB, filesystem R2, in-process queue.
 * Dev auth: send `x-dev-user: you@example.test` (rejected when ENVIRONMENT=production).
 */
import { serve } from "@hono/node-server";
import { join, resolve } from "node:path";
import { createApp } from "../src/app.js";
import { makeLocalEnv } from "./local-env.js";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(import.meta.url).replace(/[\\/][^\\/]*$/, "");

const dataDir = resolve(process.env.AUTOPILOT_DATA_DIR ?? join(HERE, "../../../.local"));
const port = Number(process.env.PORT ?? 8787);
const { env } = makeLocalEnv(dataDir, {
  ...(process.env.LLM_BASE_URL ? { LLM_BASE_URL: process.env.LLM_BASE_URL, LLM_API_KEY: process.env.LLM_API_KEY, LLM_MODEL: process.env.LLM_MODEL } : {}),
});
const app = createApp();
serve({ fetch: (req) => app.fetch(req, env), port, hostname: "127.0.0.1" }, (i) =>
  console.log(`autopilot local API on http://127.0.0.1:${i.port} (data: ${dataDir})`),
);
