import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const csv = fileURLToPath(new URL("./fixtures/statement.csv", import.meta.url));

async function signUp(page: Page, tag: string) {
  const email = `e2e.${tag}.${Date.now()}@example.test`;
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Set up your business" })).toBeVisible();
  await page.getByLabel("Trading name").fill(`E2E ${tag} (synthetic)`);
  await page.getByLabel(/VAT registered/).check();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
  return email;
}

test("sign in, upload a statement, see categorised transactions and the job timeline", async ({ page }) => {
  await signUp(page, "upload");
  await page.getByRole("link", { name: "Upload" }).click();
  await page.getByLabel(/Bank statement/).setInputFiles(csv);
  await page.getByRole("button", { name: "Upload and process" }).click();
  await expect(page.getByText(/Imported 6 transactions/)).toBeVisible();
  await page.getByRole("button", { name: "View job timeline" }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".timeline")).toContainText("categorise", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  await page.getByRole("link", { name: "Transactions" }).click();
  await expect(page.getByRole("cell", { name: "TRANSFER TO SAVINGS", exact: true })).toBeVisible();
  await page.getByLabel("Status").selectOption("needs_review");
  await expect(page.getByRole("cell", { name: "MYSTERY PAYEE 99", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Categorise MYSTERY PAYEE 99" }).click();
  await page.getByLabel("Category", { exact: true }).selectOption("6300");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Categorise MYSTERY PAYEE 99" })).toBeVisible();
});

test("review queue resolves an exception", async ({ page }) => {
  await signUp(page, "review");
  await page.getByRole("link", { name: "Upload" }).click();
  await page.getByLabel(/Bank statement/).setInputFiles(csv);
  await page.getByRole("button", { name: "Upload and process" }).click();
  await expect(page.getByText(/Imported/)).toBeVisible();
  await page.getByRole("link", { name: "Review queue" }).click();
  const first = page.locator(".cards > li").first();
  await expect(async () => {
    await page.reload();
    await expect(page.locator(".cards > li").first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  const before = await page.locator(".cards > li").count();
  await first.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText(/^Resolved:/)).toBeVisible();
  await expect(page.locator(".cards > li")).toHaveCount(before - 1);
});

test("create, send and download an invoice; compute a VAT draft", async ({ page }) => {
  await signUp(page, "invoice");
  await page.getByRole("link", { name: "Invoices" }).click();
  await page.getByRole("button", { name: "New invoice" }).click();
  await page.getByLabel("Customer name").fill("Acme Ltd (synthetic)");
  await page.getByLabel("Description").fill("Design work");
  await page.getByLabel(/Unit price/).fill("250");
  await page.getByRole("button", { name: "Create draft invoice" }).click();
  await expect(page.getByRole("cell", { name: "£300.00" })).toBeVisible();
  await page.getByRole("button", { name: /Mark .* sent/ }).click();
  await expect(page.getByText("sent", { exact: true })).toBeVisible();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download PDF/ }).click();
  expect((await dl).suggestedFilename()).toMatch(/^invoice-.*\.pdf$/);

  await page.getByRole("link", { name: "VAT & SA" }).click();
  await expect(page.getByRole("note")).toContainText("Draft only");
  await page.getByLabel("Period start").fill("2020-01-01");
  await page.getByLabel("Period end").fill("2030-12-31");
  await page.getByRole("button", { name: "Compute draft" }).click();
  await expect(page.getByText("draft, unverified")).toBeVisible();
  await expect(page.locator(".box").filter({ hasText: "Box 1 VAT due on sales" })).toContainText("£50.00");
});

test("settings: owner adds a reviewer; reviewer cannot edit business settings", async ({ page }) => {
  await signUp(page, "settings");
  await page.getByRole("link", { name: "Settings" }).click();
  const reviewer = `e2e.rev.${Date.now()}@example.test`;
  await page.getByRole("form", { name: "Add person" }).getByLabel("Email").fill(reviewer);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText(`Added ${reviewer}`)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill(reviewer);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("Only owners can change settings.")).toBeVisible();
  await expect(page.getByLabel("Trading name")).toBeDisabled();
});
