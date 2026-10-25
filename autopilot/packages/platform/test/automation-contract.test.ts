/**
 * Contract tests for the automation DSL: exact schema boundaries, operator semantics at the edges, planner skip reasons,
 * and template output. Written against Stryker survivors so each assertion pins a real behaviour.
 */
import { describe, it, expect } from "vitest";
import {
  parseAutomation,
  evaluateCondition,
  planAutomation,
  getPath,
  TEMPLATES,
  LOOP_LIMIT,
  AutomationDefinitionSchema,
  type AutomationDefinition,
} from "../src/automation.js";
import type { EventEnvelope } from "../src/events.js";

const base = { name: "n", trigger: { event: "transaction.created" }, actions: [{ type: "tag_transaction", tag: "x" }] };
const withCond = (c: unknown) => ({ ...base, conditions: [c] });
const withAction = (a: unknown, event = "transaction.created") => ({ ...base, trigger: { event }, actions: [a] });
const ok = (x: unknown) => parseAutomation(x).ok;

describe("schema: paths", () => {
  it.each([
    ["data", true],
    ["data.amountPence", true],
    ["a_1.b2.c_3", true],
    ["A", true],
    ["", false],
    ["1data", false],
    ["data.", false],
    [".data", false],
    ["data..x", false],
    ["data.1x", false],
    ["data-x", false],
    ["data x", false],
    ["da$ta", false],
    ["data.a-b", false],
  ])("path %j valid=%s", (path, valid) => expect(ok(withCond({ op: "exists", path }))).toBe(valid));
  it("path max length", () => {
    expect(ok(withCond({ op: "exists", path: "a".repeat(80) }))).toBe(true);
    expect(ok(withCond({ op: "exists", path: "a".repeat(81) }))).toBe(false);
  });
});

describe("schema: every operator", () => {
  it.each([
    [{ op: "eq", path: "p", value: "s" }, true],
    [{ op: "eq", path: "p", value: 1 }, true],
    [{ op: "eq", path: "p", value: true }, true],
    [{ op: "eq", path: "p", value: null }, true],
    [{ op: "eq", path: "p" }, false],
    [{ op: "neq", path: "p", value: "s" }, true],
    [{ op: "neq", path: "p" }, false],
    [{ op: "neq", value: 1 }, false],
    [{ op: "gt", path: "p", value: 1 }, true],
    [{ op: "gt", path: "p", value: "1" }, false],
    [{ op: "gt", path: "p" }, false],
    [{ op: "gte", path: "p", value: 1 }, true],
    [{ op: "gte", path: "p", value: "1" }, false],
    [{ op: "gte", value: 1 }, false],
    [{ op: "lt", path: "p", value: 1 }, true],
    [{ op: "lt", path: "p", value: "1" }, false],
    [{ op: "lt", path: "p" }, false],
    [{ op: "lte", path: "p", value: 1 }, true],
    [{ op: "lte", path: "p", value: "1" }, false],
    [{ op: "lte", value: 1 }, false],
    [{ op: "contains", path: "p", value: "a" }, true],
    [{ op: "contains", path: "p", value: "" }, false],
    [{ op: "contains", path: "p", value: "a".repeat(120) }, true],
    [{ op: "contains", path: "p", value: "a".repeat(121) }, false],
    [{ op: "contains", path: "p", value: 1 }, false],
    [{ op: "contains", value: "a" }, false],
    [{ op: "in", path: "p", value: [1] }, true],
    [{ op: "in", path: "p", value: [] }, false],
    [{ op: "in", path: "p", value: Array(50).fill(1) }, true],
    [{ op: "in", path: "p", value: Array(51).fill(1) }, false],
    [{ op: "in", value: [1] }, false],
    [{ op: "exists", path: "p" }, true],
    [{ op: "exists" }, false],
    [{ op: "matches", path: "p", value: ".*" }, false],
    [{ op: "", path: "p" }, false],
    [{}, false],
  ])("%j valid=%s", (c, valid) => expect(ok(withCond(c))).toBe(valid));
});

