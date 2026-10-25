import { describe, it, expect, afterEach } from "vitest";
import { verifySignature } from "@xevrion/platform";
import { makeEnv, client } from "./harness.js";
import { __setWebhookFetcher, __setWebhookClock } from "../src/services/webhooks.js";
import { sweepAuditSinks, cefLine, STREAM_BATCH, STREAM_MAX_ATTEMPTS } from "../src/services/audit-stream.js";

const A = "owner-sink@example.test",
  R1 = "reviewer-sink@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
type Hit = { url: string; body: string; headers: Record<string, string> };
let hits: Hit[] = [];
let reply: () => number = () => 200;
afterEach(() => {
  __setWebhookFetcher(null);
  __setWebhookClock(null);
});

async function setup() {
  hits = [];
  reply = () => 200;
  __setWebhookFetcher(async (url, init) => {
    hits.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response("ok", { status: reply() });
  });
  const h = makeEnv({ RATE_LIMIT_API_KEY_PER_MINUTE: "1000000" });
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Sink Co (synthetic)" } });
  await call("POST", "/v1/users", { user: A, body: { email: R1, role: "reviewer" } });
  const p = (await call("POST", "/v1/review-projects", { user: A, body: { name: "s" } })).json;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["reviews:write"], projectId: p.id } })).json.key as string;
  const create = () => call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action: "a.b", payload: { secret: "SYN-PAYLOAD" } } });
  const sink = (body: Record<string, unknown> = {}) =>
    call("PUT", "/v1/agent-review/audit-sink", { user: A, body: { url: "https://siem.example.test/in", ...body } });
  const lines = () => hits.flatMap((x) => x.body.trim().split("\n")).map((l) => JSON.parse(l) as { requestId: string; seq: number; at: string });
  return { ...h, call, key, create, sink, lines };
}

