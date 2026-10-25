import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { fileURLToPath } from "node:url";

/** M9: staff client workspace + full portal loop (upload, answer, accept) + four-eyes sign-off. Synthetic data only. */
const csv = fileURLToPath(new URL("./fixtures/statement.csv", import.meta.url));
const API = "http://127.0.0.1:8787";
const axe = async (page: Page, where: string) => {
  await page.waitForLoadState("networkidle");
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id}`)).toEqual([]);
};
async function signUp(page: Page, email: string, business: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Trading name").fill(business);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
}

test("staff workspace → client portal loop → four-eyes sign-off", async ({ page, request }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const partner = `e2e.partner.${stamp}@example.test`;
  const reviewer = `e2e.reviewer.${stamp}@example.test`;
  await signUp(page, partner, "Partner Own Books (synthetic)");
  await page.goto("/#/practice");
  await page.getByLabel("Practice name").fill("Workflow Practice (synthetic)");
  await page.getByRole("button", { name: "Create practice" }).click();
  await page.getByLabel("New client name").fill("Acme Plumbing (synthetic)");
  await page.getByRole("button", { name: "Add client" }).click();
  const added = await request.post(`${API}/v1/practice/staff`, {
    headers: { "x-dev-user": partner, "idempotency-key": `staff-${stamp}` },
    data: { email: reviewer, role: "reviewer" },
  });
  expect(added.status()).toBeLessThan(300);

  // Invite the client contact first (mock delivery: the code is shown to staff).
  await page.getByRole("button", { name: "Invite contact" }).click();
  await page.getByLabel("Client contact email").fill(`owner.${stamp}@acme.test`);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const code = (await page.getByRole("status").locator("code").textContent())!;

  await page.getByRole("link", { name: "Acme Plumbing (synthetic)" }).click();
  await expect(page.getByRole("heading", { name: "Client: Acme Plumbing (synthetic)" })).toBeVisible();
  await page.getByLabel("Staff email").fill(reviewer);
  await page.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByText(`${reviewer} (reviewer)`)).toBeVisible();
  await page.getByLabel("Fee summary").fill("£120 per month (synthetic)");
  await page.getByLabel("Letter text").fill("We will keep your books and prepare VAT returns. Synthetic demo letter.");
  await page.getByRole("button", { name: "Create draft letter" }).click();
  await page.getByRole("button", { name: "Send to client" }).click();
  await expect(page.getByRole("region", { name: "Engagement letters" }).getByText("sent", { exact: true })).toBeVisible();
  await page.getByLabel("Document needed").fill("June bank statement (synthetic)");
  await page.getByRole("button", { name: "Request documents" }).click();
  await expect(page.getByRole("button", { name: "Waive June bank statement (synthetic)" })).toBeVisible();
  await page.getByLabel("Question for the client").fill("What was the £42 payment to TOOLSTATION? (synthetic)");
  await page.getByRole("button", { name: "Ask client" }).click();
  await page.getByRole("button", { name: "Prepare paper" }).click();
  await expect(page.getByText("(you prepared this, so someone else must sign it off)")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Sign off/ })).toHaveCount(0); // partner prepared it: four-eyes
  await axe(page, "client workspace");

  // Client portal: upload, answer, accept.
  await page.goto("/#/portal");
  await page.getByLabel("Portal code").fill(code);
  await page.getByRole("button", { name: "Open portal" }).click();
  await page.getByLabel("Upload for June bank statement (synthetic)").setInputFiles(csv);
  await expect(page.getByText("June bank statement (synthetic)").locator("..").getByText("fulfilled")).toBeVisible();
  await page.getByLabel("Your answer").fill("Copper fittings for a job (synthetic)");
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByText("Your answer: Copper fittings for a job (synthetic)")).toBeVisible();
  await page.getByRole("button", { name: "I have read and accept this letter" }).click();
  await expect(page.getByRole("article").getByText("accepted", { exact: true })).toBeVisible();
  await axe(page, "portal after actions");
  await page.getByRole("button", { name: "Sign out" }).click();

  // Staff sees the results; the reviewer (not the preparer) signs off.
  await page.goto("/#/practice");
  await page.getByRole("link", { name: "Acme Plumbing (synthetic)" }).click();
  await expect(page.getByRole("region", { name: "Engagement letters" }).getByText("accepted", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Client queries" }).getByText(/Answer: Copper fittings/)).toBeVisible();
  const url = page.url();
  await page.evaluate((u) => localStorage.setItem("autopilot.devUser", u), reviewer);
  await page.goto("/");
  await page.getByLabel("Trading name").fill("Reviewer Own Books (synthetic)");
  await page.getByRole("button", { name: "Create" }).click();
  await page.goto(url);
  await page.getByRole("button", { name: "Sign off trial balance" }).click();
  await expect(page.getByText(/signed off by e2e\.reviewer/)).toBeVisible();
  await axe(page, "client workspace (reviewer)");
});
