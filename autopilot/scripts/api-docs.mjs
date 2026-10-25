// Regenerates docs/api-reference.md from openapi/openapi.json.
import { readFileSync, writeFileSync } from "node:fs";
const d = JSON.parse(readFileSync(new URL("../openapi/openapi.json", import.meta.url), "utf8"));
const out = [
  "# API reference",
  "",
  "Generated from `openapi/openapi.json` (source of truth: zod schemas in `apps/api/src`). Regenerate with `npm run openapi && npm run docs:api`.",
  "",
  "Auth: Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`). Local dev only: `x-dev-user: <email>`. Optional `x-tenant-id` selects a tenant; `Idempotency-Key` makes unsafe requests replay-safe. Errors: `{ error: { code, message, requestId, details? } }`.",
  "",
  "| Method | Path | Summary | Tag |",
  "|---|---|---|---|",
];
for (const [p, ops] of Object.entries(d.paths)) for (const [m, o] of Object.entries(ops)) out.push(`| ${m.toUpperCase()} | \`${p}\` | ${o.summary ?? ""} | ${(o.tags ?? []).join(", ")} |`);
writeFileSync(new URL("../docs/api-reference.md", import.meta.url), out.join("\n") + "\n");