describe("audit streaming push sink (A10b)", () => {
  it("is owner-only, SSRF-guarded, shows the secret once, and starts from now by default", async () => {
    const s = await setup();
    await s.create();
    expect((await s.call("PUT", "/v1/agent-review/audit-sink", { user: R1, body: { url: "https://siem.example.test/in" } })).status).toBe(403);
    expect((await s.call("PUT", "/v1/agent-review/audit-sink", { headers: bearer(s.key), body: { url: "https://siem.example.test/in" } })).status).toBe(403);
    expect((await s.sink({ url: "http://169.254.169.254/latest" })).status).toBe(400);
    expect((await s.call("GET", "/v1/agent-review/audit-sink", { user: A })).status).toBe(404);
    const made = await s.sink();
    expect(made.status).toBe(200);
    expect(made.json.secret).toMatch(/^whsec_/);
    expect((await s.call("GET", "/v1/agent-review/audit-sink", { user: A })).json.secret).toBeUndefined();
    expect(await sweepAuditSinks(s.env)).toMatchObject({ sinks: 1, delivered: 0 }); // history before "now" is not pushed
    expect(hits).toHaveLength(0);
    const r = (await s.create()).json;
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve", reason: "ok" } });
    expect(await sweepAuditSinks(s.env)).toMatchObject({ delivered: 1 });
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.headers["content-type"]).toBe("application/x-ndjson");
    expect(await verifySignature([made.json.secret], h.headers["autopilot-signature"], h.body, Math.floor(Date.now() / 1000))).toEqual({ ok: true });
    expect(s.lines().map((e) => [e.requestId, e.seq])).toEqual([
      [r.id, 1],
      [r.id, 2],
    ]);
    expect(h.body).not.toContain("SYN-PAYLOAD"); // content-free
    expect(h.headers["autopilot-batch-count"]).toBe("2");
    const st = (await s.call("GET", "/v1/agent-review/audit-sink", { user: A })).json;
    expect(st).toMatchObject({ delivered: 2, status: "active", attempt: 0, cursor: { requestId: r.id, seq: 2 } });
    expect(await sweepAuditSinks(s.env)).toMatchObject({ delivered: 0 }); // idle, nothing re-sent
    expect(hits).toHaveLength(1);
  });

  it("retries with backoff without moving the cursor, re-sends the same batch id, pauses on 4xx and resumes losslessly", async () => {
    const s = await setup();
    await s.sink({ from: "beginning" });
    await s.create();
    reply = () => 503;
    expect(await sweepAuditSinks(s.env)).toMatchObject({ failed: 1 });
    const st = (await s.call("GET", "/v1/agent-review/audit-sink", { user: A })).json;
    expect(st).toMatchObject({ attempt: 1, lastStatus: 503, lastError: "http_503", delivered: 0, cursor: { at: "", seq: 0 } });
    expect(Date.parse(st.nextAttemptAt)).toBeGreaterThan(Date.now());
    expect(await sweepAuditSinks(s.env)).toMatchObject({ sinks: 0 }); // not due yet
    __setWebhookClock(() => Date.now() + 3600_000);
    reply = () => 200;
    expect(await sweepAuditSinks(s.env)).toMatchObject({ delivered: 1 });
    expect(hits[1]!.headers["autopilot-batch-id"]).toBe(hits[0]!.headers["autopilot-batch-id"]);
    expect(hits[1]!.body).toBe(hits[0]!.body);
    await s.create();
    reply = () => 400;
    expect(await sweepAuditSinks(s.env)).toMatchObject({ paused: 1 });
    expect((await s.call("GET", "/v1/agent-review/audit-sink", { user: A })).json.status).toBe("paused");
    await s.create();
    reply = () => 200;
    expect(await sweepAuditSinks(s.env)).toMatchObject({ sinks: 0 });
    expect((await s.call("POST", "/v1/agent-review/audit-sink/resume", { user: A })).json.status).toBe("active");
    expect(await sweepAuditSinks(s.env)).toMatchObject({ delivered: 1 });
    const delivered = hits.filter((_, i) => i !== 0 && i !== 2).flatMap((x) => x.body.trim().split("\n"));
    expect(delivered).toHaveLength(3); // 1 (retried batch) + 2 after resume; nothing skipped
  });

  it("gives up after the retry budget (pauses) and treats network errors as retryable", async () => {
    const s = await setup();
    await s.sink({ from: "beginning" });
    await s.create();
    __setWebhookFetcher(async () => {
      throw new TypeError("fetch failed");
    });
    let t = Date.now();
    for (let i = 1; i < STREAM_MAX_ATTEMPTS; i++) {
      __setWebhookClock(() => t);
      expect(await sweepAuditSinks(s.env)).toMatchObject({ failed: 1 });
      t += 7 * 3600_000;
    }
    __setWebhookClock(() => t);
    expect(await sweepAuditSinks(s.env)).toMatchObject({ paused: 1 });
    expect((await s.call("GET", "/v1/agent-review/audit-sink", { user: A })).json).toMatchObject({
      status: "paused",
      attempt: STREAM_MAX_ATTEMPTS,
      lastError: "network_error",
    });
  });

  it("loses nothing and repeats nothing when many entries share one timestamp (push and pull cursors)", async () => {
    const s = await setup();
    await s.sink({ from: "beginning" });
    const n = STREAM_BATCH + 37;
    for (let i = 0; i < n; i++) await s.create();
    s.raw.prepare("update review_ledger set at = '2026-10-25T12:00:00.000Z'").run();
    const r = await sweepAuditSinks(s.env, 10);
    expect(r).toMatchObject({ delivered: 2 });
    const got = s.lines().map((e) => `${e.requestId}:${e.seq}`);
    expect(got).toHaveLength(n);
    expect(new Set(got).size).toBe(n);
    // pull export with the opaque cursor pages through the same set exactly
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await s.call("GET", `/v1/agent-review/audit/export?limit=200${cursor ? `&cursor=${cursor}` : ""}`, { user: A });
      const rows = res.text.trim()
        ? res.text
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { requestId: string; seq: number })
        : [];
      seen.push(...rows.map((e) => `${e.requestId}:${e.seq}`));
      cursor = res.headers.get("next-cursor")!;
      if (!rows.length) break;
    }
    expect(seen.sort()).toEqual([...got].sort());
    expect((await s.call("GET", "/v1/agent-review/audit/export?cursor=bm9wZQ", { user: A })).status).toBe(400);
  });

  it("CEF output escapes and rotation/deletion are audited", async () => {
    const line = cefLine({
      requestId: "r=1",
      seq: 3,
      kind: "decided",
      actor: "a\\b=c",
      at: "2026-10-25T12:00:00.000Z",
      data: { decision: "reject" },
      prevHash: "p",
      hash: "h",
    });
    expect(line).toBe(
      `CEF:0|Xevrion|AgentReview|1|review.decided|Agent review decided|6|rt=${Date.parse("2026-10-25T12:00:00.000Z")} suser=a\\\\b\\=c externalId=r\\=1 cn1=3 cn1Label=seq cs1=h cs1Label=entryHash act=reject`,
    );
    const s = await setup();
    await s.sink({ format: "cef", from: "beginning" });
    await s.create();
    await sweepAuditSinks(s.env);
    expect(hits[0]!.headers["content-type"]).toBe("text/plain");
    expect(hits[0]!.body.startsWith("CEF:0|Xevrion|AgentReview|1|review.requested|")).toBe(true);
    const rot = await s.call("POST", "/v1/agent-review/audit-sink/rotate-secret", { user: A });
    expect(rot.json.secret).toMatch(/^whsec_/);
    expect((await s.call("DELETE", "/v1/agent-review/audit-sink", { user: A })).json).toEqual({ deleted: true });
    expect((await s.call("DELETE", "/v1/agent-review/audit-sink", { user: A })).status).toBe(404);
    const acts = (s.raw.prepare("select action from audit_log where action like 'audit_sink.%' order by created_at").all() as { action: string }[]).map(
      (a) => a.action,
    );
    expect(acts).toEqual(["audit_sink.configured", "audit_sink.secret_rotated", "audit_sink.deleted"]);
  });
});
