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
  "Practice endpoints (`/v1/practice*`): same staff identity; `x-practice-id` selects a firm; API keys are refused; roles partner/manager/preparer/reviewer/readonly; out-of-scope clients return 404. Client portal (`/v1/portal/*`): `Authorization: Bearer ps_…` session from `POST /v1/portal/session` (mock magic link; never emailed); staff identities are not accepted there. Integration adapters are MOCKS unless the catalogue (`GET /v1/practice/integrations`) says `real`.",
  "",
  "| Method | Path | Summary | Tag |",
  "|---|---|---|---|",
];
for (const [p, ops] of Object.entries(d.paths))
  for (const [m, o] of Object.entries(ops)) out.push(`| ${m.toUpperCase()} | \`${p}\` | ${o.summary ?? ""} | ${(o.tags ?? []).join(", ")} |`);
writeFileSync(new URL("../docs/api-reference.md", import.meta.url), out.join("\n") + "\n");
