/** Practice co-pilot M3: engagement, authorisation records, document requests, portal (mock magic link), audit export, working papers. Synthetic. */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";
import { exchangeMagic, issueMagicToken, lookupSession, MAGIC_TTL_MS, SESSION_TTL_MS } from "../src/services/portal-tokens.js";
import { maskReference } from "../src/routes/practice-onboard.js";

const P = "partner@firm-a.test",
  M = "manager@firm-a.test",
  PREP = "preparer@firm-a.test",
  REV = "reviewer@firm-a.test",
  RO = "readonly@firm-a.test",
  PB = "partner@firm-b.test",
  CLIENT = "owner@client-a.test";
const LETTER = "Engagement letter (synthetic). We will keep your books and prepare your VAT returns. Fees as agreed.";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type H = ReturnType<typeof makeEnv>;
let h: H, call: ReturnType<typeof client>, tid: string, tidB: string;

beforeEach(async () => {
  h = makeEnv();
  call = client(h.env);
  await call("POST", "/v1/practices", { user: P, body: { name: "Firm A" } });
  for (const [email, role] of [
    [M, "manager"],
    [PREP, "preparer"],
    [REV, "reviewer"],
    [RO, "readonly"],
  ] as const)
    await call("POST", "/v1/practice/staff", { user: P, body: { email, role } });
  await call("POST", "/v1/practices", { user: PB, body: { name: "Firm B" } });
  tid = (await call("POST", "/v1/practice/clients", { user: M, body: { name: "Client A (synthetic)" } })).json.tenantId;
  tidB = (await call("POST", "/v1/practice/clients", { user: PB, body: { name: "Client B (synthetic)" } })).json.tenantId;
});
async function portalSession(email = CLIENT, tenant = tid, user = M) {
  const inv = await call("POST", `/v1/practice/clients/${tenant}/portal-users`, { user, body: { email } });
  expect(inv.status, JSON.stringify(inv.json)).toBe(201);
  const s = await call("POST", "/v1/portal/session", { body: { token: inv.json.magicToken } });
  expect(s.status).toBe(200);
  return { token: s.json.sessionToken as string, magic: inv.json.magicToken as string, portalUserId: inv.json.portalUser.id as string };
}
const evCount = (type: string) => (h.raw.prepare("select count(*) n from events where type = ?").get(type) as { n: number }).n;
const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe("engagement letters", () => {
  it("draft → send → client accepts by hash; frozen after send; events + audit", async () => {
    expect(
      (
        await call("POST", `/v1/practice/clients/${tid}/engagements`, {
          user: PREP,
          body: { services: ["bookkeeping"], feeSummary: "£100/m", letterText: LETTER },
        })
      ).status,
    ).toBe(403);
    const e = await call("POST", `/v1/practice/clients/${tid}/engagements`, {
      user: M,
      body: { services: ["bookkeeping", "vat_returns", "bookkeeping"], feeSummary: "£150 per month fixed", letterText: LETTER },
    });
    expect(e.status).toBe(201);
    expect(e.json).toMatchObject({ status: "draft", services: ["bookkeeping", "vat_returns"], letterSha256: sha(LETTER) });
    const { token } = await portalSession();
    expect((await call("GET", "/v1/portal/engagements", { headers: as(token) })).json.items).toEqual([]);
    expect((await call("POST", `/v1/portal/engagements/${e.json.id}/accept`, { headers: as(token), body: { letterSha256: sha(LETTER) } })).status).toBe(404);
    expect((await call("POST", `/v1/practice/engagements/${e.json.id}/send`, { user: M })).json.status).toBe("sent");
    expect((await call("POST", `/v1/practice/engagements/${e.json.id}/send`, { user: M })).status).toBe(409);
    expect(() => h.raw.prepare("update engagements set letter_text = 'changed' where id = ?").run(e.json.id)).toThrow(/frozen/);
    const list = (await call("GET", "/v1/portal/engagements", { headers: as(token) })).json.items;
    expect(list[0]).toMatchObject({ letterText: LETTER, status: "sent" });
    expect((await call("POST", `/v1/portal/engagements/${e.json.id}/accept`, { headers: as(token), body: { letterSha256: "0".repeat(64) } })).status).toBe(409);
    const ok = await call("POST", `/v1/portal/engagements/${e.json.id}/accept`, { headers: as(token), body: { letterSha256: sha(LETTER) } });
    expect(ok.json.status).toBe("accepted");
    expect((await call("POST", `/v1/portal/engagements/${e.json.id}/accept`, { headers: as(token), body: { letterSha256: sha(LETTER) } })).status).toBe(409);
    expect((await call("POST", `/v1/practice/engagements/${e.json.id}/withdraw`, { user: M })).status).toBe(409);
    const staff = (await call("GET", `/v1/practice/clients/${tid}/engagements`, { user: RO })).json.items[0];
    expect(staff).toMatchObject({ status: "accepted", acceptedBy: CLIENT });
    expect(evCount("engagement.accepted")).toBeGreaterThan(0);
  });
  it("withdraw a draft; other firms cannot see or send", async () => {
    const e = (await call("POST", `/v1/practice/clients/${tid}/engagements`, { user: M, body: { services: ["payroll"], feeSummary: "x", letterText: LETTER } }))
      .json;
    expect((await call("POST", `/v1/practice/engagements/${e.id}/send`, { user: PB })).status).toBe(404);
    expect((await call("GET", `/v1/practice/clients/${tid}/engagements`, { user: PB })).status).toBe(404);
    expect((await call("POST", `/v1/practice/engagements/${e.id}/withdraw`, { user: M })).json.status).toBe("withdrawn");
    expect((await call("POST", `/v1/practice/engagements/${e.id}/send`, { user: M })).status).toBe(409);
    expect((await call("POST", `/v1/practice/engagements/nope/send`, { user: M })).status).toBe(404);
  });
});

