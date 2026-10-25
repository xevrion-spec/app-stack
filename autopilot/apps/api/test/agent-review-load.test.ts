import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { writeFileSync } from "node:fs";
import { makeEnv, client } from "./harness.js";
import { dispatchEvents } from "../src/services/dispatch.js";
import { __setWebhookFetcher } from "../src/services/webhooks.js";

/**
 * A7c load + concurrency. In-process (Hono + SQLite harness), NOT Cloudflare Workers/D1: latencies here are a
 * regression baseline, not production numbers. Size with AR_LOAD_N (default 400). Invariants are checked after the storm.
 */
const N = Number(process.env.AR_LOAD_N ?? 400);
const A = "owner@example.test";
const REVIEWERS = Array.from({ length: 6 }, (_, i) => `rv${i}@example.test`);
afterEach(() => __setWebhookFetcher(null));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function world() {
  const h = makeEnv({ RATE_LIMIT_API_KEY_PER_MINUTE: "1000000", RATE_LIMIT_PER_MINUTE: "1000000" });
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Load Co (synthetic)" } });
  for (const u of REVIEWERS) await call("POST", "/v1/users", { user: A, body: { email: u, role: "reviewer" } });
  const p = (await call("POST", "/v1/review-projects", { user: A, body: { name: "load" } })).json;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["reviews:write", "reviews:read"], projectId: p.id } })).json.key;
  return { ...h, call, bearer: { authorization: `Bearer ${key}` } };
}

/** System-wide invariants that must hold whatever the interleaving. */
async function invariants(s: Awaited<ReturnType<typeof world>>) {
  const q = <T>(sql: string) => s.raw.prepare(sql).all() as T[];
  const problems: string[] = [];
  // 1. no reviewer decided the same payload version twice (except edit chains)
  for (const d of q<{ request_id: string; reviewer: string; payload_version: number; n: number }>(
    "select request_id, reviewer, payload_version, count(*) n from review_decisions where decision != 'edit' group by 1,2,3 having n > 1",
  ))
    problems.push(`duplicate decision ${d.request_id} ${d.reviewer}`);
  // 2. every final request has exactly one review.completed event
  const completed = new Map(
    q<{ rid: string; n: number }>(
      "select json_extract(payload_json, '$.requestId') rid, count(*) n from events where type = 'review.completed' group by 1",
    ).map((r) => [r.rid, r.n]),
  );
  for (const r of q<{ id: string; status: string; chain_seq: number }>("select id, status, chain_seq from review_requests")) {
    const final = ["approved", "rejected", "expired", "cancelled"].includes(r.status);
    if (final !== (completed.get(r.id) === 1)) problems.push(`completed events ${r.id} ${r.status} ${completed.get(r.id) ?? 0}`);
  }
  // 3. ledger length == pinned head seq, and decisions == decided entries
  for (const r of q<{ id: string; chain_seq: number; ledger: number; dec: number; decided: number }>(
    `select r.id, r.chain_seq, (select count(*) from review_ledger l where l.request_id = r.id) ledger,
            (select count(*) from review_decisions d where d.request_id = r.id) dec,
            (select count(*) from review_ledger l where l.request_id = r.id and l.kind = 'decided') decided from review_requests r`,
  )) {
    if (r.chain_seq !== r.ledger) problems.push(`chain ${r.id} ${r.chain_seq} != ${r.ledger}`);
    if (r.dec !== r.decided) problems.push(`decisions ${r.id} ${r.dec} != ${r.decided}`);
  }
  // 4. one callback row per request per event type
  for (const c of q<{ request_id: string; n: number }>("select request_id, count(*) n from review_callbacks group by request_id, event_type having n > 1"))
    problems.push(`callbacks ${c.request_id}`);
  return problems;
}

