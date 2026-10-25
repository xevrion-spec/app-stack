import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";
import * as R from "@xevrion/agent-review";
import { TenantDb } from "../src/lib/db.js";
import { loadReview } from "../src/services/agent-review.js";
import { redactStmts, sweepRetention, REDACTED } from "../src/services/agent-review-retention.js";

const A = "owner-ret@example.test",
  B = "owner-ret-b@example.test",
  R1 = "reviewer-ret@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const SECRET = "SYN-SECRET-ACCT-9911";

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Retention Co (synthetic)" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Other (synthetic)" } });
  await call("POST", "/v1/users", { user: A, body: { email: R1, role: "reviewer" } });
  const project = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Payments agent" } })).json as { id: string };
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes: ["reviews:write"], projectId: project.id } })).json.key as string;
  const tenantId = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  const decided = async (extra: Record<string, unknown> = {}) => {
    const r = (
      await call("POST", "/v1/agent-reviews", {
        headers: bearer(key),
        body: { action: "payment.send", payload: { to: SECRET, amount: 50 }, context: { note: SECRET }, ...extra },
      })
    ).json;
    await call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve", reason: `checked ${SECRET}` } });
    return r.id as string;
  };
  const audit = async (id: string) => (await call("GET", `/v1/agent-reviews/${id}/audit`, { user: A })).json;
  const contentRows = (id: string) =>
    h.raw
      .prepare(
        `select (select count(*) from review_requests where id = @id and (payload_json like @pat or current_payload_json like @pat or context_json like @pat))
              + (select count(*) from review_decisions where request_id = @id and (reason like @pat or payload_json like @pat))
              + (select count(*) from review_callbacks where request_id = @id and body_json like @pat)
              + (select count(*) from events where payload_json like @pat and json_extract(payload_json, '$.requestId') = @id) n`,
      )
      .get({ id, pat: `%${SECRET}%` }) as { n: number };
  return { ...h, call, project, key, tenantId, decided, audit, contentRows };
}

