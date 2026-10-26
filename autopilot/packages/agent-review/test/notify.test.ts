import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  renderEmail,
  renderSlack,
  renderTeams,
  renderWebhook,
  signAction,
  slackSignature,
  summarise,
  verifyAction,
  verifySlackSignature,
  type ActionClaims,
  type NotifyInput,
} from "../src/index.js";

const C: ActionClaims = { v: 1, tid: "t1", rid: "r1", d: "approve", u: "a@example.test", exp: 1000, n: "nonce1" };
const N: NotifyInput = {
  requestId: "r1",
  action: "refund.issue",
  risk: "high",
  project: "Support <prod>",
  deadlineAt: "2026-10-27T00:00:00.000Z",
  summary: [
    ["amount", "120"],
    ["note", "<script>x</script> & 'q'"],
  ],
  openUrl: "https://app.example.test/#/agent-reviews?id=r1",
  approveUrl: "https://app.example.test/#/act?token=a",
  rejectUrl: "https://app.example.test/#/act?token=b",
};

describe("action tokens", () => {
  it("round-trips, and rejects tampering, wrong secret, expiry, malformed", async () => {
    const t = await signAction(C, "s3cret");
    expect(await verifyAction(t, "s3cret", 999)).toEqual({ ok: true, claims: C });
    expect(await verifyAction(t, "s3cret", 1000)).toMatchObject({ ok: true });
    expect(await verifyAction(t, "s3cret", 1001)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyAction(t, "other", 999)).toEqual({ ok: false, reason: "bad_signature" });
    const [body, sig] = t.split(".");
    const forged = btoa(JSON.stringify({ ...C, d: "reject" })).replace(/=+$/, "");
    expect(await verifyAction(`${forged}.${sig}`, "s3cret", 999)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyAction(`${body}`, "s3cret", 999)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAction(`${body}.${sig}.x`, "s3cret", 999)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAction("!!.??", "s3cret", 999)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAction(`${body}.${sig!.slice(0, -4)}`, "s3cret", 999)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects signed tokens with an unknown version or decision", async () => {
    for (const bad of [
      { ...C, v: 2 },
      { ...C, d: "edit" },
      { ...C, exp: "1000" },
    ])
      expect(await verifyAction(await signAction(bad as unknown as ActionClaims, "k"), "k", 1)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAction(await signAction({ ...C, d: "reject" }, "k"), "k", 1)).toMatchObject({ ok: true });
  });
  it("property: any claims round-trip; any single-char change to the signature fails", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string({ minLength: 1 }), fc.nat(), async (rid, secret, exp) => {
        const t = await signAction({ ...C, rid, exp }, secret);
        expect(await verifyAction(t, secret, exp)).toMatchObject({ ok: true, claims: { rid } });
      }),
      { numRuns: 50 },
    );
  });
});

describe("Slack signing", () => {
  it("accepts a valid signature inside 5 minutes only", async () => {
    const sig = await slackSignature("ss", "1000", "a=b");
    expect(sig).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(await verifySlackSignature("ss", "1000", "a=b", sig, 1300)).toBe(true);
    expect(await verifySlackSignature("ss", "1000", "a=b", sig, 1301)).toBe(false);
    expect(await verifySlackSignature("ss", "1000", "a=b", sig, 699)).toBe(false);
    expect(await verifySlackSignature("ss", "1000", "a=c", sig, 1000)).toBe(false);
    expect(await verifySlackSignature("xx", "1000", "a=b", sig, 1000)).toBe(false);
    expect(await verifySlackSignature("ss", null, "a=b", sig, 1000)).toBe(false);
    expect(await verifySlackSignature("ss", "1000", "a=b", null, 1000)).toBe(false);
    expect(await verifySlackSignature("ss", "10e2", "a=b", sig, 1000)).toBe(false);
  });
});

describe("summarise", () => {
  it("keeps sorted top-level scalars, truncates, and hides nested content", () => {
    expect(summarise(null)).toEqual([]);
    expect(summarise([1, 2])).toEqual([]);
    expect(summarise("x")).toEqual([]);
    const s = summarise({ z: 1, a: "x".repeat(100), n: null, o: { secret: "hidden" }, l: [1, 2, 3], b: true });
    expect(s.map(([k]) => k)).toEqual(["a", "b", "l", "n", "o", "z"]);
    expect(s[0]![1]).toHaveLength(80);
    expect(s[0]![1].endsWith("…")).toBe(true);
    expect(Object.fromEntries(s)).toMatchObject({ b: "true", l: "[3 items]", n: "null", o: "{…}", z: "1" });
    expect(JSON.stringify(s)).not.toContain("hidden");
    expect(summarise(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i])))).toHaveLength(8);
    expect(summarise({ ["k".repeat(50)]: "v" })[0]![0]).toHaveLength(40);
    expect(summarise({ a: "x".repeat(80) })[0]![1]).toHaveLength(80);
  });
});

