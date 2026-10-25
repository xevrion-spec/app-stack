/**
 * IP allowlists for API keys: IPv4 and IPv6 CIDR (a bare address is a /32 or /128). Pure and allocation-light, so it
 * runs on every authenticated request. IPv4-mapped IPv6 (::ffff:a.b.c.d) is matched as IPv4.
 */
type Addr = { v: 4 | 6; n: bigint };

function parseV4(s: string): bigint | null {
  const p = s.split(".");
  if (p.length !== 4) return null;
  let n = 0n;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255 || (x.length > 1 && x.startsWith("0"))) return null;
    n = (n << 8n) | BigInt(Number(x));
  }
  return n;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(s) || s.split("::").length > 2) return null;
  let tail4: bigint | null = null;
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    tail4 = parseV4(s.slice(lastColon + 1));
    if (tail4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const [head, rest] = s.split("::") as [string, string | undefined];
  const hs = head ? head.split(":") : [];
  const ts = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups = rest === undefined ? hs : [...hs, ...Array(8 - hs.length - ts.length).fill("0"), ...ts];
  if (groups.length !== 8 || (rest !== undefined && hs.length + ts.length > 7)) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return tail4 === null ? n : (n & ~0xffffffffn) | tail4;
}

export function parseIp(s: string): Addr | null {
  const t = s.trim();
  const v4 = parseV4(t);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = t.includes(":") ? parseV6(t) : null;
  if (v6 === null) return null;
  return v6 >> 32n === 0xffffn ? { v: 4, n: v6 & 0xffffffffn } : { v: 6, n: v6 };
}

export type Cidr = { v: 4 | 6; net: bigint; bits: number };
export function parseCidr(s: string): Cidr | null {
  const [ip, len, extra] = s.trim().split("/");
  if (extra !== undefined || !ip) return null;
  const a = parseIp(ip);
  // write IPv4 ranges natively; a mapped (::ffff:) CIDR would be ambiguous about prefix length
  if (!a || (ip.includes(":") && a.v === 4)) return null;
  const max = a.v === 4 ? 32 : 128;
  if (len !== undefined && !/^\d{1,3}$/.test(len)) return null;
  const bits = len === undefined ? max : Number(len);
  if (bits > max) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { v: a.v, net: a.n & mask, bits };
}

export function ipAllowed(ip: string | null | undefined, cidrs: readonly string[]): boolean {
  if (!ip) return false;
  const a = parseIp(ip);
  if (!a) return false;
  return cidrs.some((c) => {
    const r = parseCidr(c);
    if (!r || r.v !== a.v) return false;
    const max = a.v === 4 ? 32 : 128;
    const mask = r.bits === 0 ? 0n : ((1n << BigInt(r.bits)) - 1n) << BigInt(max - r.bits);
    return (a.n & mask) === r.net;
  });
}