describe("agent review retention + legal hold (A9b)", () => {
  it("erasure removes content everywhere, keeps a verifiable chain with the original payload hash", async () => {
    const s = await setup();
    const id = await s.decided();
    s.raw
      .prepare(
        "insert into review_callbacks (tenant_id, id, request_id, url, event_type, body_json, status, next_attempt_at, created_at) values (?, 'cb1', ?, 'https://agent.example.test/cb', 'review.completed', ?, 'succeeded', '2026-01-01', '2026-01-01')",
      )
      .run(s.tenantId, id, JSON.stringify({ requestId: id, payload: { to: SECRET } }));
    expect(s.contentRows(id).n).toBeGreaterThan(2);
    const before = await s.audit(id);
    const originalSha = before.entries[0].data.payloadSha256;
    const out = await s.call("POST", `/v1/agent-reviews/${id}/redact`, { user: A });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ payload: { redacted: true }, originalPayload: { redacted: true }, context: null, legalHold: false, status: "approved" });
    expect(out.json.redactedAt).toEqual(expect.any(String));
    expect(s.contentRows(id).n).toBe(0);
    const after = await s.audit(id);
    expect(after.integrity).toMatchObject({ ok: true, length: before.integrity.length + 1 });
    expect(await R.verifyChain(id, after.entries)).toMatchObject({ ok: true });
    expect(after.entries.at(-1)).toMatchObject({ kind: "redacted", actor: A, data: { reason: "erasure" } });
    expect(after.entries[0].data.payloadSha256).toBe(originalSha);
    expect(s.raw.prepare("select count(*) n from audit_log where action = 'agent_review.redacted' and subject = ?").get(id)).toEqual({ n: 1 });
    // second redaction refused; decision rows kept (who/when/what) with content removed
    expect((await s.call("POST", `/v1/agent-reviews/${id}/redact`, { user: A })).status).toBe(409);
    expect(s.raw.prepare("select reviewer, decision, reason from review_decisions where request_id = ?").all(id)).toEqual([
      { reviewer: R1, decision: "approve", reason: null },
    ]);
  });

  it("refuses non-final, held, non-owner, API-key and cross-tenant callers", async () => {
    const s = await setup();
    const pending = (await s.call("POST", "/v1/agent-reviews", { headers: bearer(s.key), body: { action: "a", payload: { x: 1 } } })).json.id;
    expect((await s.call("POST", `/v1/agent-reviews/${pending}/redact`, { user: A })).json.error.code).toBe("not_final");
    const id = await s.decided();
    expect((await s.call("POST", `/v1/agent-reviews/${id}/legal-hold`, { user: A, body: { reason: "x" } })).status).toBe(400);
    const held = await s.call("POST", `/v1/agent-reviews/${id}/legal-hold`, { user: A, body: { reason: "Synthetic litigation hold" } });
    expect([held.status, held.json.legalHold]).toEqual([200, true]);
    expect((await s.call("POST", `/v1/agent-reviews/${id}/legal-hold`, { user: A, body: { reason: "again" } })).status).toBe(409);
    const refused = await s.call("POST", `/v1/agent-reviews/${id}/redact`, { user: A });
    expect([refused.status, refused.json.error.code]).toEqual([409, "legal_hold"]);
    expect(s.contentRows(id).n).toBeGreaterThan(0);
    for (const who of [{ user: R1 }, { headers: bearer(s.key) }]) {
      expect((await s.call("POST", `/v1/agent-reviews/${id}/redact`, who)).status).toBe(403);
      expect((await s.call("DELETE", `/v1/agent-reviews/${id}/legal-hold`, who)).status).toBe(403);
      expect((await s.call("PUT", `/v1/review-projects/${s.project.id}/retention`, { ...who, body: { retentionDays: 1 } })).status).toBe(403);
    }
    expect((await s.call("POST", `/v1/agent-reviews/${id}/redact`, { user: B })).status).toBe(404);
    expect((await s.call("PUT", `/v1/review-projects/${s.project.id}/retention`, { user: B, body: { retentionDays: 1 } })).status).toBe(404);
    expect(s.raw.prepare("select count(*) n from audit_log where action = 'agent_review.retention_set'").get()).toEqual({ n: 0 });
    expect((await s.call("DELETE", `/v1/agent-reviews/${id}/legal-hold`, { user: A })).json.legalHold).toBe(false);
    expect((await s.call("DELETE", `/v1/agent-reviews/${id}/legal-hold`, { user: A })).status).toBe(409);
    expect((await s.call("POST", `/v1/agent-reviews/${id}/redact`, { user: A })).status).toBe(200);
    expect((await s.call("POST", `/v1/agent-reviews/${id}/legal-hold`, { user: A, body: { reason: "too late" } })).status).toBe(409);
    const actions = s.raw.prepare("select action from audit_log where subject = ? and action like 'agent_review.%' order by created_at").all(id);
    expect((actions as { action: string }[]).map((a) => a.action)).toEqual([
      "agent_review.legal_hold_placed",
      "agent_review.legal_hold_released",
      "agent_review.redacted",
    ]);
  });

  it("retention sweep redacts only expired, final, un-held requests in projects with a policy", async () => {
    const s = await setup();
    const [old, oldHeld, recent] = [await s.decided(), await s.decided(), await s.decided()];
    const pendingOld = (await s.call("POST", "/v1/agent-reviews", { headers: bearer(s.key), body: { action: "a", payload: { to: SECRET } } })).json.id;
    const ago = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
    for (const id of [old, oldHeld]) s.raw.prepare("update review_requests set decided_at = ? where id = ?").run(ago(31), id);
    s.raw.prepare("update review_requests set created_at = ? where id = ?").run(ago(40), pendingOld);
    await s.call("POST", `/v1/agent-reviews/${oldHeld}/legal-hold`, { user: A, body: { reason: "Synthetic hold" } });
    expect(await sweepRetention(s.env)).toEqual({ redacted: 0, skipped: 0 }); // no policy yet = keep forever
    expect((await s.call("PUT", `/v1/review-projects/${s.project.id}/retention`, { user: A, body: { retentionDays: 0 } })).status).toBe(400);
    expect((await s.call("PUT", `/v1/review-projects/${s.project.id}/retention`, { user: A, body: { retentionDays: 30 } })).json).toEqual({
      retentionDays: 30,
    });
    expect(await sweepRetention(s.env)).toEqual({ redacted: 1, skipped: 0 });
    expect([s.contentRows(old).n, s.contentRows(oldHeld).n > 0, s.contentRows(recent).n > 0, s.contentRows(pendingOld).n > 0]).toEqual([0, true, true, true]);
    expect((await s.audit(old)).entries.at(-1)).toMatchObject({ kind: "redacted", actor: "system:retention", data: { reason: "retention" } });
    expect((await s.audit(old)).integrity.ok).toBe(true);
    expect(await sweepRetention(s.env)).toEqual({ redacted: 0, skipped: 0 }); // idempotent
    await s.call("DELETE", `/v1/agent-reviews/${oldHeld}/legal-hold`, { user: A });
    expect(await sweepRetention(s.env)).toEqual({ redacted: 1, skipped: 0 });
    expect((await s.call("PUT", `/v1/review-projects/${s.project.id}/retention`, { user: A, body: { retentionDays: null } })).status).toBe(200);
  });

  it("a hold that lands between load and write aborts the redaction atomically (nothing partial)", async () => {
    const s = await setup();
    const id = await s.decided();
    const db = new TenantDb(s.env.DB, s.tenantId);
    const stale = await loadReview(db, id, null);
    const stmts = await redactStmts(db, stale, A, "erasure");
    await s.call("POST", `/v1/agent-reviews/${id}/legal-hold`, { user: A, body: { reason: "Synthetic race hold" } });
    const ledgerBefore = s.raw.prepare("select count(*) n from review_ledger where request_id = ?").get(id);
    await expect(db.batch(stmts)).rejects.toThrow(/NOT NULL/);
    expect(s.raw.prepare("select count(*) n from review_ledger where request_id = ?").get(id)).toEqual(ledgerBefore);
    expect(s.contentRows(id).n).toBeGreaterThan(0);
    expect((await s.audit(id)).integrity.ok).toBe(true);
    expect(REDACTED).toBe('{"redacted":true}');
  });
});
