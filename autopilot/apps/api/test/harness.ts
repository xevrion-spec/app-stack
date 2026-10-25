/**
 * Test harness: a D1-compatible adapter over better-sqlite3 (real SQLite, real migrations), plus in-memory R2/KV/Queue fakes.
 * It implements the subset of the D1 API the app uses: prepare/bind/first/all/run/batch.
 */
import type { Env, PipelineMessage, EventsMessage, QueueMessage } from "../src/env.js";
import { createApp } from "../src/app.js";
import { makeSqliteD1 } from "../dev/sqlite-d1.js";

const makeD1 = () => makeSqliteD1();

export function makeEnv(over: Partial<Env> = {}) {
  const { d1, raw } = makeD1();
  const objects = new Map<string, { body: Uint8Array; meta: unknown }>();
  const kv = new Map<string, string>();
  const sent: PipelineMessage[] = [];
  const events: EventsMessage[] = [];
  const env: Env = {
    DB: d1,
    DOCS: {
      put: async (k: string, v: ArrayBuffer, meta: unknown) => {
        objects.set(k, { body: new Uint8Array(v), meta });
        return {} as R2Object;
      },
      get: async (k: string) => {
        const o = objects.get(k);
        return o
          ? ({ arrayBuffer: async () => o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength) } as unknown as R2ObjectBody)
          : null;
      },
      delete: async (k: string) => void objects.delete(k),
    } as unknown as R2Bucket,
    CONFIG: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) } as unknown as KVNamespace,
    PIPELINE: {
      send: async (m: QueueMessage) => void (m.kind === "events" ? events.push(m) : sent.push(m)),
      sendBatch: async () => {},
    } as unknown as Queue<QueueMessage>,
    ENVIRONMENT: "test",
    ALLOWED_ORIGINS: "http://localhost:5173",
    ...over,
  };
  return { env, raw, objects, kv, sent, events };
}

export function client(env: Env) {
  const app = createApp();
  return async (method: string, path: string, opts: { user?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(opts.user ? { "x-dev-user": opts.user } : {}), ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.raw !== undefined) body = opts.raw;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const res = await app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) }, env);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
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
