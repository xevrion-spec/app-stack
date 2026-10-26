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

// Agent review subset: grouped, with request/response schema names, so integrators get one focused page.
const ar = [
  "# Agent review API reference",
  "",
  "Generated from `openapi/openapi.json` by `npm run docs:api`. Base URL: your API host. Agents authenticate with `Authorization: Bearer ap_…` (scopes `reviews:write` / `reviews:read`); people use Cloudflare Access or an SSO session (`Bearer ses_…`). SCIM (`/v1/scim/v2/*`, scope `scim:write`) is plain JSON and not in this spec yet.",
  "",
  "| Method | Path | Summary | Request | Response |",
  "|---|---|---|---|---|",
];
const ref = (s) => (s?.$ref ? s.$ref.split("/").pop() : s?.type ?? "");
for (const [p, ops] of Object.entries(d.paths))
  for (const [m, o] of Object.entries(ops)) {
    const tags = o.tags ?? [];
    if (!tags.includes("Agent review") && !/\/(sso|roles|users\/\{id\}\/custom-role|security\/key-policy)/.test(p)) continue;
    const req = ref(o.requestBody?.content?.["application/json"]?.schema);
    const ok = o.responses?.["200"] ?? o.responses?.["201"];
    ar.push(`| ${m.toUpperCase()} | \`${p}\` | ${o.summary ?? ""} | ${req} | ${ref(ok?.content?.["application/json"]?.schema)} |`);
  }
writeFileSync(new URL("../docs/agent-review/api-reference.md", import.meta.url), ar.join("\n") + "\n");
