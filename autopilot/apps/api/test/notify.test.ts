import { describe, it, expect, afterEach } from "vitest";
import * as R from "@xevrion/agent-review";
import { makeEnv, client } from "./harness.js";
import { __setWebhookFetcher, __setWebhookClock } from "../src/services/webhooks.js";
import { sweepNotifications } from "../src/services/notify.js";
import { __setRateLimitClock } from "../src/lib/ratelimit.js";

const A = "owner-nt@example.test",
  R1 = "rev1-nt@example.test",
  R2 = "rev2-nt@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const SLACK = "https://hooks.slack.example.test/services/T/B/X",
  TEAMS = "https://teams.example.test/webhook/abc",
  MAIL = "https://mail.example.test/v1/send",
  HOOK = "https://bot.example.test/review";
afterEach(() => {
  __setWebhookFetcher(null);
  __setWebhookClock(null);
  __setRateLimitClock(null);
});

type Sent = { url: string; headers: Record<string, string>; body: string };
function fake(status: (url: string) => number = () => 200) {
  const sent: Sent[] = [];
  __setWebhookFetcher(async (url, init) => {
    sent.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body) });
    return new Response("ok", { status: status(url) });
  });
  return sent;
}

async function setup(over: Record<string, string> = {}) {
  const h = makeEnv({ NOTIFY_ACTION_KEY: "k".repeat(32), ...over });
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Notify Co (synthetic)" } });
  h.raw.prepare("update tenants set plan = 'pro'").run();
  for (const e of [R1, R2]) await call("POST", "/v1/users", { user: A, body: { email: e, role: "reviewer" } });
  const p = (await call("POST", "/v1/review-projects", { user: A, body: { name: "nt" } })).json;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["reviews:write"], projectId: p.id } })).json.key as string;
  const create = async (body: Record<string, unknown> = {}) =>
    (
      await call("POST", "/v1/agent-reviews", {
        headers: bearer(key),
        body: { action: "refund.issue", payload: { amount: 120, note: "<b>hi</b>" }, risk: "high", ...body },
      })
    ).json;
  const channel = (body: Record<string, unknown>) => call("POST", "/v1/notify/channels", { user: A, body });
  return { ...h, call, create, channel, key, projectId: p.id as string };
}
const tokenFrom = (url: string) => url.split("/act/")[1]!;

