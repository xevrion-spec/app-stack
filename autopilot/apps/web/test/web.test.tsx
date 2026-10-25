// @vitest-environment jsdom
/** React Testing Library: components and pages rendered against the real API (in-process, SQLite, synthetic data). */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TextEncoder as NodeTextEncoder } from "node:util";
// jsdom ships its own realm Uint8Array; WebCrypto (used by the API for hashing) needs the Node one.
globalThis.TextEncoder = NodeTextEncoder as typeof TextEncoder;
const digest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = ((alg: AlgorithmIdentifier, d: BufferSource) =>
  digest(alg, Buffer.from(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)))) as typeof crypto.subtle.digest;
import { render, screen, cleanup, waitFor, renderHook, act, within, fireEvent } from "@testing-library/react";
import { createApp } from "../../api/src/app.js";
import { makeEnv, client, BANK_CSV } from "../../api/test/harness.js";
import { ErrorNote, Loading, Page, Empty, Badge, DraftBanner } from "../src/ui";
import { ApiError, unwrap, gbp, devUser, raw } from "../src/api";
import { useLoad } from "../src/hooks";
import { SignIn, Onboarding } from "../src/pages/SignIn";
import { Transactions } from "../src/pages/Transactions";
import { Invoices } from "../src/pages/Invoices";
import { Exceptions } from "../src/pages/Exceptions";
import { Vat } from "../src/pages/Vat";

const OWNER = "owner@web.test";
let h: ReturnType<typeof makeEnv>;
beforeEach(() => {
  h = makeEnv({ ALLOWED_ORIGINS: "http://localhost:3000" });
  const app = createApp();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    app.fetch(new Request(input, init), h.env, { waitUntil: () => {}, passThroughOnException: () => {} } as never),
  );
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function seedTenant() {
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: OWNER, body: { name: "Web Test Ltd" } });
  devUser.set(OWNER);
  return call;
}

