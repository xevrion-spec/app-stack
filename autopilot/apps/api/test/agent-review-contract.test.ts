import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { checkResponse, validate, spec } from "./openapi-contract.js";
import { dispatchEvents } from "../src/services/dispatch.js";
import { __setWebhookFetcher } from "../src/services/webhooks.js";
import { __setAgentReviewPollMs } from "../src/routes/agent-reviews.js";

/**
 * Contract tests: every agent-review endpoint, success and error paths, validated against the published OpenAPI
 * document (status documented, content-type, body schema, no undocumented fields). Drift fails here, not in a customer's SDK.
 */
const A = "owner@example.test",
  RV = "reviewer@example.test";
afterEach(() => {
  __setWebhookFetcher(null);
  __setAgentReviewPollMs(null);
});

async function setup() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const h = makeEnv({ RECEIPT_SIGNING_JWK: JSON.stringify({ ...((await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey), kid: "c1" }) });
  const raw = client(h.env);
  const problems: string[] = [];
  const seen = new Set<string>();
  const call: typeof raw = async (method, path, opts) => {
    const r = await raw(method, path, opts);
    seen.add(`${method} ${path.replace(/\?.*/, "")}`);
    problems.push(...checkResponse(method, path, r.status, r.json, r.headers.get("content-type")));
    return r;
  };
  __setWebhookFetcher(async () => new Response("", { status: 200 }));
  __setAgentReviewPollMs(5);
  return { ...h, call, problems, seen };
}

