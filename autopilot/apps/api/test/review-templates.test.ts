import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";
import { renderTitle } from "../src/services/review-templates.js";

const A = "owner-a@example.test",
  R1 = "reviewer-1@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Template Co (synthetic)" } });
  await call("POST", "/v1/users", { user: A, body: { email: R1, role: "reviewer" } });
  const pid = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Refunds" } })).json.id as string;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes: ["reviews:write"], projectId: pid } })).json.key as string;
  const create = (payload: unknown, action = "refund.issue") => call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action, payload } });
  return { ...h, call, pid, key, create };
}
const SCHEMA = {
  type: "object",
  required: ["orderId", "amount"],
  additionalProperties: false,
  properties: { orderId: { type: "string", pattern: "^SYN-[0-9]+$" }, amount: { type: "number", maximum: 500 } },
};

describe("R4 action templates", () => {
  it("owner sets a template; bad payloads get 422 with precise errors; good ones carry title + instructions", async () => {
    const s = await setup();
    const path = `/v1/review-projects/${s.pid}/templates/refund.issue`;
    expect((await s.call("PUT", path, { user: R1, body: { schema: SCHEMA } })).status).toBe(403);
    const put = await s.call("PUT", path, {
      user: A,
      body: { schema: SCHEMA, title: "Refund £{{amount}} on {{orderId}}", instructions: "Check the order exists." },
    });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ action: "refund.issue", title: "Refund £{{amount}} on {{orderId}}", updatedBy: A });
    const bad = await s.create({ orderId: "X", amount: 900, extra: 1 });
    expect([bad.status, bad.json.error.code]).toEqual([422, "payload_invalid"]);
    expect(bad.json.error.message).toContain("orderId: does not match the required pattern; amount: must be <= 500; extra: is not allowed");
    expect((await s.create({ anything: true }, "email.send")).status).toBe(201);
    const ok = await s.create({ orderId: "SYN-7", amount: 42 });
    expect(ok.status).toBe(201);
    const got = (await s.call("GET", `/v1/agent-reviews/${ok.json.id}`, { user: R1 })).json;
    expect(got.template).toEqual({ title: "Refund £42 on SYN-7", instructions: "Check the order exists." });
    const list = (await s.call("GET", `/v1/review-projects/${s.pid}/templates`, { user: R1 })).json.items;
    expect(list.map((t: { action: string }) => t.action)).toEqual(["refund.issue"]);
    // replace, then delete
    await s.call("PUT", path, { user: A, body: { schema: { type: "object" } } });
    expect((await s.create({ orderId: "X" })).status).toBe(201);
    expect((await s.call("DELETE", path, { user: A })).json).toEqual({ deleted: true });
    expect((await s.call("DELETE", path, { user: A })).status).toBe(404);
    const plain = (await s.call("GET", `/v1/agent-reviews/${ok.json.id}`, { user: R1 })).json;
    expect(plain.template).toBeNull();
  });
  it("rejects unsafe schemas, deep schemas, unknown projects, bad action names", async () => {
    const s = await setup();
    const put = (schema: unknown, action = "a.b", pid = s.pid) =>
      s.call("PUT", `/v1/review-projects/${pid}/templates/${action}`, { user: A, body: { schema } });
    expect((await put({ $ref: "#/x" })).status).toBe(400);
    expect((await put({ type: "string", pattern: "(a+)+$" })).status).toBe(400);
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 9; i++) deep = { type: "object", properties: { n: deep } };
    expect((await put(deep)).json.error.message).toContain("deeper than 8");
    expect((await put({}, "a.b", "nope")).status).toBe(404);
    expect((await s.call("GET", "/v1/review-projects/nope/templates", { user: A })).status).toBe(404);
    expect((await put({}, "bad action!")).status).toBe(400);
  });
  it("renderTitle fills scalars only and clips", () => {
    expect(renderTitle(null, {})).toBeNull();
    expect(renderTitle("{{a}} {{ b }} {{c}} {{d}} {{missing}}", { a: 1, b: true, c: { x: 1 }, d: null })).toBe("1 true … null …");
    expect(renderTitle("{{s}}", { s: "x".repeat(100) })).toBe("x".repeat(80));
  });
});
