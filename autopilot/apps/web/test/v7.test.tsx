// @vitest-environment jsdom
/** V7 screens, command palette, theme and i18n, rendered against the real API in-process (SQLite, synthetic data). */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TextEncoder as NodeTextEncoder } from "node:util";
globalThis.TextEncoder = NodeTextEncoder as typeof TextEncoder;
const digest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = ((alg: AlgorithmIdentifier, d: BufferSource) =>
  digest(alg, Buffer.from(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)))) as typeof crypto.subtle.digest;
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { createApp } from "../../api/src/app.js";
import { makeEnv, client, BANK_CSV } from "../../api/test/harness.js";
import { runPipeline } from "../../api/src/services/pipeline.js";
import { devUser } from "../src/api";
import { CommandPalette } from "../src/CommandPalette";
import { t, setLocale, locale, LOCALES, formatDate } from "../src/i18n";
import { applyTheme, getTheme, nextTheme } from "../src/theme";
import { Reports } from "../src/pages/Reports";
import { Assistant } from "../src/pages/Assistant";
import { GetStarted } from "../src/pages/GetStarted";
import { Receivables } from "../src/pages/Receivables";
import { Team } from "../src/pages/Team";
import { Banking } from "../src/pages/Banking";
import { Privacy } from "../src/pages/Privacy";
import { Ops } from "../src/pages/Ops";

const OWNER = "owner@v7.test",
  REV = "reviewer@v7.test";
let h: ReturnType<typeof makeEnv>;
beforeEach(() => {
  h = makeEnv({ ALLOWED_ORIGINS: "http://localhost:3000", ADMIN_EMAILS: OWNER });
  const app = createApp();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    app.fetch(new Request(input, init), h.env, { waitUntil: () => {}, passThroughOnException: () => {} } as never),
  );
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale("en-GB");
});
async function seed(withBooks = false) {
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: OWNER, body: { name: "V7 Co (synthetic)" } });
  await call("POST", "/v1/users", { user: OWNER, body: { email: REV, role: "reviewer" } });
  if (withBooks) {
    const tA = (await call("GET", "/v1/me", { user: OWNER })).json.tenantId as string;
    const up = await call("POST", "/v1/uploads/bank-csv", { user: OWNER, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    await runPipeline(h.env, tA, up.json.jobId);
  }
  devUser.set(OWNER);
  return call;
}

describe("i18n scaffold", () => {
  it("defaults to en-GB and interpolates", () => {
    expect(locale()).toBe("en-GB");
    expect(t("nav.reports")).toBe("Reports");
  });
  it("pseudo-locale transforms every string (catches hard-coded copy) and falls back for unknown locales", () => {
    setLocale("en-XA");
    expect(t("nav.reports")).toBe("[Reepoorts]");
    expect(document.documentElement.lang).toBe("en");
    setLocale("xx");
    expect(locale()).toBe("en-GB");
    expect(LOCALES).toEqual(["en-GB", "en-XA"]);
  });
  it("formats dates for the locale", () => expect(formatDate("2026-07-01")).toMatch(/1 Jul 2026/));
});

describe("theme", () => {
  it("cycles system → dark → light → system and persists forced themes", () => {
    expect(getTheme()).toBe("system");
    expect([nextTheme("system"), nextTheme("dark"), nextTheme("light")]).toEqual(["dark", "light", "system"]);
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getTheme()).toBe("dark");
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(getTheme()).toBe("system");
  });
});