describe("schema: every action", () => {
  it.each([
    [{ type: "categorise_transaction", categoryCode: "6200" }, true],
    [{ type: "categorise_transaction", categoryCode: "620" }, false],
    [{ type: "categorise_transaction", categoryCode: "62000" }, false],
    [{ type: "categorise_transaction", categoryCode: "x6200" }, false],
    [{ type: "categorise_transaction", categoryCode: "6200x" }, false],
    [{ type: "categorise_transaction", categoryCode: "abcd" }, false],
    [{ type: "categorise_transaction" }, false],
    ...(["STD", "RED", "ZERO", "EXEMPT", "OUTSIDE"].map((v) => [{ type: "categorise_transaction", categoryCode: "6200", vatRateCode: v }, true]) as [
      unknown,
      boolean,
    ][]),
    [{ type: "categorise_transaction", categoryCode: "6200", vatRateCode: "" }, false],
    [{ type: "categorise_transaction", categoryCode: "6200", vatRateCode: "std" }, false],
    [{ type: "categorise_transaction", categoryCode: "6200", vatRateCode: null }, true],
    [{ type: "tag_transaction", tag: "a" }, true],
    [{ type: "tag_transaction", tag: "a-1" }, true],
    [{ type: "tag_transaction", tag: "a".repeat(30) }, true],
    [{ type: "tag_transaction", tag: "a".repeat(31) }, false],
    [{ type: "tag_transaction", tag: "" }, false],
    [{ type: "tag_transaction", tag: "A" }, false],
    [{ type: "tag_transaction", tag: "a b" }, false],
    [{ type: "tag_transaction" }, false],
  ])("transaction action %j valid=%s", (a, valid) => expect(ok(withAction(a))).toBe(valid));
  it.each([
    [{ type: "open_exception", reasonCode: "ABC", severity: "low", message: "m" }, true],
    [{ type: "open_exception", reasonCode: "A_B_C", severity: "medium", message: "m" }, true],
    [{ type: "open_exception", reasonCode: "ABC", severity: "high", message: "m" }, true],
    [{ type: "open_exception", reasonCode: "AB", severity: "low", message: "m" }, false],
    [{ type: "open_exception", reasonCode: "A".repeat(40), severity: "low", message: "m" }, true],
    [{ type: "open_exception", reasonCode: "A".repeat(41), severity: "low", message: "m" }, false],
    [{ type: "open_exception", reasonCode: "abc", severity: "low", message: "m" }, false],
    [{ type: "open_exception", reasonCode: "xABC", severity: "low", message: "m" }, false],
    [{ type: "open_exception", reasonCode: "ABCx", severity: "low", message: "m" }, false],
    [{ type: "open_exception", reasonCode: "ABC", severity: "", message: "m" }, false],
    [{ type: "open_exception", reasonCode: "ABC", severity: "critical", message: "m" }, false],
    [{ type: "open_exception", reasonCode: "ABC", severity: "low", message: "" }, false],
    [{ type: "open_exception", reasonCode: "ABC", severity: "low", message: "m".repeat(300) }, true],
    [{ type: "open_exception", reasonCode: "ABC", severity: "low", message: "m".repeat(301) }, false],
    [{ type: "emit_notification", channel: "event", message: "m" }, true],
    [{ type: "emit_notification", channel: "email", message: "m" }, false],
    [{ type: "emit_notification", channel: "event", message: "" }, false],
    [{ type: "emit_notification", channel: "event", message: "m".repeat(301) }, false],
    [{ type: "emit_notification", message: "m" }, false],
    [{ type: "send_email", to: "a@b.c" }, false],
  ])("event-only action %j valid=%s", (a, valid) => expect(ok(withAction(a, "exception.opened"))).toBe(valid));
});

