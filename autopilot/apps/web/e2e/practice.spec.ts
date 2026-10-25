import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** M7: practice console → invite a client contact (MOCK delivery: code shown to staff) → client portal. Synthetic. */
const axe = async (page: import("@playwright/test").Page, where: string) => {
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id}`)).toEqual([]);
};

test("practice console creates a firm and client, invites a contact, and the client signs in to the portal", async ({ page }) => {
  test.setTimeout(90_000); // three axe scans on emulated mobile
  await page.goto("/");
  await page.getByLabel("Email").fill(`e2e.practice.${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Trading name").fill("Own Books (synthetic)");
  await page.getByRole("button", { name: "Create" }).click();
  await page.goto("/#/practice");
  await expect(page.getByRole("heading", { name: "Practice" })).toBeVisible();
  await page.getByLabel("Practice name").fill("E2E Practice (synthetic)");
  await page.getByRole("button", { name: "Create practice" }).click();
  await page.getByLabel("New client name").fill("Client One (synthetic)");
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByRole("rowheader", { name: "Client One (synthetic)" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "csv imports" })).toContainText("real");
  await expect(page.getByRole("listitem").filter({ hasText: /^xero/ })).toContainText("mock");
  await axe(page, "practice");

  await page.getByRole("button", { name: "Invite contact" }).click();
  await page.getByLabel("Client contact email").fill("owner@client-one.test");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const code = (await page.getByRole("status").locator("code").textContent())!;
  expect(code.length).toBeGreaterThan(10);

  await page.goto("/#/portal");
  await expect(page.getByRole("heading", { name: "Client portal" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await axe(page, "portal sign-in");
  await page.getByLabel("Portal code").fill(code);
  await page.getByRole("button", { name: "Open portal" }).click();
  await expect(page.getByText(/Client One \(synthetic\), with E2E Practice/)).toBeVisible();
  await expect(page.getByText("Nothing requested.")).toBeVisible();
  await axe(page, "portal home");
  // The code is single use.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Portal code").fill(code);
  await page.getByRole("button", { name: "Open portal" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
});