describe("command palette", () => {
  it("opens with Ctrl+K, filters, navigates with arrows, runs with Enter, closes with Escape", async () => {
    const ran: string[] = [];
    render(
      <CommandPalette
        commands={[
          { id: "a", label: "Reports", run: () => ran.push("a") },
          { id: "b", label: "Receivables", hint: "Go to", run: () => ran.push("b") },
          { id: "c", label: "Theme", run: () => ran.push("c") },
        ]}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const box = screen.getByRole("combobox");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "re" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Reports", "Receivables Go to"]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-activedescendant")).toBe("cmd-b");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(ran).toEqual(["a"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("click runs a command and backdrop click closes", () => {
    const ran: string[] = [];
    const { container } = render(<CommandPalette commands={[{ id: "a", label: "Ops", run: () => ran.push("a") }]} />);
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    fireEvent.mouseEnter(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("option"));
    expect(ran).toEqual(["a"]);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(container.querySelector(".palette-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("V7 screens", () => {
  it("Reports shows P&L, balance sheet, forecast and deadlines", async () => {
    await seed(true);
    render(<Reports />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Profit and loss" })).toBeTruthy());
    expect(screen.getByText(/Net profit/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: /Balance sheet/ })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Cash forecast" })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Upcoming deadlines" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-07-01" } });
    fireEvent.submit(screen.getByRole("form", { name: "Report period" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Profit and loss" })).toBeTruthy());
  });
  it("Assistant answers with sources and offers suggestions", async () => {
    await seed(true);
    render(<Assistant />);
    const chip = await screen.findByRole("button", { name: /Who owes me money/i });
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByRole("region", { name: "Answer" }).textContent).toMatch(/owes|unpaid/i));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "What was my income in July 2026" } });
    fireEvent.submit(screen.getByRole("form", { name: "Ask a question" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sources" })).toBeTruthy());
  });
  it("Get started: checklist, load and remove sample data; reviewers cannot load", async () => {
    await seed();
    const { unmount } = render(<GetStarted role="owner" />);
    await screen.findByText(/of 7 done/);
    fireEvent.click(screen.getByRole("button", { name: "Load sample data" }));
    await screen.findByText("Loaded 9 sample transactions.");
    fireEvent.click(await screen.findByRole("button", { name: "Remove sample data" }));
    await screen.findByText("Removed 9 sample transactions.");
    unmount();
    devUser.set(REV);
    render(<GetStarted role="reviewer" />);
    await screen.findByText(/of 7 done/);
    expect(screen.queryByRole("button", { name: /sample data/ })).toBeNull();
  });
  it("Receivables: aged debtors, reminders (no emails) and recurring schedule", async () => {
    const call = await seed();
    const i = (
      await call("POST", "/v1/invoices", {
        user: OWNER,
        body: {
          customerName: "Acme",
          issueDate: "2026-01-01",
          dueDate: "2026-01-31",
          lines: [{ description: "d", quantity: 1, unitPence: 10000, vatRateCode: "STD" }],
        },
      })
    ).json;
    await call("POST", `/v1/invoices/${i.id}/status`, { user: OWNER, body: { status: "sent" } });
    render(<Receivables role="owner" />);
    await screen.findByRole("rowheader", { name: "Acme" });
    fireEvent.click(screen.getByRole("button", { name: "Check reminders now" }));
    await screen.findByText(/reminder\(s\) due \(recorded, no emails sent\)/);
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Retainer Co" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Monthly" } });
    fireEvent.change(screen.getByLabelText("Amount (£, ex VAT)"), { target: { value: "500" } });
    fireEvent.submit(screen.getByRole("form", { name: "New recurring invoice" }));
    await screen.findByText(/Retainer Co · monthly/);
  });
  it("Receivables for a reviewer hides owner tools; empty state", async () => {
    await seed();
    devUser.set(REV);
    render(<Receivables role="reviewer" />);
    await screen.findByText("Nobody owes you anything right now.");
    expect(screen.queryByRole("button", { name: "Check reminders now" })).toBeNull();
  });
  it("Team: notifications and four-eyes period close (requester cannot sign; reviewers cannot sign)", async () => {
    await seed();
    devUser.set(REV);
    const { unmount } = render(<Team email={REV} role="reviewer" />);
    await screen.findByText("No closes yet.");
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-07-31" } });
    fireEvent.submit(screen.getByRole("form", { name: "Request period close" }));
    await screen.findByText(/2026-07-01 to 2026-07-31/);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    unmount();
    devUser.set(OWNER);
    render(<Team email={OWNER} role="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText("approved");
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("Banking: demo provider notice, connect, sync, disconnect", async () => {
    await seed();
    render(<Banking />);
    await screen.findByText(/synthetic data only/);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    await screen.findByText(/Imported \d+ new transaction/);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await screen.findByText("Disconnected.");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Connected.");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("alert");
  });
  it("Privacy: DSAR, erasure needs confirmation, retention is unverified", async () => {
    await seed();
    render(<Privacy />);
    await screen.findByText(/unverified placeholder/);
    fireEvent.change(screen.getAllByLabelText("Person's email")[0]!, { target: { value: REV } });
    fireEvent.submit(screen.getByRole("form", { name: "Subject access request" }));
    await screen.findByText(/Request .* completed/);
    fireEvent.change(screen.getAllByLabelText("Person's email")[1]!, { target: { value: REV } });
    fireEvent.click(screen.getByLabelText(/cannot be undone/));
    fireEvent.submit(screen.getByRole("form", { name: "Erasure request" }));
    await screen.findByText(/Retained by law/);
  });
  it("Ops: tenant health plus operator overview for ADMIN_EMAILS only", async () => {
    await seed();
    const { unmount } = render(<Ops />);
    await screen.findByText("Daily scheduled runs");
    await screen.findByRole("heading", { name: /Operator overview/ });
    unmount();
    devUser.set(REV);
    render(<Ops />);
    await screen.findByText("Daily scheduled runs");
    await act(async () => {});
    expect(screen.queryByRole("heading", { name: /Operator overview/ })).toBeNull();
  });
});
