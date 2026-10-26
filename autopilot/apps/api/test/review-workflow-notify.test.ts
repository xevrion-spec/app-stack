import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { makeEnv, client } from "./harness.js";
import { __setWebhookFetcher } from "../src/services/webhooks.js";
import { sweepNotifications } from "../src/services/notify.js";
import { redirect } from "../src/services/notify-enqueue.js";

const A = "owner-wn@example.test",
  L1 = "lead-1@example.test",
  F1 = "fin-1@example.test",
  F2 = "fin-2@example.test",
  OUT = "outsider@example.test";
const MAIL = "https://mail.example.test/v1/send",
  SLACK = "https://hooks.slack.example.test/services/T/B/X";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
afterEach(() => __setWebhookFetcher(null));

const DOC = {
  rules: [
    {
      id: "chain",
      when: {},
      then: {
        outcome: "human",
        steps: [
          { name: "lead", group: "leads", approvals: 1 },
          { name: "finance", group: "finance", approvals: 1 },
        ],
      },
    },
  ],
};

async function setup() {
  const h = makeEnv({ NOTIFY_ACTION_KEY: "k".repeat(32) });
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Workflow Notify Co (synthetic)" } });
  h.raw.prepare("update tenants set plan = 'pro'").run();
  for (const u of [L1, F1, F2, OUT]) await call("POST", "/v1/users", { user: A, body: { email: u, role: "reviewer" } });
  const projectId = (await call("POST", "/v1/review-projects", { user: A, body: { name: "chain" } })).json.id as string;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes: ["reviews:write"], projectId } })).json.key as string;
  await call("PUT", "/v1/review-groups/leads", { user: A, body: { members: [L1] } });
  await call("PUT", "/v1/review-groups/finance", { user: A, body: { members: [F1, F2] } });
  const saved = await call("POST", `/v1/review-projects/${projectId}/policies`, { user: A, body: { document: DOC } });
  await call("POST", `/v1/review-projects/${projectId}/policies/${saved.json.version}/activate`, { user: A, body: {} });
  const create = async () => (await call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action: "refund.issue", payload: { amount: 5 } } })).json;
  const deliveries = (id: string) =>
    h.raw.prepare("select recipient, step from notify_deliveries where request_id = ? order by step, recipient").all(id) as {
      recipient: string | null;
      step: number;
    }[];
  return { ...h, call, create, deliveries };
}

describe("R3 gap fixes: chain-step and delegation-aware notifications", () => {
  it("toRoutedGroup validation: email only, not combined with fixed recipients", async () => {
    const s = await setup();
    const ch = (body: Record<string, unknown>) => s.call("POST", "/v1/notify/channels", { user: A, body });
    expect((await ch({ kind: "email", name: "x", url: MAIL, secret: "provider-token" })).status).toBe(400);
    expect((await ch({ kind: "slack", name: "x", url: SLACK, toRoutedGroup: true })).status).toBe(400);
    expect((await ch({ kind: "email", name: "x", url: MAIL, secret: "provider-token", recipients: [F1], toRoutedGroup: true })).status).toBe(400);
    const ok = await ch({ kind: "email", name: "x", url: MAIL, secret: "provider-token", toRoutedGroup: true });
    expect([ok.status, ok.json.toRoutedGroup, ok.json.recipients]).toEqual([201, true, []]);
    const fixed = await ch({ kind: "email", name: "y", url: MAIL, secret: "provider-token", recipients: [F1] });
    expect(fixed.json.toRoutedGroup).toBe(false);
  });

  it("each chain step notifies that step's group; advancing queues the next step once", async () => {
    const s = await setup();
    await s.call("POST", "/v1/notify/channels", { user: A, body: { kind: "email", name: "g", url: MAIL, secret: "provider-token", toRoutedGroup: true } });
    await s.call("POST", "/v1/notify/channels", { user: A, body: { kind: "slack", name: "#a", url: SLACK } });
    const r = await s.create();
    expect(s.deliveries(r.id)).toEqual([
      { recipient: null, step: 0 },
      { recipient: L1, step: 0 },
    ]);
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: L1, body: { decision: "approve" } });
    expect(s.deliveries(r.id)).toEqual([
      { recipient: null, step: 0 },
      { recipient: L1, step: 0 },
      { recipient: null, step: 1 },
      { recipient: F1, step: 1 },
      { recipient: F2, step: 1 },
    ]);
    const sent: string[] = [];
    __setWebhookFetcher(async (_u, init) => (sent.push(String(init.body)), new Response("ok")));
    await sweepNotifications(s.env, Date.now() + 1000);
    expect(sent.filter((b) => b.includes(F2))).toHaveLength(1);
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: F1, body: { decision: "approve" } });
    expect(s.deliveries(r.id)).toHaveLength(5); // final: nothing new queued
  });

  it("an active delegation redirects the delegator's messages to the delegate, who can then act", async () => {
    const s = await setup();
    await s.call("POST", "/v1/notify/channels", { user: A, body: { kind: "email", name: "g", url: MAIL, secret: "provider-token", toRoutedGroup: true } });
    const ends = new Date(Date.now() + 86_400_000).toISOString();
    expect((await s.call("POST", "/v1/review-delegations", { user: L1, body: { toEmail: OUT, endsAt: ends } })).status).toBe(201);
    const r = await s.create();
    expect(s.deliveries(r.id)).toEqual([{ recipient: OUT, step: 0 }]);
    const res = await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: OUT, body: { decision: "approve" } });
    expect(res.json.routing.chain.currentStep).toBe(1);
  });

  it("redirect: property - every delegator is replaced, output has no duplicates, others keep order", () => {
    const email = fc.constantFrom("a@x.test", "b@x.test", "c@x.test", "d@x.test");
    fc.assert(
      fc.property(fc.array(email, { maxLength: 6 }), fc.dictionary(email, email), (list, dict) => {
        const map = new Map(Object.entries(dict));
        const out = redirect(list, map);
        expect(new Set(out).size).toBe(out.length);
        for (const e of list) expect(out).toContain(map.get(e) ?? e);
        for (const e of out) expect(list.some((l) => (map.get(l) ?? l) === e)).toBe(true);
      }),
    );
  });
});
