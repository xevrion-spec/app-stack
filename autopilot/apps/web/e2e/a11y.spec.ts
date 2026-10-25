import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("no serious or critical axe violations on any page", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(`e2e.a11y.${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Trading name").fill("A11y Co (synthetic)");
  await page.getByRole("button", { name: "Create" }).click();
  for (const r of ["review", "transactions", "upload", "invoices", "vat", "jobs", "settings"]) {
    await page.goto(`/#/${r}`);
    await expect(page.locator("#page-title")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${r}: ${v.id} (${v.nodes.length})`)).toEqual([]);
  }
});