describe("schema: definition limits and defaults", () => {
  it.each([
    ["", false],
    ["n", true],
    ["n".repeat(80), true],
    ["n".repeat(81), false],
  ])("name %j valid=%s", (name, v) => expect(ok({ ...base, name })).toBe(v));
  it("unknown trigger rejected", () => expect(ok({ ...base, trigger: { event: "transaction.deleted" } })).toBe(false));
  it("conditions: 20 ok, 21 rejected", () => {
    expect(ok({ ...base, conditions: Array(20).fill({ op: "exists", path: "p" }) })).toBe(true);
    expect(ok({ ...base, conditions: Array(21).fill({ op: "exists", path: "p" }) })).toBe(false);
  });
  it("actions: 0 rejected, 10 ok, 11 rejected", () => {
    const a = { type: "tag_transaction", tag: "x" };
    expect(ok({ ...base, actions: [] })).toBe(false);
    expect(ok({ ...base, actions: Array(10).fill(a) })).toBe(true);
    expect(ok({ ...base, actions: Array(11).fill(a) })).toBe(false);
  });
  it.each([
    [0, false],
    [1, true],
    [10_000, true],
    [10_001, false],
    [1.5, false],
  ])("maxRunsPerHour %s valid=%s", (m, v) => expect(ok({ ...base, maxRunsPerHour: m })).toBe(v));
  it("defaults: empty conditions, enabled, 500/hour", () => {
    const r = parseAutomation(base);
    expect(r.ok && r.value).toMatchObject({ conditions: [], enabled: true, maxRunsPerHour: 500 });
  });
  it("vatRateCode defaults to null", () => {
    const r = parseAutomation(withAction({ type: "categorise_transaction", categoryCode: "6200" }));
    expect(r.ok && r.value.actions[0]).toEqual({ type: "categorise_transaction", categoryCode: "6200", vatRateCode: null });
  });
});

describe("parseAutomation: messages and semantic rules", () => {
  it("errors name the path, and (root) for top-level problems", () => {
    const r = parseAutomation({ ...base, name: "" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/^name: /);
    const r2 = parseAutomation("nope");
    expect(!r2.ok && r2.errors[0]).toMatch(/^\(root\): /);
    const r3 = parseAutomation({ ...base, conditions: [{ op: "gt", path: "p", value: "x" }] });
    expect(!r3.ok && r3.errors[0]).toMatch(/^conditions\.0\.value: /);
  });
  it.each(["categorise_transaction", "tag_transaction"])("%s requires a transaction.* trigger with a precise message", (type) => {
    const a = type === "tag_transaction" ? { type, tag: "x" } : { type, categoryCode: "6200" };
    const r = parseAutomation(withAction(a, "invoice.paid"));
    expect(r).toEqual({ ok: false, errors: [`actions: ${type} requires a transaction.* trigger`] });
    expect(parseAutomation(withAction(a, "transaction.created")).ok).toBe(true);
  });
  it("only the offending actions are reported", () => {
    const r = parseAutomation({
      ...base,
      trigger: { event: "invoice.paid" },
      actions: [
        { type: "emit_notification", channel: "event", message: "m" },
        { type: "tag_transaction", tag: "x" },
      ],
    });
    expect(!r.ok && r.errors).toEqual(["actions: tag_transaction requires a transaction.* trigger"]);
  });
  it("an event-only action on a non-transaction trigger is fine", () =>
    expect(ok(withAction({ type: "emit_notification", channel: "event", message: "m" }, "invoice.paid"))).toBe(true));
  it("a trigger that merely contains 'transaction.' elsewhere is not a transaction trigger", () =>
    expect(ok(withAction({ type: "tag_transaction", tag: "x" }, "trigger.received"))).toBe(false));
  it("re-categorising on transaction.categorised requires a condition (loop guard)", () => {
    const cat = { type: "categorise_transaction", categoryCode: "6200" };
    expect(parseAutomation(withAction(cat, "transaction.categorised"))).toEqual({
      ok: false,
      errors: ["conditions: re-categorising on transaction.categorised needs at least one condition"],
    });
    expect(ok({ ...withAction(cat, "transaction.categorised"), conditions: [{ op: "neq", path: "data.categoryCode", value: "6200" }] })).toBe(true);
    expect(ok(withAction({ type: "tag_transaction", tag: "x" }, "transaction.categorised"))).toBe(true);
    expect(ok(withAction(cat, "transaction.created"))).toBe(true);
    expect(ok({ ...base, trigger: { event: "transaction.categorised" }, actions: [{ type: "tag_transaction", tag: "x" }, cat] })).toBe(false);
  });
});

describe("evaluateCondition at the edges", () => {
  const ctx = { data: { n: 5, s: "Hello World", z: 0, nul: null, f: false, str5: "5" } };
  it.each([
    [{ op: "eq", path: "data.n", value: 5 }, true],
    [{ op: "eq", path: "data.str5", value: 5 }, false],
    [{ op: "eq", path: "data.missing", value: null }, false],
    [{ op: "eq", path: "data.nul", value: null }, true],
    [{ op: "neq", path: "data.n", value: 5 }, false],
    [{ op: "neq", path: "data.n", value: 6 }, true],
    [{ op: "neq", path: "data.str5", value: 5 }, true],
    [{ op: "gt", path: "data.n", value: 4 }, true],
    [{ op: "gt", path: "data.n", value: 5 }, false],
    [{ op: "gt", path: "data.str5", value: 4 }, false],
    [{ op: "gte", path: "data.n", value: 5 }, true],
    [{ op: "gte", path: "data.n", value: 6 }, false],
    [{ op: "gte", path: "data.str5", value: 0 }, false],
    [{ op: "gte", path: "data.missing", value: -1 }, false],
    [{ op: "lt", path: "data.n", value: 6 }, true],
    [{ op: "lt", path: "data.n", value: 5 }, false],
    [{ op: "lt", path: "data.str5", value: 9 }, false],
    [{ op: "lte", path: "data.n", value: 5 }, true],
    [{ op: "lte", path: "data.n", value: 4 }, false],
    [{ op: "lte", path: "data.str5", value: 9 }, false],
    [{ op: "lte", path: "data.missing", value: 9 }, false],
    [{ op: "contains", path: "data.s", value: "world" }, true],
    [{ op: "contains", path: "data.s", value: "WORLDS" }, false],
    [{ op: "contains", path: "data.n", value: "5" }, false],
    [{ op: "in", path: "data.n", value: [1, 5] }, true],
    [{ op: "in", path: "data.n", value: ["5"] }, false],
    [{ op: "exists", path: "data.z" }, true],
    [{ op: "exists", path: "data.f" }, true],
    [{ op: "exists", path: "data.nul" }, false],
    [{ op: "exists", path: "data.missing" }, false],
  ] as [Parameters<typeof evaluateCondition>[0], boolean][])("%j -> %s", (c, want) => expect(evaluateCondition(c, ctx)).toBe(want));
  it("getPath only follows own properties", () => {
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getPath({ a: {} }, "a.toString")).toBeUndefined();
    expect(getPath({ a: null }, "a.b")).toBeUndefined();
    expect(getPath({ a: "str" }, "a.length")).toBeUndefined();
  });
});