describe("R1 reviewer notifications", () => {
  it("channels: owner-only, validated, secrets never listed, webhook secret shown once", async () => {
    const s = await setup();
    const hook = await s.channel({ kind: "webhook", name: "bot", url: HOOK });
    expect(hook.status).toBe(201);
    expect(hook.json.secret).toMatch(/^[0-9a-f]{48}$/);
    const slack = await s.channel({ kind: "slack", name: "#approvals", url: SLACK, signingSecret: "slack-signing-1" });
    expect(slack.json).toMatchObject({ kind: "slack", urlHost: "hooks.slack.example.test", interactive: true });
    expect(slack.json.secret).toBeUndefined();
    const list = await s.call("GET", "/v1/notify/channels", { user: A });
    expect(list.json.items).toHaveLength(2);
    expect(JSON.stringify(list.json)).not.toContain(hook.json.secret);
    expect(JSON.stringify(list.json)).not.toContain("slack-signing-1");
    expect(JSON.stringify(list.json)).not.toContain("/services/T/B/X");
    expect((await s.channel({ kind: "webhook", name: "x", url: "https://169.254.169.254/latest" })).status).toBe(400);
    expect((await s.channel({ kind: "email", name: "x", url: MAIL, secret: "provider-token" })).status).toBe(400);
    expect((await s.channel({ kind: "email", name: "x", url: MAIL, recipients: [R1] })).status).toBe(400);
    expect((await s.channel({ kind: "email", name: "x", url: MAIL, secret: "provider-token", recipients: ["stranger@example.test"] })).status).toBe(400);
    expect((await s.channel({ kind: "webhook", name: "x", url: HOOK, projectId: "nope" })).status).toBe(404);
    expect((await s.call("POST", "/v1/notify/channels", { user: R1, body: { kind: "webhook", name: "x", url: HOOK } })).status).toBe(403);
    expect((await s.call("POST", "/v1/notify/channels", { headers: bearer(s.key), body: { kind: "webhook", name: "x", url: HOOK } })).status).toBe(403);
    const del = await s.call("DELETE", `/v1/notify/channels/${hook.json.id}`, { user: A });
    expect(del.json).toEqual({ deleted: true });
    expect((await s.call("DELETE", `/v1/notify/channels/${hook.json.id}`, { user: A })).status).toBe(404);
  });

  it("fans out to Slack/Teams/email/webhook with signed links; filters by risk and project; auto-decided requests notify nobody", async () => {
    const s = await setup();
    await s.channel({ kind: "slack", name: "#a", url: SLACK, signingSecret: "slack-signing-1" });
    await s.channel({ kind: "teams", name: "t", url: TEAMS });
    await s.channel({ kind: "email", name: "m", url: MAIL, secret: "provider-token", recipients: [R1, R2] });
    const hook = (await s.channel({ kind: "webhook", name: "w", url: HOOK, minRisk: "critical" })).json;
    await s.channel({
      kind: "webhook",
      name: "other project",
      url: HOOK,
      projectId: (await s.call("POST", "/v1/review-projects", { user: A, body: { name: "other" } })).json.id,
    });
    const doc = { rules: [{ id: "auto", when: { action: "noop.*", risk: ["low"], minConfidence: 0.9 }, then: { outcome: "auto_approve" } }] };
    const pol = await s.call("POST", `/v1/review-projects/${s.projectId}/policies`, { user: A, body: { document: doc } });
    await s.call("POST", `/v1/review-projects/${s.projectId}/policies/${pol.json.version}/activate`, { user: A, body: { force: true } });
    await s.create({ action: "noop.x", risk: "low", confidence: 0.95 });
    const r = await s.create();
    const log = await s.call("GET", `/v1/agent-reviews/${r.id}/notifications`, { user: A });
    expect(log.json.items.map((d: { status: string }) => d.status)).toEqual(["pending", "pending", "pending", "pending"]);
    const sent = fake();
    expect(await sweepNotifications(s.env)).toEqual({ due: 4, sent: 4, failed: 0, dead: 0, skipped: 0 });
    expect(sent.map((x) => x.url).sort()).toEqual([SLACK, MAIL, MAIL, TEAMS]);
    const slackMsg = JSON.parse(sent.find((x) => x.url === SLACK)!.body);
    const buttons = slackMsg.blocks.at(-1).elements;
    expect(buttons.map((b: { action_id: string }) => b.action_id)).toEqual(["review_approve", "review_reject", "review_open"]);
    expect(buttons[2].url).toBe(`http://localhost:5173/#/agent-reviews/${r.id}`);
    expect(JSON.stringify(slackMsg)).toContain("&lt;b&gt;hi&lt;/b&gt;");
    const mails = sent.filter((x) => x.url === MAIL).map((x) => ({ h: x.headers, b: JSON.parse(x.body) }));
    expect(mails.map((m) => m.b.to).sort()).toEqual([R1, R2]);
    expect(mails[0]!.h.authorization).toBe("Bearer provider-token");
    expect(mails[0]!.b.html).toContain("/#/act/");
    const teams = JSON.parse(sent.find((x) => x.url === TEAMS)!.body);
    expect(teams.attachments[0].content.actions.map((a: { title: string }) => a.title)).toEqual(["Open"]);
    // critical request also reaches the critical-only webhook, signed
    const crit = await s.create({ risk: "critical" });
    const sent2 = fake();
    await sweepNotifications(s.env);
    const wh = sent2.find((x) => x.url === HOOK)!;
    expect(wh.headers["autopilot-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(wh.body)).toMatchObject({ type: "review.notification", requestId: crit.id, risk: "critical" });
    expect(hook.minRisk).toBe("critical");
  });

  it("email one-click: confirm via POST decides as the bound reviewer, once; expired, tampered and channel tokens are refused", async () => {
    const s = await setup();
    await s.channel({ kind: "email", name: "m", url: MAIL, secret: "provider-token", recipients: [R1] });
    await s.channel({ kind: "slack", name: "#a", url: SLACK, signingSecret: "slack-signing-1" });
    const r = await s.create();
    const sent = fake();
    await sweepNotifications(s.env);
    const mail = JSON.parse(sent.find((x) => x.url === MAIL)!.body);
    const approve = tokenFrom(mail.text.split("\n").find((l: string) => l.startsWith("Approve: ")));
    const reject = tokenFrom(mail.text.split("\n").find((l: string) => l.startsWith("Reject: ")));
    expect((await s.call("POST", "/notify/actions", { body: { token: `${approve.slice(0, -3)}AAA` } })).status).toBe(400);
    const ok = await s.call("POST", "/notify/actions", { body: { token: approve } });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ decision: "approve", reviewer: R1, requestId: r.id, status: "approved" });
    expect((await s.call("POST", "/notify/actions", { body: { token: approve } })).json.error.code).toBe("action_used");
    expect((await s.call("POST", "/notify/actions", { body: { token: reject } })).status).toBe(409);
    const audit = s.raw.prepare("select actor, action from audit_log where action = 'notify.action'").all();
    expect(audit).toEqual([{ actor: R1, action: "notify.action" }]);
    // channel-wide Slack tokens cannot be used as links
    const slackTok = JSON.parse(sent.find((x) => x.url === SLACK)!.body).blocks.at(-1).elements[0].value;
    expect((await s.call("POST", "/notify/actions", { body: { token: slackTok } })).json.error.code).toBe("invalid_action");
    expect((await s.call("POST", "/notify/actions", { body: {} })).status).toBe(400);
    expect((await s.call("POST", "/notify/actions", { body: { token: "not-a-token-at-all" } })).status).toBe(400);
    expect((await s.call("GET", `/notify/actions?token=${approve}`)).status).toBe(404);
    // expiry
    const r2 = await s.create({ timeoutSeconds: 60 });
    const sent2 = fake();
    await sweepNotifications(s.env);
    const tok = tokenFrom(
      JSON.parse(sent2.find((x) => x.url === MAIL)!.body)
        .text.split("\n")
        .find((l: string) => l.startsWith("Approve: ")),
    );
    __setWebhookClock(() => Date.now() + 120_000);
    expect((await s.call("POST", "/notify/actions", { body: { token: tok } })).status).toBe(410);
    expect(r2.status).toBe("pending");
  });

  it("one-click respects custom roles and deactivation", async () => {
    const s = await setup();
    const role = await s.call("POST", "/v1/roles", { user: A, body: { name: "rejecter", permissions: ["reviews.reject"] } });
    const uid = (s.raw.prepare("select id from users where email = ?").get(R1) as { id: string }).id;
    await s.call("PUT", `/v1/users/${uid}/custom-role`, { user: A, body: { customRoleId: role.json.id } });
    await s.channel({ kind: "email", name: "m", url: MAIL, secret: "provider-token", recipients: [R1, R2] });
    await s.create();
    const sent = fake();
    await sweepNotifications(s.env);
    const link = (to: string, which: string) =>
      tokenFrom(
        JSON.parse(sent.find((x) => x.url === MAIL && JSON.parse(x.body).to === to)!.body)
          .text.split("\n")
          .find((l: string) => l.startsWith(`${which}: `)),
      );
    expect((await s.call("POST", "/notify/actions", { body: { token: link(R1, "Approve") } })).json.error.code).toBe("forbidden_by_role");
    s.raw.prepare("update users set deactivated_at = '2026-01-01' where email = ?").run(R2);
    expect((await s.call("POST", "/notify/actions", { body: { token: link(R2, "Approve") } })).status).toBe(403);
  });

  it("Slack interactivity: verified signature, linked user decides; unlinked users and bad signatures are refused", async () => {
    const s = await setup();
    const ch = (await s.channel({ kind: "slack", name: "#a", url: SLACK, signingSecret: "slack-signing-1" })).json;
    expect((await s.call("PUT", `/v1/notify/channels/${ch.id}/identities`, { user: A, body: { externalId: "U123", email: R2 } })).status).toBe(200);
    expect(
      (await s.call("PUT", `/v1/notify/channels/${ch.id}/identities`, { user: A, body: { externalId: "U9", email: "stranger@example.test" } })).status,
    ).toBe(400);
    const r = await s.create();
    const sent = fake();
    await sweepNotifications(s.env);
    const els = JSON.parse(sent[0]!.body).blocks.at(-1).elements;
    const post = async (user: string, value: string, actionId = "review_approve", secret = "slack-signing-1") => {
      const body = `payload=${encodeURIComponent(JSON.stringify({ user: { id: user }, actions: [{ action_id: actionId, value }] }))}`;
      const ts = String(Math.floor(Date.now() / 1000));
      return s.call("POST", `/notify/slack/${ch.id}/interactions`, {
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": await R.slackSignature(secret, ts, body),
        },
        raw: body,
      });
    };
    expect((await post("U123", els[0].value, "review_approve", "wrong-secret")).status).toBe(401);
    expect((await post("U999", els[0].value)).json.text).toBe("This chat user is not linked to a reviewer");
    expect((await post("U123", els[0].value, "review_open")).json.text).toBe("Nothing to do.");
    const ok = await post("U123", els[0].value);
    expect(ok.json).toEqual({ response_type: "ephemeral", text: `Recorded approve by ${R2}. Request is now approved.` });
    expect((await post("U123", els[0].value)).json.text).toBe("This action link was already used");
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}`, { headers: bearer(s.key) })).json.status).toBe("approved");
    expect((await s.call("POST", `/notify/slack/nope/interactions`, { raw: "x" })).status).toBe(401);
  });

  it("retries with backoff, dead-letters non-retryable failures, re-queues on demand, skips final requests; test send", async () => {
    const s = await setup();
    const ch = (await s.channel({ kind: "teams", name: "t", url: TEAMS })).json;
    const r = await s.create();
    let code = 503;
    fake(() => code);
    expect(await sweepNotifications(s.env, 200, () => 0)).toMatchObject({ failed: 1 });
    let d = (await s.call("GET", `/v1/agent-reviews/${r.id}/notifications`, { user: A })).json.items[0];
    expect(d).toMatchObject({ status: "pending", attempt: 1, responseStatus: 503, lastError: "http_503" });
    __setWebhookClock(() => Date.now() + 3_600_000);
    code = 400;
    expect(await sweepNotifications(s.env, 200, () => 0)).toMatchObject({ dead: 1 });
    d = (await s.call("GET", `/v1/agent-reviews/${r.id}/notifications`, { user: A })).json.items[0];
    expect(d.status).toBe("dead");
    expect((await s.call("POST", `/v1/notify/deliveries/${d.id}/retry`, { user: A })).json).toMatchObject({ status: "pending", attempt: 0 });
    expect((await s.call("POST", `/v1/notify/deliveries/${d.id}/retry`, { user: A })).status).toBe(409);
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve" } });
    expect(await sweepNotifications(s.env)).toMatchObject({ skipped: 1 });
    code = 200;
    expect((await s.call("POST", `/v1/notify/channels/${ch.id}/test`, { user: A })).json).toEqual({ ok: true, status: 200, error: null });
    code = 500;
    expect((await s.call("POST", `/v1/notify/channels/${ch.id}/test`, { user: A })).json).toMatchObject({ ok: false, error: "http_500" });
  });

  it("without NOTIFY_ACTION_KEY messages carry open links only", async () => {
    const s = await setup({ NOTIFY_ACTION_KEY: "" });
    await s.channel({ kind: "slack", name: "#a", url: SLACK });
    await s.create();
    const sent = fake();
    await sweepNotifications(s.env);
    expect(
      JSON.parse(sent[0]!.body)
        .blocks.at(-1)
        .elements.map((e: { action_id: string }) => e.action_id),
    ).toEqual(["review_open"]);
    expect((await s.call("POST", "/notify/actions", { body: { token: `${Buffer.from('{"tid":"x"}').toString("base64url")}.abc` } })).status).toBe(400);
  });
});
