import { describe, it, expect } from "vitest";
import { LangfuseTracer, MemoryTracer, noopPipelineTracer, tracerFromEnv, openAiCompatible, categoriseLines, reconcile } from "../src/index.js";

describe("tracing", () => {
  it("tracerFromEnv is a no-op unless all Langfuse vars are set", () => {
    expect(tracerFromEnv({})).toBe(noopPipelineTracer);
    expect(tracerFromEnv({ LANGFUSE_HOST: "h", LANGFUSE_PUBLIC_KEY: "p" })).toBe(noopPipelineTracer);
    expect(tracerFromEnv({ LANGFUSE_HOST: "h", LANGFUSE_PUBLIC_KEY: "p", LANGFUSE_SECRET_KEY: "s" })).toBeInstanceOf(LangfuseTracer);
  });
  it("records spans, errors and scores", async () => {
    const t = new MemoryTracer();
    const tr = t.trace("x", { a: 1 });
    expect(
      await tr.span(
        "ok",
        {},
        async () => 42,
        (n) => ({ n }),
      ),
    ).toBe(42);
    await expect(tr.span("boom", {}, async () => Promise.reject(new Error("bad")))).rejects.toThrow("bad");
    tr.end({ done: true }, [{ name: "qa", value: 0.9 }]);
    expect(t.events.map((e) => e.type)).toEqual(["trace-create", "span-create", "span-update", "span-create", "span-update", "trace-create", "score-create"]);
    expect(t.events[4]!.body.level).toBe("ERROR");
  });
  it("Langfuse flush posts one ingestion batch with basic auth, and never throws", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("{}", { status: 207 }))) as unknown as typeof fetch;
    const t = new LangfuseTracer("http://lf.local/", "pk", "sk", ok);
    t.trace("job").end({});
    await t.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://lf.local/api/public/ingestion");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("pk:sk")}`);
    expect(JSON.parse(String(calls[0]!.init.body)).batch.length).toBe(2);
    await t.flush(); // empty: no call
    expect(calls).toHaveLength(1);
    const failing = new LangfuseTracer("http://lf.local", "pk", "sk", (async () => Promise.reject(new Error("down"))) as unknown as typeof fetch);
    failing.trace("x");
    await expect(failing.flush()).resolves.toBeUndefined();
  });
});

describe("LLM client and validation", () => {
  const lines = [{ id: "a", date: "2026-07-01", description: "ZXQ UNKNOWN VENDOR", amountPence: -1000 }];
  it("uses the LLM for unknown lines and accepts only allowed codes", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '[{"i":0,"code":"6200","confidence":0.97}]' } }] }))) as unknown as typeof fetch;
    const r = await categoriseLines(lines, [], new Set(["6200", "9999"]), openAiCompatible("http://llm", "k", "m", fake));
    expect(r.items[0]).toMatchObject({ categoryCode: "6200", method: "llm" });
  });
  it("rejects invented codes and malformed output into suspense + review", async () => {
    const invented = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '[{"i":0,"code":"7777","confidence":0.99}]' } }] }))) as unknown as typeof fetch;
    const r1 = await categoriseLines(lines, [], new Set(["6200", "9999"]), openAiCompatible("http://llm", "k", "m", invented));
    expect(r1.items[0]!.categoryCode).toBe("9999");
    const junk = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "sure! here you go" } }] }))) as unknown as typeof fetch;
    const r2 = await categoriseLines(lines, [], new Set(["6200", "9999"]), openAiCompatible("http://llm", "k", "m", junk));
    expect(r2.exceptions.map((e) => e.reasonCode)).toContain("LLM_INVALID_OUTPUT");
    const http500 = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const r3 = await categoriseLines(lines, [], new Set(["6200", "9999"]), openAiCompatible("http://llm", "k", "m", http500));
    expect(r3.items[0]!.categoryCode).toBe("9999");
  });
});

describe("split payments", () => {
  it("matches one card payment to two receipts that sum to it", () => {
    const m = reconcile(
      [{ id: "l", date: "2026-07-10", description: "AMAZON MARKETPLACE", amountPence: -3500 }],
      [
        { id: "r1", date: "2026-07-09", merchant: "Amazon", totalPence: 2000, vatPence: 333 },
        { id: "r2", date: "2026-07-09", merchant: "Amazon", totalPence: 1500, vatPence: 250 },
        { id: "r3", date: "2026-07-09", merchant: "Amazon", totalPence: 999, vatPence: 0 },
      ],
      [],
    );
    expect(m.map((x) => x.refId).sort()).toEqual(["r1", "r2"]);
    expect(m.every((x) => x.split)).toBe(true);
  });
});
