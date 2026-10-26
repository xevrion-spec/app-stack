import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** Agent review layer end to end: developer console → agent request over the API → reviewer decides in the inbox. Synthetic data only. */
const API = "http://127.0.0.1:8787";
const axe = async (page: Page, where: string) => {
  // The live inbox keeps an event stream open, so "networkidle" never fires there: settle on the Live badge instead.
  await Promise.race([
    page.waitForLoadState("networkidle"),
    page
      .getByText("Live", { exact: true })
      .waitFor()
      .then(() => page.waitForTimeout(500)),
  ]);
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} (${v.nodes.length})`)).toEqual([]);
};
async function signUp(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Trading name").fill("Agent Ops Co (synthetic)");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
}
const asUser = async (page: Page, email: string, hash: string) => {
  await page.evaluate((e) => localStorage.setItem("autopilot.devUser", e), email);
  await page.goto(`/${hash}`);
  await page.reload();
};
/** Owner flow in the console: project + key. Returns the API key shown once. */
async function connectAgent(page: Page): Promise<string> {
  await page.goto("/#/agents");
  await expect(page.getByRole("heading", { name: "Agent developer console" })).toBeVisible();
  const create = page.getByRole("form", { name: "Create project" });
  await create.getByLabel("Name").fill("Support agent");
  await create.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("once-secret")).toContainText("whsec_");
  const keyForm = page.getByRole("form", { name: "Create API key" });
  await keyForm.getByRole("button", { name: "Create key" }).click();
  const key = page.getByTestId("once-secret").filter({ hasText: "ap_" });
  await expect(key).toBeVisible();
  return (await key.textContent())!.trim();
}
const ask = (request: APIRequestContext, key: string, body: Record<string, unknown>, idem: string) =>
  request.post(`${API}/v1/agent-reviews`, { headers: { authorization: `Bearer ${key}`, "idempotency-key": idem }, data: body });

test("console → agent asks → reviewer edits & approves, rejects with a reason; audit verified; no axe issues", async ({ page, request }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const owner = `e2e.ar.owner.${stamp}@example.test`;
  const reviewer = `e2e.ar.reviewer.${stamp}@example.test`;
  await signUp(page, owner);
  const key = await connectAgent(page);
  await axe(page, "console");

  // Policy: replay the template on (empty) history, save as draft, activate; the simulator then routes by it.
  await page.getByRole("button", { name: "Replay on past requests" }).click();
  await expect(page.getByRole("region", { name: "Replay report" })).toContainText("Safe to activate");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.getByRole("button", { name: "Activate v1" }).click();
  await expect(page.getByRole("status").filter({ hasText: "v1 is now active" })).toBeAttached();
  const sim = page.getByRole("form", { name: "Simulate a request" });
  await sim.getByRole("button", { name: "Simulate" }).click();
  await expect(page.getByTestId("sim-outcome")).toHaveText("auto approve");
  await sim.getByLabel("Risk").selectOption("critical");
  await sim.getByRole("button", { name: "Simulate" }).click();
  await expect(page.getByTestId("sim-outcome")).toHaveText("human");
  await expect(page.getByRole("region", { name: "Simulation result" })).toContainText("critical_four_eyes");
  await axe(page, "console with results");

  // The agent asks over the real API with its project key.
  const r1 = await ask(
    request,
    key,
    { action: "email.send", risk: "medium", payload: { to: "customer@example.test", body: "Your refund is denied." }, context: { ticket: "T-1" } },
    `a-${stamp}`,
  );
  expect(r1.status()).toBe(201);
  const r2 = await ask(request, key, { action: "payment.wire", risk: "high", payload: { amount: 900, to: "acct-9" } }, `b-${stamp}`);
  expect(r2.status()).toBe(201);
  const id1 = ((await r1.json()) as { id: string }).id;

  // A reviewer (not the owner) works the inbox; the owner-only console is hidden from them.
  expect(
    (
      await request.post(`${API}/v1/users`, { headers: { "x-dev-user": owner, "idempotency-key": `u-${stamp}` }, data: { email: reviewer, role: "reviewer" } })
    ).status(),
  ).toBeLessThan(300);
  await asUser(page, reviewer, "#/agent-reviews");
  await expect(page.getByRole("heading", { name: "Agent reviews" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Agent console" })).toHaveCount(0);
  const inbox = page.getByRole("list", { name: "pending agent requests" });
  await expect(inbox.getByRole("listitem")).toHaveCount(2);
  await inbox.getByRole("button", { name: /email\.send/ }).click();
  const detail = page.getByRole("article");
  await expect(detail.getByText("verified · 1 entries")).toBeVisible();
  await expect(detail.getByLabel("Agent context")).toContainText("T-1");
  await axe(page, "inbox detail");

  // Edit: invalid JSON is flagged accessibly and blocks saving; a valid edit approves version 2.
  await detail.getByRole("button", { name: /Edit then approve/ }).click();
  const payload = detail.getByLabel("Edited payload (JSON)");
  await payload.fill("{ not json");
  await expect(payload).toHaveAttribute("aria-invalid", "true");
  await expect(detail.getByRole("button", { name: "Save edit and approve" })).toBeDisabled();
  await payload.fill(JSON.stringify({ to: "customer@example.test", body: "Your refund is approved." }));
  await detail.getByRole("button", { name: "Save edit and approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Request is now approved" })).toBeAttached();
  await expect(inbox.getByRole("listitem")).toHaveCount(1);

  // Reject needs a reason.
  await inbox.getByRole("button", { name: /payment\.wire/ }).click();
  await detail.getByRole("button", { name: "Reject" }).click();
  await expect(detail.getByRole("alert")).toContainText("Give a reason");
  await detail.getByLabel("Reason (required to reject)").fill("Destination account not on the allow list");
  await detail.getByRole("button", { name: "Reject" }).click();
  await expect(inbox.getByRole("listitem")).toHaveCount(0);

  // The edited request shows the diff, its history and a verified 2-entry trail; evidence downloads.
  await page.getByLabel("Status").selectOption("approved");
  await page
    .getByRole("list", { name: "approved agent requests" })
    .getByRole("button", { name: /email\.send/ })
    .click();
  await expect(detail.locator("tr.changed")).toHaveCount(1);
  await expect(detail.getByRole("list").last()).toContainText(`edit by ${reviewer} on v2`);
  await expect(detail.getByText("verified · 2 entries")).toBeVisible();
  const dl = page.waitForEvent("download");
  await detail.getByRole("button", { name: "Download evidence pack" }).click();
  expect((await dl).suggestedFilename()).toBe(`review-evidence-${id1}.json`);
  // The API agrees: the agent sees the human's edited payload.
  const final = (await (await request.get(`${API}/v1/agent-reviews/${id1}`, { headers: { authorization: `Bearer ${key}` } })).json()) as {
    status: string;
    payload: { body: string };
  };
  expect([final.status, final.payload.body]).toEqual(["approved", "Your refund is approved."]);
  await axe(page, "inbox approved");
});

test("keyboard: A approves without the mouse; dark mode passes axe", async ({ page, request }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const owner = `e2e.ar.kb.${stamp}@example.test`;
  await signUp(page, owner);
  const key = await connectAgent(page);
  expect((await ask(request, key, { action: "crm.update", risk: "low", payload: { field: "tier", value: "gold" } }, `k-${stamp}`)).status()).toBe(201);
  await page.evaluate(() => localStorage.setItem("autopilot.theme", "dark"));
  await page.goto("/#/agent-reviews");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /crm\.update/ }).click();
  await expect(page.getByRole("article").getByText(/verified/)).toBeVisible();
  await axe(page, "inbox dark");
  await page.getByRole("heading", { name: /crm\.update/ }).click();
  await page.keyboard.press("a");
  await expect(page.getByRole("status").filter({ hasText: "Request is now approved" })).toBeAttached();
  await page.goto("/#/agents");
  await axe(page, "console dark");
});

test("legal hold and redaction badges are labelled, shown in list + detail, and pass axe (light + dark)", async ({ page, request }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const owner = `e2e.ar.hold.${stamp}@example.test`;
  await signUp(page, owner);
  const key = await connectAgent(page);
  const mk = async (action: string, n: number) =>
    ((await (await ask(request, key, { action, risk: "low", payload: { n } }, `h-${stamp}-${n}`)).json()) as { id: string }).id;
  const held = await mk("crm.hold", 1);
  const red = await mk("crm.redact", 2);
  const as = { "x-dev-user": owner };
  expect((await request.post(`${API}/v1/agent-reviews/${held}/legal-hold`, { headers: as, data: { reason: "synthetic litigation hold" } })).status()).toBe(200);
  expect((await request.post(`${API}/v1/agent-reviews/${red}/decisions`, { headers: as, data: { decision: "approve" } })).status()).toBe(200);
  expect((await request.post(`${API}/v1/agent-reviews/${red}/redact`, { headers: as, data: {} })).status()).toBe(200);
  await page.goto("/#/agent-reviews");
  await page.reload();
  const pending = page.getByRole("list", { name: "pending agent requests" });
  await expect(pending.getByRole("button", { name: /crm\.hold/ })).toContainText("legal hold");
  await pending.getByRole("button", { name: /crm\.hold/ }).click();
  await expect(page.getByRole("heading", { name: /crm\.hold/ })).toContainText("legal hold");
  await axe(page, "inbox legal hold");
  await page.getByLabel("Status").selectOption("approved");
  const approved = page.getByRole("list", { name: "approved agent requests" });
  await approved.getByRole("button", { name: /crm\.redact/ }).click();
  await expect(page.getByRole("heading", { name: /crm\.redact/ })).toContainText("redacted");
  await expect(page.getByRole("note").filter({ hasText: "were redacted on" })).toBeVisible();
  await axe(page, "inbox redacted");
  await page.evaluate(() => localStorage.setItem("autopilot.theme", "dark"));
  await page.reload();
  await page.getByLabel("Status").selectOption("approved");
  await page
    .getByRole("list", { name: "approved agent requests" })
    .getByRole("button", { name: /crm\.redact/ })
    .click();
  await expect(page.getByRole("heading", { name: /crm\.redact/ })).toContainText("redacted");
  await axe(page, "inbox redacted dark");
});

test("email notification → one-click link → confirm page approves once; opening the link alone decides nothing; axe clean", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { createServer } = await import("node:http");
  const mails: { to: string; text: string }[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      mails.push(JSON.parse(b));
      res.end("ok");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    const stamp = Date.now();
    const owner = `e2e.ar.notify.${stamp}@example.test`;
    await signUp(page, owner);
    const key = await connectAgent(page);
    const as = { "x-dev-user": owner };
    const ch = await request.post(`${API}/v1/notify/channels`, {
      headers: as,
      data: { kind: "email", name: "mail", url: `http://127.0.0.1:${port}/send`, secret: "synthetic-provider-token", recipients: [owner] },
    });
    expect(ch.status()).toBe(201);
    const id = ((await (await ask(request, key, { action: "refund.issue", risk: "high", payload: { amount: 42 } }, `n-${stamp}`)).json()) as { id: string }).id;
    await expect.poll(() => mails.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const approve = mails[0]!.text
      .split("\n")
      .find((l) => l.startsWith("Approve: "))!
      .slice("Approve: ".length);
    expect(approve).toContain("/#/act/");
    await page.goto(approve.replace(/^https?:\/\/[^/]+/, ""));
    await expect(page.getByRole("heading", { name: "Approve this agent request?" })).toBeVisible();
    // merely opening the link must not have decided
    const before = (await (await request.get(`${API}/v1/agent-reviews/${id}`, { headers: as })).json()) as { status: string };
    expect(before.status).toBe("pending");
    await axe(page, "act confirm");
    await page.getByLabel(/Reason/).fill("Looks right");
    await page.getByRole("button", { name: "Confirm approve" }).click();
    await expect(page.getByRole("status")).toContainText("now approved");
    await page.reload();
    await page.getByRole("button", { name: "Confirm approve" }).click();
    await expect(page.getByRole("alert")).toContainText("already used");
    await axe(page, "act used");
  } finally {
    srv.close();
  }
});