describe("planAutomation decisions", () => {
  const def = (over: Partial<AutomationDefinition> = {}) => AutomationDefinitionSchema.parse({ ...base, ...over }) as AutomationDefinition;
  const ev = (over: Partial<EventEnvelope> = {}): EventEnvelope =>
    ({
      id: "e1",
      type: "transaction.created",
      version: 1,
      tenantId: "t",
      occurredAt: "2026-01-01T00:00:00Z",
      actor: "user:u",
      causationChain: [],
      data: { amountPence: -100 },
      ...over,
    }) as EventEnvelope;
  const a = (d = def()) => ({ id: "A", def: d });
  it("disabled -> not matched, no actions", () =>
    expect(planAutomation(a(def({ enabled: false })), ev(), 0)).toEqual({
      automationId: "A",
      eventId: "e1",
      actions: [],
      matched: false,
      skipped: "disabled",
    }));
  it("trigger mismatch", () =>
    expect(planAutomation(a(), ev({ type: "invoice.paid" }), 0)).toMatchObject({ matched: false, skipped: "trigger_mismatch", actions: [] }));
  it.each([
    [[], "user:u", undefined],
    [["automation:A:e0"], "user:u", undefined],
    [["automation:A:e0", "automation:A:e1"], "user:u", undefined],
    [["automation:A:e0", "automation:A:e1", "automation:A:e2"], "user:u", "loop_detected"],
    [["automation:A:e0", "automation:A:e1"], "automation:A", "loop_detected"],
    [["automation:B:e0", "automation:B:e1", "automation:B:e2"], "user:u", undefined],
    [["xautomation:A:e0", "xautomation:A:e1", "xautomation:A:e2"], "user:u", undefined],
    [Array.from({ length: 9 }, (_, i) => `user:${i}`), "user:u", undefined],
    [Array.from({ length: 10 }, (_, i) => `user:${i}`), "user:u", "loop_detected"],
  ])("causation %j actor %s -> %s", (chain, actor, skipped) => {
    const p = planAutomation(a(), ev({ causationChain: chain, actor }), 0);
    expect(p.skipped).toBe(skipped);
    expect(p.matched).toBe(skipped === undefined);
  });
  it("LOOP_LIMIT is 3", () => expect(LOOP_LIMIT).toBe(3));
  it("conditions see event type/actor and data, and report the first failing index", () => {
    const d = def({
      conditions: [
        { op: "eq", path: "event.type", value: "transaction.created" },
        { op: "eq", path: "event.actor", value: "user:u" },
        { op: "gt", path: "data.amountPence", value: 0 },
      ],
    });
    expect(planAutomation(a(d), ev(), 0)).toMatchObject({ matched: false, skipped: "conditions_false", failedCondition: 2, actions: [] });
  });
  it("rate cap: below cap runs, at cap is matched but skipped", () => {
    const d = def({ maxRunsPerHour: 2 });
    expect(planAutomation(a(d), ev(), 1).actions).toHaveLength(1);
    expect(planAutomation(a(d), ev(), 2)).toMatchObject({ matched: true, skipped: "rate_capped", actions: [] });
  });
  it("actions get stable per-index idempotency keys", () => {
    const d = def({
      actions: [
        { type: "tag_transaction", tag: "a" },
        { type: "tag_transaction", tag: "b" },
      ],
    });
    const p = planAutomation(a(d), ev(), 0);
    expect(p.matched).toBe(true);
    expect("skipped" in p).toBe(false);
    expect(p.actions).toEqual([
      { index: 0, idempotencyKey: "A:e1:0", action: { type: "tag_transaction", tag: "a" } },
      { index: 1, idempotencyKey: "A:e1:1", action: { type: "tag_transaction", tag: "b" } },
    ]);
  });
});

