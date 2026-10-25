/**
 * Temporal worker for the monthly close workflow.
 *   npm run worker -w packages/workflows            # connects to TEMPORAL_ADDRESS (default localhost:7233)
 *   npm run worker -w packages/workflows -- --demo  # no server needed: starts Temporal's dev server, runs one synthetic close against the local API
 * Env: AUTOPILOT_API (default http://127.0.0.1:8787), AUTOPILOT_DEV_USER (dev only), CF_ACCESS_CLIENT_ID/SECRET (prod service token).
 */
import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./index.js";

const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));
const headers: Record<string, string> =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? { "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET }
    : {};
const activities = createActivities({
  baseUrl: process.env.AUTOPILOT_API ?? "http://127.0.0.1:8787",
  headers,
  ...(process.env.AUTOPILOT_DEV_USER ? { devUser: process.env.AUTOPILOT_DEV_USER } : {}),
});

if (process.argv.includes("--demo")) {
  const { TestWorkflowEnvironment } = await import("@temporalio/testing");
  const env = await TestWorkflowEnvironment.createLocal();
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: TASK_QUEUE, workflowsPath, activities });
  const csv = "Date,Description,Amount\n02/09/2026,STRIPE PAYOUT DEMO,500.00\n03/09/2026,GITHUB INC,-4.00\n";
  const res = await worker.runUntil(
    env.client.workflow.execute("monthlyClose", {
      taskQueue: TASK_QUEUE,
      workflowId: `monthly-close-demo-${Date.now()}`,
      args: [{ csv, periodStart: "2026-07-01", periodEnd: "2026-09-30", reviewTimeout: "10 seconds", reviewPoll: "2 seconds", processingPoll: "1 second" }],
    }),
  );
  console.log(JSON.stringify(res, null, 2));
  await env.teardown();
} else {
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
  const worker = await Worker.create({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default", taskQueue: TASK_QUEUE, workflowsPath, activities });
  console.log(`temporal worker on ${TASK_QUEUE}`);
  await worker.run();
}
