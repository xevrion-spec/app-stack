/** Writes the OpenAPI document generated from the zod route definitions to /openapi/openapi.json (committed; CI diffs it). */
import { writeFileSync } from "node:fs";
import { createApp } from "../src/app.js";

const res = await createApp().request("/openapi.json", {}, { ENVIRONMENT: "test", ALLOWED_ORIGINS: "" } as never);
const doc = await res.json();
writeFileSync(new URL("../../../openapi/openapi.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");
console.log(`openapi: ${Object.keys((doc as { paths: object }).paths).length} paths`);