describe(`agent review load (${N} requests, in-process)`, () => {
  it("concurrent create + decide storm keeps every invariant; reports latency baseline", async () => {
    const s = await world();
    __setWebhookFetcher(async () => new Response("", { status: 200 }));
    const lat: Record<string, number[]> = { create: [], decide: [], read: [] };
    const timed = async <T>(k: string, f: () => Promise<T>) => {
      const t = performance.now();
      const r = await f();
      lat[k]!.push(performance.now() - t);
      return r;
    };
    const t0 = performance.now();
    const ids: string[] = [];
    for (let b = 0; b < N; b += 50)
      ids.push(
        ...(
          await Promise.all(
            Array.from({ length: Math.min(50, N - b) }, (_, i) =>
              timed("create", () =>
                s.call("POST", "/v1/agent-reviews", {
                  headers: { ...s.bearer, "idempotency-key": `L${b + i}` },
                  body: {
                    action: "load.op",
                    risk: (b + i) % 7 === 0 ? "critical" : "medium",
                    payload: { i: b + i },
                    ...((b + i) % 3 === 0 ? { callbackUrl: "https://cb.example.test/h" } : {}),
                  },
                }),
              ),
            ),
          )
        ).map((r) => {
          expect(r.status).toBe(201);
          return r.json.id as string;
        }),
      );
    // duplicate creates under the same keys (client retries) must not add rows
    const dup = await Promise.all(
      ids
        .slice(0, 50)
        .map((_, i) =>
          s.call("POST", "/v1/agent-reviews", {
            headers: { ...s.bearer, "idempotency-key": `L${i}` },
            body: {
              action: "load.op",
              risk: i % 7 === 0 ? "critical" : "medium",
              payload: { i },
              ...(i % 3 === 0 ? { callbackUrl: "https://cb.example.test/h" } : {}),
            },
          }),
        ),
    );
    expect(new Set(dup.map((d) => d.json.id)).size).toBe(50);
    // Every request gets 3 concurrent reviewers deciding at once: races on the same row are intended.
    const outcomes: Record<string, number> = {};
    for (let b = 0; b < ids.length; b += 25)
      await Promise.all(
        ids.slice(b, b + 25).flatMap((id, j) =>
          [0, 1, 2].map((k) =>
            timed("decide", async () => {
              const who = REVIEWERS[(b + j + k) % REVIEWERS.length]!;
              const decision = (b + j) % 11 === 0 && k === 2 ? "reject" : "approve";
              // Clients retry 409 version_conflict (a concurrent write won); other 409s (already_final, duplicate) are final answers.
              for (let attempt = 0; attempt < 5; attempt++) {
                const r = await s.call("POST", `/v1/agent-reviews/${id}/decisions`, {
                  user: who,
                  body: { decision, ...(decision === "reject" ? { reason: "load" } : {}) },
                });
                const tag = r.status === 409 ? r.json.error.code : String(r.status);
                outcomes[tag] = (outcomes[tag] ?? 0) + 1;
                if (tag !== "version_conflict") break;
              }
            }),
          ),
        ),
      );
    for (let b = 0; b < ids.length; b += 50)
      await Promise.all(ids.slice(b, b + 50).map((id) => timed("read", () => s.call("GET", `/v1/agent-reviews/${id}`, { headers: s.bearer }))));
    for (let i = 0; i < 20 && s.events.length; i++) for (const m of s.events.splice(0)) await dispatchEvents(s.env, m.tenantId, m.eventIds, () => 0.5);
    const secs = (performance.now() - t0) / 1000;
    expect(Object.keys(outcomes).every((c) => ["200", "version_conflict", "already_final", "duplicate_decision"].includes(c))).toBe(true);
    expect(await invariants(s)).toEqual([]);
    const pending = (s.raw.prepare("select count(*) n from review_requests where status in ('pending','escalated')").get() as { n: number }).n;
    expect(pending).toBe(0); // 3 approvers ≥ every required count (critical = 2)
    const cbs = s.raw.prepare("select status, count(*) n from review_callbacks group by status").all() as { status: string; n: number }[];
    expect(cbs).toEqual([{ status: "succeeded", n: Math.ceil(N / 3) }]);
    const report = Object.fromEntries(
      Object.entries(lat).map(([k, v]) => [k, { n: v.length, p50: +pct(v, 50).toFixed(1), p95: +pct(v, 95).toFixed(1), p99: +pct(v, 99).toFixed(1) }]),
    );
    const out = JSON.stringify({
      load: { requests: N, totalOps: Object.values(lat).reduce((a, v) => a + v.length, 0), seconds: +secs.toFixed(2), outcomes, ms: report },
    });
    if (process.env.AR_LOAD_REPORT) writeFileSync(process.env.AR_LOAD_REPORT, out);
  }, 120_000);

  it("property: any interleaving of concurrent decisions on one request ends consistent with a verifying trail", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.record({ who: fc.integer({ min: 0, max: 4 }), d: fc.constantFrom("approve", "approve", "reject", "escalate", "edit") }), {
          minLength: 1,
          maxLength: 8,
        }),
        async (need, moves) => {
          const s = await world();
          const id = (await s.call("POST", "/v1/agent-reviews", { headers: s.bearer, body: { action: "p.q", payload: { v: 0 }, minApprovals: need } })).json.id;
          await Promise.all(
            moves.map((m, i) =>
              s.call("POST", `/v1/agent-reviews/${id}/decisions`, {
                user: REVIEWERS[m.who]!,
                body: { decision: m.d, ...(m.d === "edit" ? { payload: { v: i + 1 } } : {}), ...(m.d === "reject" ? { reason: "r" } : {}) },
              }),
            ),
          );
          expect(await invariants(s)).toEqual([]);
          const r = (await s.call("GET", `/v1/agent-reviews/${id}`, { headers: s.bearer })).json;
          const integ = (await s.call("GET", `/v1/agent-reviews/${id}/audit`, { user: A })).json.integrity;
          expect(integ.ok).toBe(true);
          if (r.status === "approved") expect(r.approvals).toBeGreaterThanOrEqual(r.requiredApprovals);
          else expect(r.approvals).toBeLessThan(r.requiredApprovals + (r.status === "rejected" ? 5 : 0));
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});
