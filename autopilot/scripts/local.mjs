#!/usr/bin/env node
/**
 * Docker-free local run: seeds (if needed), starts the API on :8787 and the web app on :5173.
 * Ctrl+C stops both. Data lives in autopilot/.local (git-ignored, synthetic only).
 */
import { spawn, spawnSync } from "node:child_process";
const win = process.platform === "win32";
const npx = win ? "npx.cmd" : "npx";
const opts = { stdio: "inherit", shell: win };
if (!process.argv.includes("--no-seed")) {
  const r = spawnSync(npx, ["tsx", "scripts/seed.ts"], opts);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const procs = [spawn(npx, ["tsx", "apps/api/dev/local-server.ts"], opts)];
if (!process.argv.includes("--api-only")) procs.push(spawn(npx, ["vite", "--config", "apps/web/vite.config.ts"], { ...opts, env: { ...process.env, VITE_API_BASE: "http://127.0.0.1:8787" } }));
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (c) => { if (c) { console.error("local: a process exited with", c); stop(); } });
