/**
 * Test harness: a D1-compatible adapter over better-sqlite3 (real SQLite, real migrations), plus in-memory R2/KV/Queue fakes.
 * It implements the subset of the D1 API the app uses: prepare/bind/first/all/run/batch.
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Env, PipelineMessage } from "../src/env.js";
import { createApp } from "../src/app.js";

const MIG = join(__dirname, "../../../migrations");

class Stmt {
  constructor(private db: Database.Database, private sql: string, private params: unknown[] = []) {}
  bind(...p: unknown[]) { return new Stmt(this.db, this.sql, p.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v))); }
  private named() { return Object.fromEntries(this.params.map((v, i) => [String(i + 1), v])); }
  private prep() { return this.db.prepare(this.sql.replace(/\?(\d+)/g, "@$1")); }
  async first<T>() { const s = this.prep(); return ((s.reader ? s.get(this.named()) : (s.run(this.named()), undefined)) as T) ?? null; }
  async all<T>() { const s = this.prep(); return { results: (s.reader ? s.all(this.named()) : (s.run(this.named()), [])) as T[], success: true, meta: {} }; }
  async run() { const s = this.prep(); if (s.reader) { s.all(this.named()); return { success: true, meta: { changes: 0 } }; } const r = s.run(this.named()); return { success: true, meta: { changes: r.changes } }; }
  runSync() { const s = this.prep(); return s.reader ? s.all(this.named()) : s.run(this.named()); }
}

export function makeD1(): { d1: D1Database; raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(join(MIG, f), "utf8"));
  const d1 = {
    prepare: (sql: string) => new Stmt(raw, sql),
    batch: async (stmts: Stmt[]) => raw.transaction(() => stmts.map((s) => s.runSync()))().map(() => ({ success: true, meta: {} })),
    exec: async (sql: string) => { raw.exec(sql); return { count: 1, duration: 0 }; },
  };
  return { d1: d1 as unknown as D1Database, raw };
}

export function makeEnv(over: Partial<Env> = {}) {
  const { d1, raw } = makeD1();
  const objects = new Map<string, { body: Uint8Array; meta: unknown }>();
  const kv = new Map<string, string>();
  const sent: PipelineMessage[] = [];
  const env: Env = {
    DB: d1,
    DOCS: { put: async (k: string, v: ArrayBuffer, meta: unknown) => { objects.set(k, { body: new Uint8Array(v), meta }); return {} as R2Object; } } as unknown as R2Bucket,
    CONFIG: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) } as unknown as KVNamespace,
    PIPELINE: { send: async (m: PipelineMessage) => void sent.push(m), sendBatch: async () => {} } as unknown as Queue<PipelineMessage>,
    ENVIRONMENT: "test",
    ALLOWED_ORIGINS: "http://localhost:5173",
    ...over,
  };
  return { env, raw, objects, kv, sent };
}

export function client(env: Env) {
  const app = createApp();
  return async (method: string, path: string, opts: { user?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(opts.user ? { "x-dev-user": opts.user } : {}), ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.raw !== undefined) body = opts.raw;
    else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers["content-type"] = "application/json"; }
    const res = await app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) }, env);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}

export const BANK_CSV = `Date,Description,Amount
01/07/2026,STRIPE PAYOUT REF 8821,1200.00
03/07/2026,CARD PAYMENT TRAINLINE LONDON,-45.60
05/07/2026,STAPLES OFFICE SUPPLIES,-23.99
08/07/2026,VODAFONE UK DD,-30.00
10/07/2026,INVOICE 1043 ACME DESIGN LTD,850.00
12/07/2026,GITHUB INC,-3.20
18/07/2026,SHELL FUEL A40,-62.10
21/07/2026,MONTHLY ACCOUNT FEE,-5.00
24/07/2026,WHOLESALE SUPPLIER LTD STOCK,-400.00
28/07/2026,MYSTERY PAYEE 99,-80.00
30/07/2026,TRANSFER TO SAVINGS,-500.00
`;