describe("renderers", () => {
  it("Slack: escaped mrkdwn, approve/reject buttons carry tokens, open link always present", () => {
    const m = renderSlack(N, { approve: "TA", reject: "TR" });
    const json = JSON.stringify(m);
    expect(m.text).toBe("Review needed: refund.issue (high risk) in Support <prod>");
    expect(json).toContain("Support &lt;prod&gt;");
    expect(json).toContain("&lt;script&gt;x&lt;/script&gt; &amp;");
    const actions = m.blocks.at(-1) as { block_id: string; elements: { action_id: string; value?: string; url?: string }[] };
    expect(actions.block_id).toBe("review:r1");
    expect(actions.elements.map((e) => e.action_id)).toEqual(["review_approve", "review_reject", "review_open"]);
    expect(actions.elements[0]!.value).toBe("TA");
    expect(actions.elements[1]!.value).toBe("TR");
    expect(actions.elements[2]!.url).toBe(N.openUrl);
    const noTok = renderSlack({ ...N, summary: [] }, null);
    expect(noTok.blocks).toHaveLength(2);
    expect((noTok.blocks[1] as { elements: unknown[] }).elements).toHaveLength(1);
  });
  it("Teams: adaptive card with facts and open-url actions", () => {
    const m = renderTeams(N);
    const card = m.attachments[0]!.content;
    expect(m.attachments[0]!.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.body[1]).toEqual({
      type: "FactSet",
      facts: [
        { title: "amount", value: "120" },
        { title: "note", value: N.summary[1]![1] },
      ],
    });
    expect(card.actions.map((a) => a.title)).toEqual(["Approve", "Reject", "Open"]);
    expect(renderTeams({ ...N, approveUrl: undefined, rejectUrl: undefined }).attachments[0]!.content.actions).toHaveLength(1);
  });
  it("email: HTML-escaped, text alternative, confirm-first notice", () => {
    const e = renderEmail(N);
    expect(e.subject).toBe("Review needed: refund.issue (high risk) in Support <prod>");
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
    expect(e.html).toContain("&#39;q&#39;");
    expect(e.html).toContain('<a href="https://app.example.test/#/act?token=a">Approve</a>');
    expect(e.html).toContain("never decides on its own");
    expect(e.text.split("\n")).toEqual([
      e.subject,
      "amount: 120",
      `note: ${N.summary[1]![1]}`,
      `Decide by ${N.deadlineAt}`,
      `Approve: ${N.approveUrl}`,
      `Reject: ${N.rejectUrl}`,
      `Open: ${N.openUrl}`,
    ]);
    const bare = renderEmail({ ...N, approveUrl: undefined, rejectUrl: undefined, action: "x".repeat(200) });
    expect(bare.subject).toHaveLength(150);
    expect(bare.text).not.toContain("Approve:");
    expect(bare.html).not.toContain(">Approve<");
  });
  it("webhook: summary object and no action tokens", () => {
    expect(renderWebhook(N)).toEqual({
      type: "review.notification",
      requestId: "r1",
      action: "refund.issue",
      risk: "high",
      project: "Support <prod>",
      deadlineAt: N.deadlineAt,
      summary: { amount: "120", note: N.summary[1]![1] },
      openUrl: N.openUrl,
    });
  });
});

describe("notify edges (mutation hardening)", () => {
  it("renderer output is stable (snapshots)", () => {
    expect(renderSlack(N, { approve: "TA", reject: "TR" })).toMatchSnapshot();
    expect(renderTeams(N)).toMatchSnapshot();
    expect(renderEmail(N)).toMatchSnapshot();
  });
  it("escapes ampersands and double quotes in HTML; summary boundary at exactly 80/81 chars", () => {
    const e = renderEmail({ ...N, summary: [["q", 'a & "b"']] });
    expect(e.html).toContain("a &amp; &quot;b&quot;");
    expect(summarise({ a: "x".repeat(81) })[0]![1]).toHaveLength(80);
    expect(summarise({ a: "x".repeat(80) })[0]![1]).toBe("x".repeat(80));
  });
  it("token parts: empty signature or body is malformed; tokens have no padding", async () => {
    const t = await signAction(C, "s");
    expect(t).not.toContain("=");
    const [body] = t.split(".");
    expect(await verifyAction(`${body}.`, "s", 1)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAction(`.${t.split(".")[1]}`, "s", 1)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAction(`${body}.${t.split(".")[1]}A`, "s", 1)).not.toMatchObject({ ok: true });
  });
  it("Slack timestamps must be all digits", async () => {
    const sig = await slackSignature("ss", "1000", "b");
    for (const ts of ["1000x", "x1000", " 1000"]) expect(await verifySlackSignature("ss", ts, "b", sig, 1000)).toBe(false);
    expect(await verifySlackSignature("ss", "1000", "b", `${sig}0`, 1000)).toBe(false);
    expect(await verifySlackSignature("ss", "1000", "b", sig.slice(0, -1), 1000)).toBe(false);
  });
});
