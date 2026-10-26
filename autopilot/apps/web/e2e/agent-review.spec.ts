import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** Agent review layer end to end: developer console → agent request over the API → reviewer decides in the inbox. Synthetic data only. */
const API = "http://127.0.0.1:8787";
const axe = async (page: Page, where: string) => {
  await page.waitForLoadState("networkidle");
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