describe("ui components", () => {
  it("ErrorNote renders nothing without an error", () => expect(render(<ErrorNote error={null} />).container.innerHTML).toBe(""));
  it("ErrorNote is an alert and shows the request id for ApiError", () => {
    render(<ErrorNote error={new ApiError(400, "validation_failed", "Bad thing", "req-1")} />);
    expect(screen.getByRole("alert").textContent).toContain("Bad thing");
    expect(screen.getByRole("alert").textContent).toContain("req-1");
  });
  it("ErrorNote for a plain Error has no request id", () => {
    render(<ErrorNote error={new Error("plain")} />);
    expect(screen.getByRole("alert").textContent).toBe("plain");
  });
  it.each([
    [true, 1],
    [false, 0],
  ])("Loading show=%s renders %i status", (show, n) => {
    render(<Loading show={show} />);
    expect(screen.queryAllByRole("status")).toHaveLength(n);
  });
  it("Page labels the section with its heading", () => {
    render(
      <Page title="Hello" actions={<button>Go</button>}>
        body
      </Page>,
    );
    expect(screen.getByRole("region", { name: "Hello" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();
  });
  it("Empty renders children", () => expect(render(<Empty>Nothing</Empty>).container.textContent).toBe("Nothing"));
  it.each([
    ["needs_review", "needs review", "b-needs_review"],
    [null, "—", "b-none"],
    ["a<b>", "a<b>", "b-ab"],
  ])("Badge %j", (v, text, cls) => {
    const { container } = render(<Badge value={v} />);
    expect(container.textContent).toBe(text);
    expect(container.firstElementChild!.className).toContain(cls);
  });
  it("DraftBanner says never submitted to HMRC", () => expect(render(<DraftBanner />).container.textContent).toMatch(/never submitted to HMRC/));
});

describe("api helpers", () => {
  it.each([
    [0, "£0.00"],
    [123456, "£1,234.56"],
    [-4560, "-£45.60"],
    [null, "—"],
    [undefined, "—"],
  ])("gbp(%j) = %s", (p, s) => expect(gbp(p as number | null)).toBe(s));
  it("unwrap returns data on success", () => expect(unwrap({ data: { a: 1 }, response: new Response(null, { status: 200 }) })).toEqual({ a: 1 }));
  it("unwrap throws a typed ApiError with code and request id", () => {
    try {
      unwrap({ error: { error: { code: "forbidden", message: "No", requestId: "r" } }, response: new Response(null, { status: 403 }) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toMatchObject({ status: 403, code: "forbidden", requestId: "r" });
    }
  });
  it("unwrap falls back to http_error", () =>
    expect(() => unwrap({ error: "x", response: new Response(null, { status: 502 }) })).toThrow("Request failed (502)"));
  it("devUser round-trips and clears", () => {
    devUser.set("a@b.test");
    expect(devUser.get()).toBe("a@b.test");
    devUser.set(null);
    expect(devUser.get()).toBeNull();
  });
  it("raw adds dev identity and an idempotency key on writes, and raises ApiError", async () => {
    devUser.set("nobody@web.test");
    await expect(raw("/v1/me")).rejects.toMatchObject({ status: 403 });
    await expect(raw("/v1/uploads/bank-csv", { method: "POST", body: "x" })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("useLoad", () => {
  it("loads, exposes data, and reloads", async () => {
    let n = 0;
    const { result } = renderHook(() => useLoad(async () => ++n));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(1);
    await act(() => result.current.reload());
    expect(result.current.data).toBe(2);
  });
  it("captures errors and clears them on retry", async () => {
    let fail = true;
    const { result } = renderHook(() =>
      useLoad(async () => {
        if (fail) throw new Error("boom");
        return "ok";
      }),
    );
    await waitFor(() => expect(result.current.error?.message).toBe("boom"));
    fail = false;
    await act(() => result.current.reload());
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe("ok");
  });
});

describe("pages (against the real API)", () => {
  it("SignIn stores a normalised dev identity", () => {
    const done = vi.fn();
    render(<SignIn onSignedIn={done} />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "  Mixed@Case.TEST " } });
    fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
    expect(devUser.get()).toBe("mixed@case.test");
    expect(done).toHaveBeenCalledOnce();
  });
  it("Onboarding creates a tenant and calls back", async () => {
    devUser.set("new@web.test");
    const done = vi.fn();
    render(<Onboarding onCreated={done} />);
    const name = screen.getAllByRole("textbox")[0]!;
    fireEvent.change(name, { target: { value: "Fresh Ltd" } });
    fireEvent.submit(name.closest("form")!);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect((h.raw.prepare("select name from tenants").get() as { name: string }).name).toBe("Fresh Ltd");
  });
  it("Transactions lists uploaded, categorised bank lines with GBP amounts", async () => {
    const call = await seedTenant();
    await call("POST", "/v1/uploads/bank-csv", { user: OWNER, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    const { runPipeline } = await import("../../api/src/services/pipeline.js");
    for (const m of h.sent) await runPipeline(h.env, m.tenantId, m.jobId, undefined);
    render(<Transactions />);
    await waitFor(() => expect(screen.getByText(/TRAINLINE/)).toBeTruthy());
    const row = screen.getByText(/TRAINLINE/).closest("tr")!;
    expect(within(row).getByText("-£45.60")).toBeTruthy();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
  });
  it("Transactions shows an empty state for a new tenant", async () => {
    await seedTenant();
    render(<Transactions />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByText(/TRAINLINE/)).toBeNull();
  });
  it("Invoices renders existing invoices with totals", async () => {
    const call = await seedTenant();
    await call("POST", "/v1/invoices", {
      user: OWNER,
      body: {
        customerName: "Acme Design",
        issueDate: "2026-07-01",
        dueDate: "2026-07-31",
        lines: [{ description: "Work", quantity: 2, unitPence: 5000, vatRateCode: "STD" }],
      },
    });
    render(<Invoices />);
    await waitFor(() => expect(screen.getByText("Acme Design")).toBeTruthy());
    expect(screen.getAllByText("£120.00").length).toBeGreaterThan(0);
  });
  it("Exceptions lists every open review item with a resolve action", async () => {
    const call = await seedTenant();
    await call("POST", "/v1/uploads/bank-csv", { user: OWNER, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    const { runPipeline } = await import("../../api/src/services/pipeline.js");
    for (const m of h.sent) await runPipeline(h.env, m.tenantId, m.jobId, undefined);
    const open = (await call("GET", "/v1/exceptions?status=open", { user: OWNER })).json.items.length;
    expect(open).toBeGreaterThan(0);
    render(<Exceptions role="owner" />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /resolve/i }).length).toBe(open));
  });
  it("Vat page always carries the draft banner", async () => {
    await seedTenant();
    render(<Vat />);
    expect(screen.getByRole("note").textContent).toMatch(/never submitted to HMRC/);
  });
  it("API errors surface as an accessible alert (viewer of another tenant)", async () => {
    devUser.set("stranger@web.test");
    render(<Invoices />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });
});
