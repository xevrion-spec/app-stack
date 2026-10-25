/** Writes the OpenAPI document generated from the zod route definitions to /openapi/openapi.json (committed; CI diffs it). */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const res = await createApp().request("/openapi.json", {}, { ENVIRONMENT: "test", ALLOWED_ORIGINS: "" } as never);
const doc = await res.json();
writeFileSync(fileURLToPath(import.meta.url).replace(/apps[\\/]api[\\/]scripts[\\/]openapi\.ts$/, "openapi/openapi.json"), JSON.stringify(doc, null, 2) + "\n");
console.log(`openapi: ${Object.keys((doc as { paths: object }).paths).length} paths`);
