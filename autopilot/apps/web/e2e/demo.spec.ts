import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** Demo mode: synthetic day-in-the-life → exceptions-only review → approve → audit export. Synthetic data only. */
test("demo day: seed, review only exceptions, approve one, export the audit trail", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByLabel("Email").fill(`e2e.demo.${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Trading name").fill("Demo Partner Own Books (synthetic)");
  await page.getByRole("button", { name: "Create" }).click();
  await page.goto("/#/practice");
  await page.getByRole("button", { name: "Load synthetic demo day" }).click();
  await expect(page.getByText("Done. Open the review queue")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("log")).toContainText("client uploaded");
  await expect(page.getByRole("rowheader", { name: "Pixel Studio (synthetic)" })).toBeVisible();

  // AI first pass ran: only exceptions remain. Poll because the pipeline is asynchronous.
  const review = page.getByRole("region", { name: "Review queue (exceptions only)" });
  await expect(async () => {
    await page.reload();
    await expect(review.getByRole("button", { name: "Approve MYSTERY PAYEE 77" })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(review.getByRole("button", { name: "Approve ADOBE CREATIVE CLOUD" })).toHaveCount(0); // rules handled it
  await page.waitForLoadState("networkidle");
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await page.getByLabel("Category for MYSTERY PAYEE 77").selectOption("6200");
  await review.getByRole("button", { name: "Approve MYSTERY PAYEE 77" }).click();
  await expect(review.getByRole("button", { name: "Approve MYSTERY PAYEE 77" })).toHaveCount(0);

  await page.getByRole("link", { name: "Northside Plumbing (synthetic)" }).click();
  await expect(page.getByRole("region", { name: "Engagement letters" }).getByText("accepted", { exact: true })).toBeVisible();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export audit trail (CSV)" }).click();
  expect((await dl).suggestedFilename()).toMatch(/^audit-.*\.csv$/);
});
