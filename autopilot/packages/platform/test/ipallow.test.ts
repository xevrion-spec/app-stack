import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ipAllowed, parseCidr, parseIp } from "../src/ipallow.js";

describe("ip allowlists", () => {
  it("matches IPv4 CIDRs and bare addresses", () => {
    expect(ipAllowed("203.0.113.7", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("203.0.114.7", ["203.0.113.0/24"])).toBe(false);
    expect(ipAllowed("198.51.100.1", ["198.51.100.1"])).toBe(true);
    expect(ipAllowed("198.51.100.2", ["198.51.100.1"])).toBe(false);
    expect(ipAllowed("10.1.2.3", ["0.0.0.0/0"])).toBe(true);
    expect(ipAllowed("10.255.255.255", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.0.0.0", ["10.0.0.0/8"])).toBe(false);
  });
  it("matches IPv6, compressed forms and IPv4-mapped clients", () => {
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("2001:0db8:0000:0000:0000:0000:0000:0001", ["2001:db8::1/128"])).toBe(true);
    expect(ipAllowed("::1", ["::1"])).toBe(true);
    expect(ipAllowed("::ffff:203.0.113.9", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("2001:db8::1", ["203.0.113.0/24"])).toBe(false);
    expect(ipAllowed("203.0.113.9", ["::/0"])).toBe(false);
  });
  it("fails closed on missing or malformed input", () => {
    expect(ipAllowed(null, ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed("", ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed("not-an-ip", ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed("1.2.3.4", [])).toBe(false);
    expect(ipAllowed("1.2.3.4", ["garbage"])).toBe(false);
    for (const bad of [
      "1.2.3.4/33",
      "1.2.3/24",
      "01.2.3.4",
      "256.1.1.1",
      "1.2.3.4/x",
      "1.2.3.4/8/8",
      "::ffff:1.2.3.4/120",
      "2001:db8::/129",
      "1::2::3",
      "1:2:3:4:5:6:7:8:9",
      "/8",
      "12345::",
    ])
      expect(parseCidr(bad), bad).toBeNull();
    expect(parseIp("1:2:3:4:5:6:7::")).not.toBeNull();
    expect(parseIp("::")).toEqual({ v: 6, n: 0n });
  });
  it("property: every address is inside its own /n for every prefix length", () => {
    fc.assert(
      fc.property(fc.ipV4(), fc.integer({ min: 0, max: 32 }), (ip, n) => {
        const c = parseCidr(`${ip}/${n}`)!;
        expect(ipAllowed(ip, [`${ip}/${n}`])).toBe(true);
        expect(c.bits).toBe(n);
      }),
      { numRuns: 2000 },
    );
    fc.assert(
      fc.property(fc.ipV6(), fc.integer({ min: 0, max: 128 }), (ip, n) => {
        const a = parseIp(ip)!;
        if (a.v === 6) expect(ipAllowed(ip, [`${ip}/${n}`])).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
