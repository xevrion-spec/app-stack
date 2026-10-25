import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function signUp(page: import("@playwright/test").Page, tag: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(`e2e.${tag}.${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Trading name").fill(`${tag} Co (synthetic)`);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

test("command palette navigates by keyboard and is accessible", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard shortcut is a desktop affordance");
  await signUp(page, "palette");
  await page.keyboard.press("Control+k");
  const box = page.getByRole("dialog").getByRole("combobox");
  await expect(box).toBeFocused();
  const res = await new AxeBuilder({ page }).include(".palette").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await box.fill("reports");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/reports$/);
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
});

test("theme toggle cycles and persists", async ({ page }) => {
  await signUp(page, "theme");
  const toggle = page.getByRole("button", { name: /^Theme:/ });
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("get started → sample data → ask your books with sources", async ({ page }) => {
  await signUp(page, "ask");
  await page.goto("/#/start");
  await page.getByRole("button", { name: "Load sample data" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Loaded 9 sample transactions." })).toBeVisible();
  await page.goto("/#/assistant");
  await page.getByRole("textbox", { name: "Question" }).fill("What subscriptions am I paying for");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByRole("region", { name: "Answer" })).toContainText(/recurring|subscription/i);
});

test("bank feed demo: connect and sync synthetic transactions", async ({ page }) => {
  await signUp(page, "feed");
  await page.goto("/#/banking");
  await expect(page.getByText(/synthetic data only/)).toBeVisible();
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText(/Imported \d+ new transaction/)).toBeVisible();
});