describe("templates", () => {
  const t = (id: string) => TEMPLATES.find((x) => x.id === id)!;
  it("ids and titles are stable (used by the UI and docs)", () =>
    expect(TEMPLATES.map((x) => [x.id, x.title])).toEqual([
      ["auto-categorise-merchant", "Auto-categorise a merchant"],
      ["notify-exception-opened", "Notify (event only) when a high-severity exception opens"],
      ["flag-large-outflow", "Flag outflows above a threshold for review"],
    ]));
  it("auto-categorise builds a valid contains rule; vatRateCode defaults to null but is kept when given", () => {
    expect(t("auto-categorise-merchant").build({ merchant: "ADOBE", categoryCode: "6200" })).toEqual({
      name: "Categorise ADOBE as 6200",
      trigger: { event: "transaction.created" },
      conditions: [{ op: "contains", path: "data.description", value: "ADOBE" }],
      actions: [{ type: "categorise_transaction", categoryCode: "6200", vatRateCode: null }],
    });
    expect(
      (t("auto-categorise-merchant").build({ merchant: "X", categoryCode: "6200", vatRateCode: "STD" }) as { actions: { vatRateCode: string }[] }).actions[0]!
        .vatRateCode,
    ).toBe("STD");
  });
  it("notify template only targets high severity and is event-only", () => {
    const b = t("notify-exception-opened").build({});
    expect(b).toEqual({
      name: "Notify on high-severity exception",
      trigger: { event: "exception.opened" },
      conditions: [{ op: "eq", path: "data.severity", value: "high" }],
      actions: [{ type: "emit_notification", channel: "event", message: "A high-severity exception needs review" }],
    });
    expect(ok(b)).toBe(true);
  });
  it("large-outflow converts pounds to negative pence", () => {
    const b = t("flag-large-outflow").build({ pounds: "250.50" }) as { name: string; conditions: unknown[]; actions: unknown[] };
    expect(b.name).toBe("Flag outflows over 250.50");
    expect(b.conditions).toEqual([{ op: "lt", path: "data.amountPence", value: -25050 }]);
    expect(b.actions).toEqual([{ type: "open_exception", reasonCode: "LARGE_OUTFLOW", severity: "medium", message: "Outflow above £250.50" }]);
    expect(ok(b)).toBe(true);
  });
});