describe("authorisation records (data only)", () => {
  it("records with masked reference, one active per kind, confirm, revoke", async () => {
    const a = await call("POST", `/v1/practice/clients/${tid}/authorisations`, {
      user: M,
      body: { kind: "agent_64_8", reference: "12345 67890", evidenceNote: "Signed 64-8 on file (synthetic)" },
    });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ status: "requested", referenceMasked: "*******890", confirmedAt: null });
    expect(JSON.stringify(h.raw.prepare("select * from authorisations").all())).not.toContain("67890");
    expect((await call("POST", `/v1/practice/clients/${tid}/authorisations`, { user: M, body: { kind: "agent_64_8" } })).status).toBe(409);
    expect((await call("POST", `/v1/practice/authorisations/${a.json.id}/confirm`, { user: PREP })).status).toBe(403);
    expect((await call("POST", `/v1/practice/authorisations/${a.json.id}/confirm`, { user: M })).json.status).toBe("confirmed");
    expect((await call("POST", `/v1/practice/authorisations/${a.json.id}/confirm`, { user: M })).status).toBe(409);
    expect((await call("POST", `/v1/practice/authorisations/${a.json.id}/revoke`, { user: PB })).status).toBe(404);
    expect((await call("POST", `/v1/practice/authorisations/${a.json.id}/revoke`, { user: P })).json.status).toBe("revoked");
    expect((await call("POST", `/v1/practice/authorisations/${a.json.id}/revoke`, { user: P })).status).toBe(409);
    expect(
      (await call("POST", `/v1/practice/clients/${tid}/authorisations`, { user: M, body: { kind: "agent_64_8", status: "confirmed" } })).json.confirmedAt,
    ).not.toBeNull();
    expect((await call("GET", `/v1/practice/clients/${tid}/authorisations`, { user: RO })).json.items).toHaveLength(2);
    expect((await call("POST", "/v1/practice/authorisations/nope/revoke", { user: P })).status).toBe(404);
  });
  it("maskReference", () => {
    expect(maskReference("ab")).toBe("***");
    expect(maskReference("GB 123 4567 89")).toBe("********789");
    expect(maskReference("1234")).toBe("*234");
    expect(maskReference("12345678901234567")).toBe("********567");
  });
});

