/** Webhook contract: SSRF edge tables, signature parsing, disable policy (targeted at Stryker survivors). */
import { describe, it, expect } from "vitest";
import {
  validateWebhookUrl,
  isPrivateAddress,
  parseIpv4,
  verifySignature,
  signPayload,
  shouldDisable,
  backoffSeconds,
  SIGNATURE_HEADER,
} from "../src/webhooks.js";

describe("validateWebhookUrl reasons", () => {
  it.each([
    ["not a url", "not a valid URL"],
    ["https://example.com/" + "a".repeat(2030), "URL too long"],
    ["http://example.com/x", "https is required"],
    ["ftp://example.com/x", "https is required"],
    ["https://u:p@example.com/", "credentials in URL are not allowed"],
    ["https://u@example.com/", "credentials in URL are not allowed"],
    ["https://:p@example.com/", "credentials in URL are not allowed"],
    ["https://example.com:8080/", "port not allowed"],
    ["https://intranet/", "internal host names are not allowed"],
    ["https://localhost/", "internal host names are not allowed"],
    ["https://db.internal/", "internal host names are not allowed"],
    ["https://10.0.0.1/", "private or reserved address"],
    ["https://[::1]/", "private or reserved address"],
  ])("%s -> %s", (u, reason) => expect(validateWebhookUrl(u)).toEqual({ ok: false, reason }));
  it.each(["https://example.com/", "https://example.com:443/", "https://example.com:8443/h", "https://Hooks.Example.COM/x"])("%s ok", (u) =>
    expect(validateWebhookUrl(u).ok).toBe(true),
  );
  it("exactly 2048 chars is allowed", () => {
    const u = "https://example.com/" + "a".repeat(2048 - 20);
    expect(u.length).toBe(2048);
    expect(validateWebhookUrl(u).ok).toBe(true);
  });
  it("dev http hosts: only listed hosts, only http, any port", () => {
    expect(validateWebhookUrl("http://127.0.0.1:4242/x", { allowHttpHosts: ["127.0.0.1"] }).ok).toBe(true);
    expect(validateWebhookUrl("http://127.0.0.2:4242/x", { allowHttpHosts: ["127.0.0.1"] })).toEqual({ ok: false, reason: "https is required" });
    expect(validateWebhookUrl("http://127.0.0.1/x")).toEqual({ ok: false, reason: "https is required" });
    expect(validateWebhookUrl("https://[::1]:4242/", { allowHttpHosts: ["::1"] })).toEqual({ ok: false, reason: "port not allowed" });
  });
});

describe("isPrivateAddress boundaries", () => {
  it.each([
    ["0.1.2.3", true],
    ["10.255.0.1", true],
    ["127.0.0.1", true],
    ["11.0.0.1", false],
    ["100.63.255.255", false],
    ["100.64.0.0", true],
    ["100.127.255.255", true],
    ["100.128.0.0", false],
    ["101.64.0.1", false],
    ["169.254.169.254", true],
    ["169.253.0.1", false],
    ["168.254.0.1", false],
    ["172.15.0.1", false],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["173.16.0.1", false],
    ["192.168.1.1", true],
    ["192.169.0.1", false],
    ["193.168.0.1", false],
    ["192.0.0.1", true],
    ["192.1.0.1", false],
    ["193.0.0.1", false],
    ["198.18.0.1", true],
    ["198.19.255.1", true],
    ["198.17.0.1", false],
    ["198.20.0.1", false],
    ["199.18.0.1", false],
    ["8.8.8.8", false],
    ["example.com", false],
    ["::", true],
    ["::1", true],
    ["::2", false],
    ["2001:db8::1", false],
    ["fc00::1", true],
    ["fd12::1", true],
    ["fe80::1", true],
    ["febf::1", true],
    ["fec0::1", false],
    ["ff02::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:8.8.8.8", false],
    ["2001::ffff:10.0.0.1", false],
    ["1::fc00", false],
  ])("%s -> %s", (h, want) => expect(isPrivateAddress(h)).toBe(want));
});

describe("parseIpv4 encodings", () => {
  it.each([
    ["127.0.0.1", [127, 0, 0, 1]],
    ["2130706433", [127, 0, 0, 1]],
    ["0x7f000001", [127, 0, 0, 1]],
    ["0x7f.1", [127, 0, 0, 1]],
    ["0177.0.0.1", [127, 0, 0, 1]],
    ["127.1", [127, 0, 0, 1]],
    ["10.1.1", [10, 1, 0, 1]],
    ["1.2.3.4.5", null],
    ["1..2", null],
    [".1.2.3", null],
    ["a.b", null],
    ["1.2.3.256", null],
    ["256.1.1.1", null],
    ["1.16777216", null],
    ["1.16777215", [1, 255, 255, 255]],
    ["4294967295", [255, 255, 255, 255]],
    ["4294967296", null],
    ["08.1.1.1", [8, 1, 1, 1]],
    ["x1.2.3.4", null],
    ["1.2.3.4x", null],
    ["example.com", null],
    ["0xg", null],
  ])("%s -> %j", (h, want) => expect(parseIpv4(h)).toEqual(want));
});

describe("verifySignature parsing", () => {
  const now = 1_700_000_000;
  it("header name is fixed", () => expect(SIGNATURE_HEADER).toBe("autopilot-signature"));
  it("accepts spaces around parts and any one of several v1 values", async () => {
    const good = (await signPayload("s", "b", now)).split(",")[1]!;
    expect(await verifySignature(["s"], ` t=${now} , v1=deadbeef , ${good} `, "b", now)).toEqual({ ok: true });
  });
  it("requires every candidate to be checked, not all to match", async () => {
    const good = (await signPayload("s", "b", now)).split(",")[1]!;
    expect(await verifySignature(["s"], `t=${now},v1=00,${good}`, "b", now)).toEqual({ ok: true });
  });
  it.each([
    ["v1=abc", "malformed"],
    [`t=${now}`, "malformed"],
    [`t=x,v1=abc`, "malformed"],
    [`t=${now},v1=`, "malformed"],
    [`x=${now},v1=abc`, "malformed"],
  ])("%s -> %s", async (h, reason) => expect(await verifySignature(["s"], h, "b", now)).toEqual({ ok: false, reason }));
  it("tolerance boundary is inclusive", async () => {
    const sig = await signPayload("s", "b", now - 300);
    expect(await verifySignature(["s"], sig, "b", now)).toEqual({ ok: true });
    expect(await verifySignature(["s"], await signPayload("s", "b", now - 301), "b", now)).toEqual({ ok: false, reason: "stale" });
  });
});

describe("shouldDisable and backoff", () => {
  const t0 = "2026-01-01T00:00:00Z";
  const at = (h: number) => new Date(Date.parse(t0) + h * 3600_000).toISOString();
  it.each([
    [20, null, 0, true],
    [19, t0, 1, false],
    [0, t0, 100, false],
    [5, null, 100, false],
    [3, t0, 72, true],
    [2, t0, 72, false],
    [3, t0, 71.99, false],
    [10, t0, 100, true],
  ])("failures=%i first=%s after %ih -> %s", (n, first, h, want) => expect(shouldDisable(n, first, at(h))).toBe(want));
  it.each([[0], [-1], [1.5]])("attempt %s is rejected", (a) => expect(() => backoffSeconds(a)).toThrow("attempt must be a positive integer"));
});