describe("agent review API contract (OpenAPI)", () => {
  it("full lifecycle: every response matches the published spec", async () => {
    const s = await setup();
    await s.call("POST", "/v1/tenants", { user: A, body: { name: "Contract Co (synthetic)" } });
    await s.call("POST", "/v1/users", { user: A, body: { email: RV, role: "reviewer" } });
    const p = (await s.call("POST", "/v1/review-projects", { user: A, body: { name: "c" } })).json;
    await s.call("GET", "/v1/review-projects", { user: A });
    await s.call("POST", `/v1/review-projects/${p.id}/rotate-callback-secret`, { user: A });
    const doc = { rules: [{ id: "lo", when: { risk: ["low"], minConfidence: 0.9 }, then: { outcome: "auto_approve" } }] };
    await s.call("POST", `/v1/review-projects/${p.id}/policies`, { user: A, body: { document: doc } });
    await s.call("GET", `/v1/review-projects/${p.id}/policies`, { user: A });
    await s.call("POST", `/v1/review-projects/${p.id}/policies/replay`, { user: A, body: { version: 1 } });
    await s.call("POST", `/v1/review-projects/${p.id}/policies/1/activate`, { user: A, body: {} });
    await s.call("PUT", "/v1/review-groups/finance", { user: A, body: { members: [RV] } });
    await s.call("GET", "/v1/review-groups", { user: A });
    const key = (await s.call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["reviews:write", "reviews:read"], projectId: p.id } })).json.key;
    const bearer = { authorization: `Bearer ${key}` };
    await s.call("POST", "/v1/agent-reviews/simulate", { headers: bearer, body: { request: { action: "a.b", payload: {}, risk: "low", confidence: 0.95 } } });
    const auto = (await s.call("POST", "/v1/agent-reviews", { headers: bearer, body: { action: "a.b", payload: { n: 1 }, risk: "low", confidence: 0.95 } }))
      .json;
    const r = (
      await s.call("POST", "/v1/agent-reviews", {
        headers: bearer,
        body: {
          action: "email.send",
          payload: { to: "x@example.test" },
          risk: "medium",
          context: { t: 1 },
          tags: ["t"],
          externalId: "e1",
          callbackUrl: "https://cb.example.test/h",
        },
      })
    ).json;
    await s.call("GET", "/v1/agent-reviews?status=pending", { headers: bearer });
    await s.call("GET", `/v1/agent-reviews/${r.id}`, { headers: bearer });
    await s.call("GET", `/v1/agent-reviews/${r.id}/wait?timeoutSeconds=0`, { headers: bearer });
    await s.call("GET", `/v1/agent-reviews/${r.id}/audit`, { user: A });
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: RV, body: { decision: "edit", payload: { to: "y@example.test" }, reason: "typo" } });
    for (const m of s.events.splice(0)) await dispatchEvents(s.env, m.tenantId, m.eventIds, () => 0.5);
    await s.call("GET", `/v1/agent-reviews/${r.id}/callbacks`, { headers: bearer });
    await s.call("POST", `/v1/agent-reviews/${r.id}/callbacks/redeliver`, { headers: bearer });
    await s.call("GET", `/v1/agent-reviews/${r.id}/receipt`, { headers: bearer });
    await s.call("GET", `/v1/agent-reviews/${auto.id}/evidence`, { user: A });
    await s.call("GET", "/v1/agent-review/receipt-keys", { headers: bearer });
    const c = (await s.call("POST", "/v1/agent-reviews", { headers: bearer, body: { action: "x.y", payload: {} } })).json;
    await s.call("POST", `/v1/agent-reviews/${c.id}/cancel`, { headers: bearer, body: {} });
    await s.call("PUT", `/v1/review-projects/${p.id}/retention`, { user: A, body: { retentionDays: 90 } });
    await s.call("POST", `/v1/agent-reviews/${c.id}/legal-hold`, { user: A, body: { reason: "synthetic hold" } });
    await s.call("DELETE", `/v1/agent-reviews/${c.id}/legal-hold`, { user: A });
    await s.call("POST", `/v1/agent-reviews/${c.id}/redact`, { user: A });
    await s.call("GET", "/v1/agent-review/usage", { user: A });
    await s.call("GET", "/v1/agent-review/analytics/reviewers", { user: A });
    const nch = (
      await s.call("POST", "/v1/notify/channels", {
        user: A,
        body: { kind: "slack", name: "#c", url: "https://hooks.slack.example.test/x", signingSecret: "slack-signing-c" },
      })
    ).json;
    await s.call("GET", "/v1/notify/channels", { user: A });
    await s.call("PUT", `/v1/notify/channels/${nch.id}/identities`, { user: A, body: { externalId: "U1", email: A } });
    await s.call("POST", `/v1/notify/channels/${nch.id}/test`, { user: A });
    await s.call("GET", `/v1/agent-reviews/${c.id}/notifications`, { user: A });
    await s.call("POST", "/v1/notify/deliveries/none/retry", { user: A });
    await s.call("DELETE", `/v1/notify/channels/${nch.id}`, { user: A });
    await s.call("GET", `/v1/review-projects/${p.id}/regulator-pack?from=2020-01-01T00:00:00Z&to=2020-06-01T00:00:00Z`, { user: A });
    await s.call("GET", "/v1/agent-review/analytics/outcomes?hourlyCost=40&minutesPerDecision=2&currency=GBP", { user: A });
    await s.call("GET", `/v1/review-projects/${p.id}/suggestions`, { user: A });
    await s.call("PUT", "/v1/agent-review/audit-sink", { user: A, body: { url: "https://siem.example.test/in" } });
    await s.call("GET", "/v1/agent-review/audit-sink", { user: A });
    await s.call("POST", "/v1/agent-review/audit-sink/resume", { user: A });
    await s.call("POST", "/v1/agent-review/audit-sink/rotate-secret", { user: A });
    await s.call("DELETE", "/v1/agent-review/audit-sink", { user: A });
    expect(s.problems).toEqual([]);
    // Coverage of the contract itself: every documented agent-review operation was exercised (stream and export are text, checked below).
    const documented = Object.entries(spec.paths)
      .filter(([pth]) => /agent-review|review-projects|review-groups/.test(pth))
      .flatMap(([pth, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${pth}`));
    const exercised = [...s.seen].map((x) =>
      x
        .replace(/\/[0-9a-f-]{36}/g, "/{id}")
        .replace(/policies\/1\//, "policies/{version}/")
        .replace("/review-groups/finance", "/review-groups/{name}")
        .replace(/review-projects\/\{id\}/, "review-projects/{id}"),
    );
    const missing = documented.filter((d) => !exercised.includes(d) && !/\/stream$|\/audit\/export$/.test(d));
    expect(missing).toEqual([]);
  });

  it("error responses on these endpoints use the documented error envelope and statuses", async () => {
    const s = await setup();
    await s.call("POST", "/v1/tenants", { user: A, body: { name: "Errors Co (synthetic)" } });
    const p = (await s.call("POST", "/v1/review-projects", { user: A, body: { name: "e" } })).json;
    const key = (await s.call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["reviews:write"], projectId: p.id } })).json.key;
    const bearer = { authorization: `Bearer ${key}` };
    const statuses = [
      (await s.call("POST", "/v1/agent-reviews", { headers: bearer, body: { action: "BAD", payload: {} } })).status,
      (await s.call("GET", "/v1/agent-reviews/nope", { headers: bearer })).status,
      (await s.call("POST", "/v1/review-projects", { headers: bearer, body: { name: "x" } })).status,
      (await s.call("POST", "/v1/agent-reviews", { headers: { authorization: "Bearer ap_invalid" }, body: { action: "a", payload: {} } })).status,
      (await s.call("POST", `/v1/review-projects/${p.id}/policies`, { user: A, body: { document: { rules: [], default: { outcome: "auto_approve" } } } }))
        .status,
      (await s.call("POST", "/v1/agent-reviews", { headers: { ...bearer, "idempotency-key": "k1" }, body: { action: "a.b", payload: { a: 1 } } })).status,
      (await s.call("POST", "/v1/agent-reviews", { headers: { ...bearer, "idempotency-key": "k1" }, body: { action: "a.b", payload: { a: 2 } } })).status,
    ];
    expect(statuses).toEqual([400, 404, 403, 401, 400, 201, 409]);
    expect(s.problems).toEqual([]);
  });

  it("stream and NDJSON export use their documented media types", async () => {
    const s = await setup();
    await s.call("POST", "/v1/tenants", { user: A, body: { name: "Stream Co (synthetic)" } });
    const p = (await s.call("POST", "/v1/review-projects", { user: A, body: { name: "s" } })).json;
    const r = (await s.call("POST", "/v1/agent-reviews", { user: A, body: { projectId: p.id, action: "a.b", payload: {} } })).json;
    const st = await s.call("GET", `/v1/agent-reviews/${r.id}/stream?maxSeconds=1`, { user: A });
    const ex = await s.call("GET", "/v1/agent-review/audit/export", { user: A });
    expect([st.headers.get("content-type"), ex.headers.get("content-type")]).toEqual(["text/event-stream", "application/x-ndjson"]);
    expect(s.problems).toEqual([]);
    expect(validate({ type: "object", properties: { a: { type: "string" } } }, { a: "x", b: 1 })).toEqual(["$.b: undocumented field"]); // the validator is strict
  });
});