describe("document requests + portal upload", () => {
  it("template + titles, de-duplicated; client uploads; checklist counts; waive", async () => {
    const r = await call("POST", `/v1/practice/clients/${tid}/document-requests`, {
      user: PREP,
      body: { template: "vat_quarter", titles: ["Bank statements for the quarter", "Fuel receipts"], dueDate: "2026-11-01" },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(404); // preparer not assigned
    const ok = await call("POST", `/v1/practice/clients/${tid}/document-requests`, {
      user: M,
      body: { template: "vat_quarter", titles: ["Bank statements for the quarter", "Fuel receipts"], dueDate: "2026-11-01" },
    });
    expect(ok.json).toEqual({ created: 4, skippedDuplicates: 0 });
    expect((await call("POST", `/v1/practice/clients/${tid}/document-requests`, { user: M, body: { titles: ["Fuel receipts"] } })).json).toEqual({
      created: 0,
      skippedDuplicates: 1,
    });
    expect((await call("POST", `/v1/practice/clients/${tid}/document-requests`, { user: M, body: {} })).status).toBe(400);
    const list = await call("GET", `/v1/practice/document-requests?asOf=2026-11-05`, { user: M });
    expect(list.json).toMatchObject({ open: 4, overdue: 4 });
    const { token } = await portalSession();
    const mine = (await call("GET", "/v1/portal/document-requests", { headers: as(token) })).json.items;
    expect(mine).toHaveLength(4);
    const target = mine[0].id;
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(
      (await call("POST", `/v1/portal/document-requests/${target}/upload`, { headers: { ...as(token), "content-type": "application/x-msdownload" }, raw: pdf }))
        .status,
    ).toBe(415);
    expect(
      (
        await call("POST", `/v1/portal/document-requests/${target}/upload`, {
          headers: { ...as(token), "content-type": "application/pdf" },
          raw: new Uint8Array(),
        })
      ).status,
    ).toBe(400);
    const up = await call("POST", `/v1/portal/document-requests/${target}/upload`, { headers: { ...as(token), "content-type": "application/pdf" }, raw: pdf });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect(up.json.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect([...h.objects.keys()].some((k) => k.startsWith(`portal/${tid}/${target}/`))).toBe(true);
    expect(
      (await call("POST", `/v1/portal/document-requests/${target}/upload`, { headers: { ...as(token), "content-type": "application/pdf" }, raw: pdf })).status,
    ).toBe(409);
    expect(evCount("document_request.fulfilled")).toBeGreaterThan(0);
    const after = await call("GET", `/v1/practice/document-requests?clientId=${tid}&status=fulfilled`, { user: RO });
    expect(after.json.items[0]).toMatchObject({ status: "fulfilled", fulfilledBy: CLIENT, contentType: "application/pdf", sizeBytes: 6 });
    const other = mine[1].id;
    expect((await call("POST", `/v1/practice/document-requests/${other}/waive`, { user: PB })).status).toBe(404);
    expect((await call("POST", `/v1/practice/document-requests/${other}/waive`, { user: M })).json.status).toBe("waived");
    expect((await call("POST", `/v1/practice/document-requests/${other}/waive`, { user: M })).status).toBe(409);
    expect((await call("POST", `/v1/practice/document-requests/nope/waive`, { user: M })).status).toBe(404);
    expect((await call("GET", "/v1/portal/document-requests", { headers: as(token) })).json.items).toHaveLength(3);
    expect(
      (await call("POST", `/v1/portal/document-requests/nope/upload`, { headers: { ...as(token), "content-type": "application/pdf" }, raw: pdf })).status,
    ).toBe(404);
  });
  it("oversized declared length is refused before reading", async () => {
    await call("POST", `/v1/practice/clients/${tid}/document-requests`, { user: M, body: { titles: ["Big"] } });
    const { token } = await portalSession();
    const id = (await call("GET", "/v1/portal/document-requests", { headers: as(token) })).json.items[0].id;
    const r = await call("POST", `/v1/portal/document-requests/${id}/upload`, {
      headers: { ...as(token), "content-type": "application/pdf", "content-length": String(11 * 1024 * 1024) },
      raw: new Uint8Array(4),
    });
    expect([413]).toContain(r.status);
  });
});

describe("client portal auth + isolation", () => {
  it("magic token is single use; session works; logout and revoke kill it; staff/dev identities rejected", async () => {
    const { token, magic, portalUserId } = await portalSession();
    expect((await call("POST", "/v1/portal/session", { body: { token: magic } })).status).toBe(401);
    expect((await call("POST", "/v1/portal/session", { body: { token: "pm_short-but-ok-length" } })).status).toBe(401);
    expect((await call("GET", "/v1/portal/me")).status).toBe(401);
    expect((await call("GET", "/v1/portal/me", { user: M })).status).toBe(401);
    expect((await call("GET", "/v1/portal/me", { headers: { authorization: `Bearer ${magic}` } })).status).toBe(401);
    const me = await call("GET", "/v1/portal/me", { headers: as(token) });
    expect(me.json).toMatchObject({ email: CLIENT, tenantId: tid, business: "Client A (synthetic)", practice: "Firm A", openQueries: 0 });
    // A portal session is not a staff or tenant identity.
    expect((await call("GET", "/v1/practice", { headers: as(token) })).status).toBe(401);
    expect((await call("GET", "/v1/transactions", { headers: as(token) })).status).toBe(401);
    expect((await call("POST", "/v1/portal/logout", { headers: as(token) })).json.ok).toBe(true);
    expect((await call("GET", "/v1/portal/me", { headers: as(token) })).status).toBe(401);
    const again = await portalSession();
    expect(again.portalUserId).toBe(portalUserId);
    expect((await call("POST", `/v1/practice/portal-users/${portalUserId}/revoke`, { user: PREP })).status).toBe(403);
    expect((await call("POST", `/v1/practice/portal-users/${portalUserId}/revoke`, { user: PB })).status).toBe(404);
    expect((await call("POST", `/v1/practice/portal-users/${portalUserId}/revoke`, { user: M })).json.revoked).toBe(true);
    expect((await call("GET", "/v1/portal/me", { headers: as(again.token) })).status).toBe(401);
    expect((await call("GET", `/v1/practice/clients/${tid}/portal-users`, { user: RO })).json.items[0].status).toBe("revoked");
    // Re-inviting reactivates.
    const third = await portalSession();
    expect((await call("GET", "/v1/portal/me", { headers: as(third.token) })).status).toBe(200);
    expect((await call("POST", "/v1/practice/portal-users/nope/revoke", { user: M })).status).toBe(404);
  });
  it("tokens expire and archived clients lose portal access", async () => {
    const uid = (await call("POST", `/v1/practice/clients/${tid}/portal-users`, { user: M, body: { email: CLIENT } })).json.portalUser.id;
    const t0 = Date.now();
    const m = await issueMagicToken(h.env.DB, uid, t0);
    await m.stmt.run();
    expect(await exchangeMagic(h.env.DB, m.token, t0 + MAGIC_TTL_MS + 1)).toBeNull();
    const m2 = await issueMagicToken(h.env.DB, uid, t0);
    await m2.stmt.run();
    const s = (await exchangeMagic(h.env.DB, m2.token, t0))!;
    expect(await lookupSession(h.env.DB, s.sessionToken, t0 + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(await lookupSession(h.env.DB, s.sessionToken, t0 + SESSION_TTL_MS + 1)).toBeNull();
    expect(await lookupSession(h.env.DB, "ps_bad", t0)).toBeNull();
    expect(await exchangeMagic(h.env.DB, s.sessionToken, t0)).toBeNull();
    await call("PATCH", `/v1/practice/clients/${tid}`, { user: M, body: { status: "archived" } });
    expect(await lookupSession(h.env.DB, s.sessionToken, t0)).toBeNull();
  });
  it("a client sees only their own business's queries and documents, and answers queries", async () => {
    await call("POST", `/v1/practice/clients/${tid}/queries`, { user: M, body: { question: "What was the £120 payment?" } });
    await call("POST", `/v1/practice/clients/${tidB}/queries`, { user: PB, body: { question: "Firm B secret question" } });
    await call("POST", `/v1/practice/clients/${tidB}/document-requests`, { user: PB, body: { titles: ["B only"] } });
    const a = await portalSession();
    const b = await portalSession("owner@client-b.test", tidB, PB);
    const qa = (await call("GET", "/v1/portal/queries", { headers: as(a.token) })).json.items;
    expect(qa).toHaveLength(1);
    expect(JSON.stringify(qa)).not.toContain("Firm B");
    const qb = (await call("GET", "/v1/portal/queries", { headers: as(b.token) })).json.items;
    expect((await call("POST", `/v1/portal/queries/${qb[0].id}/answer`, { headers: as(a.token), body: { answer: "x" } })).status).toBe(404);
    expect((await call("GET", "/v1/portal/document-requests", { headers: as(a.token) })).json.items).toEqual([]);
    const ans = await call("POST", `/v1/portal/queries/${qa[0].id}/answer`, { headers: as(a.token), body: { answer: "Van insurance (synthetic)" } });
    expect(ans.json.status).toBe("answered");
    expect((await call("POST", `/v1/portal/queries/${qa[0].id}/answer`, { headers: as(a.token), body: { answer: "again" } })).status).toBe(409);
    const staff = (await call("GET", "/v1/practice/queries", { user: M })).json.items.find((q: { id: string }) => q.id === qa[0].id);
    expect(staff).toMatchObject({ status: "answered" });
    expect(evCount("query.answered")).toBeGreaterThan(0);
    expect((await call("GET", "/v1/portal/me", { headers: as(a.token) })).json.openQueries).toBe(0);
  });
});

describe("working papers + immutable four-eyes sign-off", () => {
  async function withData() {
    const r = await call("POST", `/v1/practice/clients/${tid}/imports/bank-csv`, { user: M, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    await runPipeline(h.env, tid, r.json.jobId);
    await call("PUT", `/v1/practice/clients/${tid}/assignments`, {
      user: M,
      body: {
        assignments: [
          { email: PREP, role: "preparer" },
          { email: REV, role: "reviewer" },
        ],
      },
    });
  }
  it("prepares deterministic snapshots of each kind; preparer cannot sign own; reviewer signs; immutable", async () => {
    await withData();
    for (const kind of ["trial_balance", "bank_reconciliation", "vat_reconciliation"]) {
      const w = await call("POST", `/v1/practice/clients/${tid}/working-papers`, { user: PREP, body: { kind, periodEnd: "2026-12-31" } });
      expect(w.status, JSON.stringify(w.json)).toBe(201);
      expect(w.json).toMatchObject({ kind, status: "prepared", integrityOk: true, changedSinceSnapshot: false, preparedBy: PREP });
      expect(w.json.snapshotSha256).toBe(sha(JSON.stringify(w.json.snapshot)));
    }
    const list = (await call("GET", `/v1/practice/clients/${tid}/working-papers`, { user: REV })).json.items;
    expect(list).toHaveLength(3);
    const tb = list.find((x: { kind: string }) => x.kind === "bank_reconciliation");
    expect(tb.snapshot.transactions).toBeGreaterThan(0);
    expect((await call("POST", `/v1/practice/working-papers/${tb.id}/sign-off`, { user: PREP, body: {} })).status).toBe(403);
    const self = await call("POST", `/v1/practice/clients/${tid}/working-papers`, { user: REV, body: { kind: "trial_balance", periodEnd: "2026-12-31" } });
    expect((await call("POST", `/v1/practice/working-papers/${self.json.id}/sign-off`, { user: REV, body: {} })).status).toBe(409);
    expect((await call("POST", `/v1/practice/working-papers/${tb.id}/sign-off`, { user: PB, body: {} })).status).toBe(404);
    const s = await call("POST", `/v1/practice/working-papers/${tb.id}/sign-off`, { user: REV, body: { note: "Agreed to statement (synthetic)" } });
    expect(s.json).toMatchObject({ status: "signed_off", signedBy: REV });
    expect((await call("POST", `/v1/practice/working-papers/${tb.id}/sign-off`, { user: M, body: {} })).status).toBe(409);
    expect(() => h.raw.prepare("update working_papers set sign_note = 'edit' where id = ?").run(tb.id)).toThrow(/immutable/);
    expect(() => h.raw.prepare("delete from working_papers where id = ?").run(tb.id)).toThrow(/immutable/);
    expect(() => h.raw.prepare("update working_papers set snapshot_json = '{}' where id = ?").run(self.json.id)).toThrow(/immutable/);
    expect(evCount("working_paper.signed_off")).toBeGreaterThan(0);
    expect((await call("GET", `/v1/practice/working-papers/${tb.id}`, { user: RO })).json.status).toBe("signed_off");
    expect((await call("GET", `/v1/practice/working-papers/nope`, { user: RO })).status).toBe(404);
  });
  it("sign-off is refused when the ledger changed since the snapshot; integrity break detected", async () => {
    await withData();
    const w = (await call("POST", `/v1/practice/clients/${tid}/working-papers`, { user: PREP, body: { kind: "bank_reconciliation", periodEnd: "2026-12-31" } }))
      .json;
    h.raw
      .prepare("update transactions set amount_pence = amount_pence + 1 where tenant_id = ? and id = (select id from transactions where tenant_id = ? limit 1)")
      .run(tid, tid);
    const g = (await call("GET", `/v1/practice/working-papers/${w.id}`, { user: M })).json;
    expect(g.changedSinceSnapshot).toBe(true);
    expect((await call("POST", `/v1/practice/working-papers/${w.id}/sign-off`, { user: REV, body: {} })).status).toBe(409);
    h.raw.exec("drop trigger working_papers_snapshot_fixed");
    h.raw.prepare("update working_papers set snapshot_json = replace(snapshot_json, '\"transactions\"', '\"transactionz\"') where id = ?").run(w.id);
    expect((await call("GET", `/v1/practice/working-papers/${w.id}`, { user: M })).json.integrityOk).toBe(false);
    expect((await call("POST", `/v1/practice/working-papers/${w.id}/sign-off`, { user: REV, body: {} })).status).toBe(409);
  });
});

describe("audit export + chain verification", () => {
  it("exports only this client's practice entries plus its own log, json and csv, with chain status; partners verify", async () => {
    await call("POST", `/v1/practice/clients/${tid}/document-requests`, { user: M, body: { titles: ["=HYPERLINK(evil)"] } });
    await call("POST", `/v1/practice/clients/${tidB}/document-requests`, { user: PB, body: { titles: ["B"] } });
    expect((await call("GET", `/v1/practice/clients/${tid}/audit-export`, { user: PREP })).status).toBe(403);
    expect((await call("GET", `/v1/practice/clients/${tid}/audit-export`, { user: PB })).status).toBe(404);
    const j = await call("GET", `/v1/practice/clients/${tid}/audit-export`, { user: M });
    expect(j.json.chain.ok).toBe(true);
    expect(j.json.practiceEntries.map((e: { action: string }) => e.action)).toContain("document_request.created");
    const csv = await call("GET", `/v1/practice/clients/${tid}/audit-export?format=csv`, { user: P });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("x-audit-chain-ok")).toBe("true");
    expect(csv.text.split("\n")[0]).toBe("source,seq,created_at,actor,action,subject,hash");
    const v = await call("GET", "/v1/practice/audit/verify", { user: P });
    expect(v.json).toMatchObject({ ok: true, brokenAt: null });
    expect(v.json.entries).toBeGreaterThan(j.json.practiceEntries.length - 1);
    expect((await call("GET", "/v1/practice/audit/verify", { user: M })).status).toBe(403);
    h.raw.exec("drop trigger practice_audit_no_update");
    h.raw.prepare("update practice_audit set actor = 'mallory' where seq = 2").run();
    expect((await call("GET", "/v1/practice/audit/verify", { user: P })).json).toMatchObject({ ok: false, brokenAt: 2 });
    expect((await call("GET", `/v1/practice/clients/${tid}/audit-export?format=csv`, { user: P })).headers.get("x-audit-chain-ok")).toBe("false");
  });
  it("CSV cells that look like formulas are neutralised", async () => {
    const r = await call("POST", `/v1/practice/clients/${tid}/authorisations`, { user: M, body: { kind: "paye" } });
    h.raw.exec("drop trigger practice_audit_no_update");
    h.raw.prepare("update practice_audit set subject = '=1+1,\"x\"' where subject = ?").run(r.json.id);
    const csv = (await call("GET", `/v1/practice/clients/${tid}/audit-export?format=csv`, { user: P })).text;
    expect(csv).toContain(`"'=1+1,""x"""`);
  });
});