test("live inbox: new requests appear without reload; a request changed elsewhere is flagged, not overwritten; axe clean", async ({ page, request }) => {
  const stamp = Date.now();
  const owner = `e2e.ar.live.${stamp}@example.test`;
  await signUp(page, owner);
  const key = await connectAgent(page);
  await page.goto("/#/agent-reviews");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const inbox = page.getByRole("list", { name: "pending agent requests" });
  await expect(inbox.getByRole("listitem")).toHaveCount(0);
  const first = (
    (await (await ask(request, key, { action: "crm.update", risk: "medium", payload: { field: "tier" } }, `l1-${stamp}`)).json()) as { id: string }
  ).id;
  await expect(inbox.getByRole("listitem")).toHaveCount(1, { timeout: 5000 });
  await inbox.getByRole("button", { name: /crm\.update/ }).click();
  await expect(page.getByRole("article")).toBeVisible();
  // someone else (an API key can cancel its own request) changes it while it is open
  expect(
    (
      await request.post(`${API}/v1/agent-reviews/${first}/cancel`, { headers: { authorization: `Bearer ${key}`, "idempotency-key": `c-${stamp}` }, data: {} })
    ).status(),
  ).toBeLessThan(300);
  await expect(page.getByRole("alert")).toContainText("updated elsewhere", { timeout: 5000 });
  await page.getByRole("button", { name: "Show the latest" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await axe(page, "live stale notice");
  await page.evaluate(() => localStorage.setItem("autopilot.theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await axe(page, "live inbox dark");
});

test("approval chain: steps shown in order with the current one marked; delegate decides for a lead; axe clean", async ({ page, request }) => {
  const stamp = Date.now();
  const owner = `e2e.ar.chain.${stamp}@example.test`;
  const lead = `e2e.lead.${stamp}@example.test`;
  const cover = `e2e.cover.${stamp}@example.test`;
  await signUp(page, owner);
  const key = await connectAgent(page);
  const as = (u: string) => ({ "x-dev-user": u, "idempotency-key": crypto.randomUUID() });
  for (const u of [lead, cover])
    expect((await request.post(`${API}/v1/users`, { headers: as(owner), data: { email: u, role: "reviewer" } })).status()).toBeLessThan(300);
  await request.put(`${API}/v1/review-groups/leads`, { headers: as(owner), data: { members: [lead] } });
  const projects = (await (await request.get(`${API}/v1/review-projects`, { headers: as(owner) })).json()) as { items: { id: string }[] };
  const pid = projects.items[0]!.id;
  const doc = {
    rules: [
      {
        id: "chain",
        when: {},
        then: {
          outcome: "human",
          steps: [
            { name: "lead", group: "leads", approvals: 1 },
            { name: "owner sign-off", approvals: 1 },
          ],
        },
      },
    ],
  };
  const v = (
    (await (await request.post(`${API}/v1/review-projects/${pid}/policies`, { headers: as(owner), data: { document: doc } })).json()) as { version: number }
  ).version;
  await request.post(`${API}/v1/review-projects/${pid}/policies/${v}/activate`, { headers: as(owner), data: {} });
  const id = ((await (await ask(request, key, { action: "vendor.pay", risk: "high", payload: { amount: 900 } }, `ch-${stamp}`)).json()) as { id: string }).id;
  // the lead is away: they delegate to cover, who decides the lead step
  expect(
    (
      await request.post(`${API}/v1/review-delegations`, {
        headers: as(lead),
        data: { toEmail: cover, endsAt: new Date(Date.now() + 86_400_000).toISOString() },
      })
    ).status(),
  ).toBe(201);
  expect((await request.post(`${API}/v1/agent-reviews/${id}/decisions`, { headers: as(cover), data: { decision: "approve" } })).status()).toBe(200);
  await page.goto("/#/agent-reviews");
  const inbox = page.getByRole("list", { name: "pending agent requests" });
  await expect(inbox.getByRole("button", { name: /vendor\.pay/ })).toContainText("step 2/2");
  await inbox.getByRole("button", { name: /vendor\.pay/ }).click();
  const chain = page.getByRole("list", { name: "Approval chain" });
  await expect(chain.getByRole("listitem")).toHaveText([/lead \(leads\): 1\/1 · done/, /owner sign-off: 0\/1 · now deciding/]);
  await expect(chain.locator('[aria-current="step"]')).toContainText("owner sign-off");
  await axe(page, "chain detail");
});
