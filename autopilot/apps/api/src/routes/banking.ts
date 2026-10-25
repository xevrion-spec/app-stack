/**
 * Bank feeds through the `BankFeed` interface (ADR 0017). ONLY `MockBankFeed` (synthetic data) is wired; connecting a real
 * Open Banking provider needs Henry's provider choice and approval. Synced rows land as transactions (source 'bank_feed'),
 * de-duplicated by fingerprint, then flow through the normal review/categorisation path.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as B from "@xevrion/books";
import type { AppEnv } from "../env.js";
import { requireRole } from "../lib/auth.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { requireFeature } from "../lib/entitlements.js";
import { sha256Hex } from "../services/csv.js";

type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const actor = (c: C) => c.get("principal").email;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
let feed: B.BankFeed = new B.MockBankFeed();
export const __setBankFeed = (f: B.BankFeed) => void (feed = f);

export const banking = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
banking.use("/bank-feeds/*", requireRole("owner"), requireFeature("imports_advanced"));

const Conn = z
  .object({
    id: z.string(),
    provider: z.string(),
    account_id: z.string(),
    account_name: z.string().nullable(),
    status: z.string(),
    synced_until: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("BankFeedConnection");
const COLS = "id, provider, account_id, account_name, status, synced_until, created_at";
const getConn = async (db: TenantDb, id: string) => {
  const r = await db.first<z.infer<typeof Conn>>(`select ${COLS} from bank_feed_connections where tenant_id = ?1 and id = ?2`, id);
  if (!r) throw notFound("Connection not found");
  return r;
};

banking.openapi(
  def({
    method: "get",
    path: "/bank-feeds/accounts",
    tag: "Bank feeds",
    summary: "Accounts available from the bank-feed provider (MOCK provider, synthetic)",
    response: z.object({ provider: z.string(), mock: z.boolean(), accounts: z.array(z.object({ id: z.string(), name: z.string(), currency: z.string() })) }),
  }),
  async (c) => c.json({ provider: feed.name, mock: feed.name.startsWith("mock"), accounts: await feed.accounts() }, 200),
);
banking.openapi(
  def({
    method: "post",
    path: "/bank-feeds/connections",
    tag: "Bank feeds",
    summary: "Connect a provider account (mock)",
    body: z.object({ accountId: z.string().min(1).max(100) }),
    response: Conn,
    status: 201,
  }),
  async (c) => {
    const { accountId } = c.req.valid("json");
    const acc = (await feed.accounts()).find((a) => a.id === accountId);
    if (!acc) throw badRequest("Unknown account for this provider");
    const db = scope(c);
    const existing = await db.first<{ id: string; status: string }>(
      "select id, status from bank_feed_connections where tenant_id = ?1 and provider = ?2 and account_id = ?3",
      feed.name,
      accountId,
    );
    if (existing?.status === "active") throw conflict("Account already connected");
    const id = existing?.id ?? newId();
    await db.batch([
      existing
        ? db.stmt("update bank_feed_connections set status = 'active' where tenant_id = ?1 and id = ?2", id)
        : db.stmt(
            "insert into bank_feed_connections (tenant_id, id, provider, account_id, account_name, created_by) values (?1, ?2, ?3, ?4, ?5, ?6)",
            id,
            feed.name,
            acc.id,
            acc.name,
            actor(c),
          ),
      auditStmt(db, actor(c), "bank_feed.connected", id, { provider: feed.name }),
    ]);
    return c.json(await getConn(db, id), 201);
  },
);
banking.openapi(
  def({ method: "get", path: "/bank-feeds/connections", tag: "Bank feeds", summary: "Bank-feed connections", response: z.array(Conn) }),
  async (c) => c.json(await scope(c).all<z.infer<typeof Conn>>(`select ${COLS} from bank_feed_connections where tenant_id = ?1 order by created_at`), 200),
);
banking.openapi(
  def({
    method: "post",
    path: "/bank-feeds/connections/{id}/sync",
    tag: "Bank feeds",
    summary: "Pull new transactions since the last sync (de-duplicated; first sync covers 90 days)",
    params: IdParam,
    body: z.object({ today: Day.optional() }),
    response: z.object({ fetched: z.number(), inserted: z.number(), duplicates: z.number(), syncedUntil: z.string() }),
  }),
  async (c) => {
    const db = scope(c);
    const conn = await getConn(db, c.req.valid("param").id);
    if (conn.status !== "active") throw conflict("Connection is not active");
    const until = c.req.valid("json").today ?? new Date().toISOString().slice(0, 10);
    const since = conn.synced_until ? B.addDays(conn.synced_until, 1) : B.addDays(until, -90);
    const rows = since > until ? [] : await feed.transactions(conn.account_id, since, until);
    let inserted = 0;
    for (const r of rows) {
      inserted += await db.run(
        "insert or ignore into transactions (tenant_id, id, source, txn_date, description, amount_pence, currency, fingerprint, status) values (?1, ?2, 'bank_feed', ?3, ?4, ?5, 'GBP', ?6, 'new')",
        newId(),
        r.date,
        r.description.slice(0, 500),
        r.amountPence,
        await sha256Hex(`feed|${conn.provider}|${r.id}`),
      );
    }
    await db.batch([
      db.stmt("update bank_feed_connections set synced_until = ?3 where tenant_id = ?1 and id = ?2", conn.id, until),
      auditStmt(db, actor(c), "bank_feed.synced", conn.id, { fetched: rows.length, inserted }),
    ]);
    return c.json({ fetched: rows.length, inserted, duplicates: rows.length - inserted, syncedUntil: until }, 200);
  },
);
banking.openapi(
  def({
    method: "delete",
    path: "/bank-feeds/connections/{id}",
    tag: "Bank feeds",
    summary: "Disconnect (keeps imported transactions)",
    params: IdParam,
    response: Conn,
  }),
  async (c) => {
    const db = scope(c);
    const conn = await getConn(db, c.req.valid("param").id);
    await db.batch([
      db.stmt("update bank_feed_connections set status = 'revoked' where tenant_id = ?1 and id = ?2", conn.id),
      auditStmt(db, actor(c), "bank_feed.revoked", conn.id, {}),
    ]);
    return c.json({ ...conn, status: "revoked" }, 200);
  },
);
