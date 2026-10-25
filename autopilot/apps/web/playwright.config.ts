import { defineConfig, devices } from "@playwright/test";

/** Smoke tests against the Docker-free local stack: real API code on SQLite (fresh temp dir) + Vite dev server. */
const dataDir = `${process.env.TMPDIR ?? "/tmp"}/autopilot-e2e-${process.pid}`;
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "npx tsx apps/api/dev/local-server.ts",
      cwd: "../..",
      url: "http://127.0.0.1:8787/health",
      env: { AUTOPILOT_DATA_DIR: dataDir, PORT: "8787" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npx vite --config apps/web/vite.config.ts",
      cwd: "../..",
      url: "http://127.0.0.1:5173",
      env: { VITE_API_BASE: "http://127.0.0.1:8787" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
