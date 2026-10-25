import { sha256 } from "./crypto.js";

/** Weak ETag from a resource version (or a content hash when there is no version column). */
export const etagFor = (id: string, version: number) => `W/"${id}.${version}"`;
export async function contentEtag(body: string) {
  return `W/"${(await sha256(body)).slice(0, 27)}"`;
}

/** RFC 9110 If-None-Match evaluation (weak comparison). */
export function ifNoneMatchHits(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => strip(t) === strip(etag));
}

/** If-Match for optimistic concurrency: absent header = no precondition; "*" matches any existing resource. */
export function ifMatchFails(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return false;
  return !ifNoneMatchHits(header, etag);
}

/** Token bucket rate limiter state, persisted by the caller (KV/DO). */
export interface Bucket {
  tokens: number;
  updatedMs: number;
}
export function takeToken(
  b: Bucket | null,
  nowMs: number,
  capacity: number,
  refillPerSec: number,
): { allowed: boolean; bucket: Bucket; remaining: number; resetSeconds: number } {
  const prev = b ?? { tokens: capacity, updatedMs: nowMs };
  const elapsed = Math.max(0, nowMs - prev.updatedMs) / 1000;
  const tokens = Math.min(capacity, prev.tokens + elapsed * refillPerSec);
  const allowed = tokens >= 1;
  const left = allowed ? tokens - 1 : tokens;
  return { allowed, bucket: { tokens: left, updatedMs: nowMs }, remaining: Math.floor(left), resetSeconds: Math.ceil((capacity - left) / refillPerSec) };
}

/** Sparse fieldsets: `fields=id,amount_pence`. Unknown fields are ignored, `id` is always kept. */
export function selectFields<T extends Record<string, unknown>>(row: T, fields: string | undefined, allowed: readonly string[]): Partial<T> {
  if (!fields) return row;
  const want = new Set([
    "id",
    ...fields
      .split(",")
      .map((f) => f.trim())
      .filter((f) => allowed.includes(f)),
  ]);
  return Object.fromEntries(Object.entries(row).filter(([k]) => want.has(k))) as Partial<T>;
}

/** `sort=-amount_pence` -> safe ORDER BY from an allow-list (never interpolates user input). */
export function orderBy(sort: string | undefined, allowed: Record<string, string>, fallback: string): string {
  if (!sort) return fallback;
  const desc = sort.startsWith("-");
  const key = desc ? sort.slice(1) : sort;
  const col = Object.prototype.hasOwnProperty.call(allowed, key) ? allowed[key] : undefined;
  if (!col) return fallback;
  return `${col} ${desc ? "desc" : "asc"}, id ${desc ? "desc" : "asc"}`;
}

/** Build a safe FTS5 MATCH expression from free text: tokens are quoted, operators are stripped. */
export function ftsQuery(q: string): string | null {
  const toks =
    q
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 8) ?? [];
  if (!toks.length) return null;
  return toks.map((t) => `"${t}"*`).join(" AND ");
}
