/**
 * Practice authz matrix: EVERY /v1/practice* OpenAPI operation x {anonymous, non-staff, partner, manager, preparer,
 * reviewer, readonly, other-firm partner}. Ids point at firm A's resources; the client is assigned to nobody, so
 * preparer/reviewer are out of scope. Outcomes are snapshotted so any permission change is visible in review.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";

const spec = JSON.parse(readFileSync(join(__dirname, "../../../openapi/openapi.json"), "utf8")) as { paths: Record<string, Record<string, unknown>> };
const OPS = Object.entries(spec.paths)
  .filter(([p]) => p.startsWith("/v1/practice"))
  .flatMap(([p, ms]) => Object.keys(ms).map((m) => [m.toUpperCase(), p] as const));
const ROLES = { partner: "p@a.test", manager: "m@a.test", preparer: "prep@a.test", reviewer: "rev@a.test", readonly: "ro@a.test" } as const;
const OTHER = "p@b.test",
  NOBODY = "nobody@x.test";
const LEAKS = /\bat \S+ \(|SQLITE|sqlite3|select .* from|insert into|node_modules|\/src\/|D1_ERROR/i;

let call: ReturnType<typeof client>;
const ids: Record<string, string> = {};
beforeAll(async () => {
  const h = makeEnv();
  call = client(h.env);
  await call("POST", "/v1/practices", { user: ROLES.partner, body: { name: "Firm A" } });
  for (const [role, email] of Object.entries(ROLES))
    if (role !== "partner") await call("POST", "/v1/practice/staff", { user: ROLES.partner, body: { email, role } });
  await call("POST", "/v1/practices", { user: OTHER, body: { name: "Firm B" } });
  ids.client = (await call("POST", "/v1/practice/clients", { user: ROLES.manager, body: { name: "Secret Client A" } })).json.tenantId;
  const imp = await call("POST", `/v1/practice/clients/${ids.client}/imports/bank-csv`, {
    user: ROLES.manager,
    raw: BANK_CSV,
    headers: { "content-type": "text/csv" },
  });
  await runPipeline(h.env, ids.client!, imp.json.jobId);
  ids.txn = (await call("GET", "/v1/practice/review-queue?limit=1", { user: ROLES.manager })).json.items[0]?.transactionId ?? "none";
  const tpl = (await call("GET", "/v1/practice/close-templates", { user: ROLES.manager })).json.items[0].id;
  ids.checklist = (
    await call("POST", `/v1/practice/clients/${ids.client}/checklists`, { user: ROLES.manager, body: { templateId: tpl, periodEnd: "2026-09-30" } })
  ).json.id;
  ids.query = (await call("POST", `/v1/practice/clients/${ids.client}/queries`, { user: ROLES.manager, body: { question: "What is this payment?" } })).json.id;
  await call("PATCH", `/v1/practice/clients/${ids.client}`, { user: ROLES.manager, body: { status: "active" } });
  const tt = await call("POST", "/v1/practice/task-templates", { user: ROLES.manager, body: { name: "Bank rec", recurrence: "monthly", dueDay: 5 } });
  await call("POST", "/v1/practice/tasks/generate", { user: ROLES.manager, body: { month: "2026-10" } });
  void tt;
  ids.task = (await call("GET", "/v1/practice/tasks", { user: ROLES.manager })).json.items?.[0]?.id ?? "none";
  const LETTER = "Engagement letter for the authz matrix (synthetic).";
  ids.engagement = (
    await call("POST", `/v1/practice/clients/${ids.client}/engagements`, {
      user: ROLES.manager,
      body: { services: ["bookkeeping"], feeSummary: "x", letterText: LETTER },
    })
  ).json.id;
  ids.authorisation = (await call("POST", `/v1/practice/clients/${ids.client}/authorisations`, { user: ROLES.manager, body: { kind: "mtd_vat" } })).json.id;
  await call("POST", `/v1/practice/clients/${ids.client}/document-requests`, { user: ROLES.manager, body: { titles: ["Matrix doc"] } });
  ids.docreq = (await call("GET", "/v1/practice/document-requests", { user: ROLES.manager })).json.items[0].id;
  const inv = (await call("POST", `/v1/practice/clients/${ids.client}/portal-users`, { user: ROLES.manager, body: { email: "client@a.test" } })).json;
  ids.portalUser = inv.portalUser.id;
  ids.paper = (
    await call("POST", `/v1/practice/clients/${ids.client}/working-papers`, { user: ROLES.manager, body: { kind: "trial_balance", periodEnd: "2026-12-31" } })
  ).json.id;
});
it("fixture ids exist", () => {
  for (const k of ["client", "txn", "checklist", "query", "task", "engagement", "authorisation", "docreq", "portalUser", "paper"])
    expect(ids[k], k).toMatch(/^[\w-]{6,}$/);
  expect(ids.txn).not.toBe("none");
  expect(ids.task).not.toBe("none");
});
function concrete(m: string, p: string) {
  const seg = p.split("/")[3] ?? "";
  const byPath: Record<string, string> = {
    clients: ids.client!,
    checklists: ids.checklist!,
    queries: ids.query!,
    tasks: ids.task!,
    staff: encodeURIComponent(ROLES.readonly),
  };
  return p
    .replace("{clientId}", ids.client!)
    .replace("{transactionId}", ids.txn!)
    .replace("{idx}", "0")
    .replace("{action}", "confirm")
    .replace("{email}", byPath.staff!)
    .replace("{id}", byPath[seg] ?? "nonexistent");
}
const send = (m: string, p: string, user?: string) =>
  call(m, concrete(m, p), { ...(user ? { user } : {}), ...(m === "GET" || m === "DELETE" ? {} : { body: {} }) });

describe("practice authz matrix over every /v1/practice operation", () => {
  it("covers every practice operation", () => expect(OPS.length).toBeGreaterThanOrEqual(60));
  it.each(OPS)("%s %s", async (m, p) => {
    const anon = await send(m, p);
    expect(anon.status).toBe(401);
    if (p !== "/v1/practices") {
      expect((await send(m, p, NOBODY)).status).toBe(403);
    }
    const outcome: Record<string, number> = {};
    const mutating = m !== "GET";
    for (const [role, email] of Object.entries(ROLES)) {
      // DELETE staff is destructive to the fixture; probe it for readonly/preparer/reviewer only (they must fail).
      if (m === "DELETE" && (role === "partner" || role === "manager")) continue;
      const r = await send(m, p, email);
      outcome[role] = r.status;
      expect(r.status, `${role} ${JSON.stringify(r.json)}`).toBeLessThan(500);
      expect(JSON.stringify(r.json ?? "")).not.toMatch(LEAKS);
      if (role === "readonly" && mutating && p !== "/v1/practices") expect(r.status).toBe(403);
      if ((role === "preparer" || role === "reviewer") && /\{(id|clientId)\}/.test(p) && p.includes("/clients/")) expect(r.status).toBeGreaterThanOrEqual(400);
    }
    const other = await send(m, p, OTHER);
    outcome.otherFirm = other.status;
    expect(other.status).toBeLessThan(500);
    const body = JSON.stringify(other.json ?? "");
    for (const v of [ids.client!, ids.checklist!, ids.query!, ids.engagement!, ids.paper!, "Secret Client A", ROLES.manager]) expect(body).not.toContain(v);
    if (/\{(id|clientId)\}/.test(p) && p !== "/v1/practice/staff/{email}") expect(other.status).toBeGreaterThanOrEqual(400);
    expect(outcome).toMatchSnapshot();
  });
});

describe("cross-firm writes with VALID bodies never touch firm A", () => {
  const valid = (): [string, string, unknown][] => [
    ["PATCH", `/v1/practice/clients/${ids.client}`, { status: "archived" }],
    ["PUT", `/v1/practice/clients/${ids.client}/assignments`, { assignments: [] }],
    ["POST", `/v1/practice/clients/${ids.client}/auto-approve`, { threshold: 0.95, categories: [] }],
    ["POST", `/v1/practice/clients/${ids.client}/queries`, { question: "Cross-firm probe" }],
    ["POST", `/v1/practice/review/approve`, { items: [{ clientId: ids.client, transactionId: ids.txn }] }],
    ["POST", `/v1/practice/review/claim`, { items: [{ clientId: ids.client, transactionId: ids.txn }] }],
    ["POST", `/v1/practice/qa/${ids.client}/${ids.txn}`, { result: "pass" }],
    ["POST", `/v1/practice/time`, { clientId: ids.client, minutes: 30, date: "2026-10-01" }],
    ["POST", `/v1/practice/billing/records`, { clientId: ids.client, periodEnd: "2026-10-31" }],
    ["POST", `/v1/practice/checklists/${ids.checklist}/items/0`, { done: true }],
    ["POST", `/v1/practice/checklists/${ids.checklist}/complete`, {}],
    ["POST", `/v1/practice/queries/${ids.query}/close`, {}],
    ["POST", `/v1/practice/clients/${ids.client}/engagements`, { services: ["bookkeeping"], feeSummary: "x", letterText: "Cross-firm probe letter text" }],
    ["POST", `/v1/practice/engagements/${ids.engagement}/send`, {}],
    ["POST", `/v1/practice/authorisations/${ids.authorisation}/revoke`, {}],
    ["POST", `/v1/practice/clients/${ids.client}/document-requests`, { titles: ["Cross-firm probe"] }],
    ["POST", `/v1/practice/document-requests/${ids.docreq}/waive`, {}],
    ["POST", `/v1/practice/clients/${ids.client}/portal-users`, { email: "attacker@b.test" }],
    ["POST", `/v1/practice/portal-users/${ids.portalUser}/revoke`, {}],
    ["POST", `/v1/practice/clients/${ids.client}/working-papers`, { kind: "trial_balance", periodEnd: "2026-12-31" }],
    ["POST", `/v1/practice/working-papers/${ids.paper}/sign-off`, {}],
    ["POST", `/v1/practice/clients/${ids.client}/anomalies/dismiss`, { transactionId: ids.txn, code: "round_sum", note: "cross-firm probe" }],
    ["POST", `/v1/practice/assistant`, { question: "Which clients are at risk?" }],
    ["POST", `/v1/practice/bulk`, { action: "set_status", clientIds: [ids.client], status: "archived" }],
  ];
  it("each is refused or a no-op, and firm A's state is unchanged", async () => {
    const before = (await call("GET", `/v1/practice/clients/${ids.client}`, { user: ROLES.partner })).json;
    for (const [m, p, body] of valid()) {
      const r = await call(m, p, { user: OTHER, body });
      expect(r.status, `${m} ${p} ${JSON.stringify(r.json)}`).toBeLessThan(500);
      const ok = r.status < 300;
      if (ok && p === "/v1/practice/assistant") expect(JSON.stringify(r.json)).not.toContain("Secret Client A");
      else if (ok) expect(JSON.stringify(r.json), `${m} ${p}`).toMatch(/"(approved|claimed)":0|"skipped"|"preview"|"matched":0|"count":0/);
    }
    const after = (await call("GET", `/v1/practice/clients/${ids.client}`, { user: ROLES.partner })).json;
    expect(after.status ?? after.settings?.status).toBe(before.status ?? before.settings?.status);
    const q = (await call("GET", "/v1/practice/queries", { user: ROLES.partner })).json.items;
    expect(q.some((x: { question: string }) => x.question === "Cross-firm probe")).toBe(false);
    expect((await call("GET", "/v1/practice/time", { user: ROLES.partner })).json.totalMinutes).toBe(0);
    expect((await call("GET", "/v1/practice/billing/records", { user: ROLES.partner })).json.items).toEqual([]);
  });
});

describe("portal matrix: every /v1/portal operation", () => {
  const PORTAL = Object.entries(spec.paths)
    .filter(([p]) => p.startsWith("/v1/portal/"))
    .flatMap(([p, ms]) => Object.keys(ms).map((m) => [m.toUpperCase(), p] as const));
  it("covers the portal", () => expect(PORTAL.length).toBeGreaterThanOrEqual(9));
  it.each(PORTAL)("%s %s: anonymous, staff and dev identities are 401; another client's ids are 404", async (m, p) => {
    const path = p.replace("{id}", "x");
    const opts = m === "GET" ? {} : { body: {} };
    if (p === "/v1/portal/session") {
      expect((await call(m, path, { body: { token: "pm_" + "a".repeat(43) } })).status).toBe(401);
      return;
    }
    expect((await call(m, path, opts)).status).toBe(401);
    expect((await call(m, path, { ...opts, user: ROLES.partner })).status).toBe(401);
    expect((await call(m, path, { ...opts, headers: { authorization: "Bearer ap_test_abcdefgh_x" } })).status).toBe(401);
  });
  it("a firm-B client session never reaches firm A's objects", async () => {
    await call("POST", "/v1/practices", { user: OTHER, body: { name: "Firm B" } });
    const tb = (await call("POST", "/v1/practice/clients", { user: OTHER, body: { name: "B client" } })).json.tenantId;
    const inv = (await call("POST", `/v1/practice/clients/${tb}/portal-users`, { user: OTHER, body: { email: "c@b.test" } })).json;
    const s = (await call("POST", "/v1/portal/session", { body: { token: inv.magicToken } })).json.sessionToken;
    const auth = { authorization: `Bearer ${s}` };
    expect((await call("POST", `/v1/portal/queries/${ids.query}/answer`, { headers: auth, body: { answer: "x" } })).status).toBe(404);
    expect((await call("POST", `/v1/portal/engagements/${ids.engagement}/accept`, { headers: auth, body: { letterSha256: "a".repeat(64) } })).status).toBe(404);
    expect(
      (
        await call("POST", `/v1/portal/document-requests/${ids.docreq}/upload`, {
          headers: { ...auth, "content-type": "application/pdf" },
          raw: new Uint8Array([1]),
        })
      ).status,
    ).toBe(404);
    for (const p of ["/v1/portal/queries", "/v1/portal/document-requests", "/v1/portal/engagements", "/v1/portal/me"]) {
      const r = await call("GET", p, { headers: auth });
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.json)).not.toMatch(/Secret Client A|Matrix doc|What is this payment/);
    }
  });
});
