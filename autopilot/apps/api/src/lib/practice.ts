/**
 * Practice (firm) access layer.
 *  - PracticeDb: every query must constrain/insert practice_id = ?1 (bound automatically), and ?2 is always the
 *    signed-in staff email, so client-visibility subqueries can use it. Cross-practice access is a runtime error.
 *  - practicePrincipal: resolves identity -> practice_staff membership (the one unscoped lookup, like tenant membership).
 *  - clientScopeSql: the set of client tenant ids this staff member may see (all for partner/manager/readonly;
 *    assigned only for preparer/reviewer). Every cross-client query joins through it.
 *  - PracticeAudit: append-only, hash-chained audit entries (tamper-evident; DB triggers forbid update/delete).
 */
import type { Context, MiddlewareHandler } from "hono";
import { SEES_ALL_CLIENTS } from "@xevrion/books";
import type { AppEnv, PracticePrincipal, PracticeRole } from "../env.js";
import { AppError, forbidden, notFound } from "./errors.js";
import { newId } from "./db.js";
import { monotonicIso } from "./audit.js";

const PRACTICE_GUARD = /practice_id\s*=\s*\?1\b|\(\s*practice_id\b[^)]*\)\s*(?:values\s*\(|select)\s*\?1\b|\bfrom\s+practices\s+where\s+id\s*=\s*\?1\b/is;
const maxParam = (sql: string) => Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));

export class PracticeDb {
  constructor(
    readonly db: D1Database,
    readonly practiceId: string,
    readonly email: string,
  ) {
    if (!practiceId) throw new AppError(500, "internal", "PracticeDb requires a practice id");
  }
  static assertScoped(sql: string): void {
    if (!PRACTICE_GUARD.test(sql)) throw new AppError(500, "internal", `Unscoped practice query rejected: ${sql.slice(0, 80)}`);
  }
  /** ?1 = practice id, ?2 = staff email, caller params from ?3. */
  stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
    PracticeDb.assertScoped(sql);
    const n = maxParam(sql);
    if (n < 2 + params.length && params.length) throw new AppError(500, "internal", "Practice query params must start at ?3");
    return this.db.prepare(sql).bind(...[this.practiceId, this.email, ...params].slice(0, Math.max(1, n)));
  }
  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return (await this.stmt(sql, ...params).all<T>()).results ?? [];
  }
  async first<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    return (await this.stmt(sql, ...params).first<T>()) ?? null;
  }
  async run(sql: string, ...params: unknown[]): Promise<number> {
    return (await this.stmt(sql, ...params).run()).meta?.changes ?? 0;
  }
  async batch(stmts: D1PreparedStatement[]): Promise<number[]> {
    if (!stmts.length) return [];
    return (await this.db.batch(stmts)).map((r) => r.meta?.changes ?? 0);
  }
}

/** SQL for the client tenant ids visible to the signed-in staff member (uses ?1 practice and ?2 email). */
export function clientScopeSql(role: PracticeRole): string {
  const base = "select pc.tenant_id from practice_clients pc where pc.practice_id = ?1 and pc.status != 'archived'";
  return SEES_ALL_CLIENTS.has(role)
    ? base
    : `${base} and exists (select 1 from client_assignments a where a.practice_id = ?1 and a.tenant_id = pc.tenant_id and a.email = ?2)`;
}

export const practiceDb = (c: Context<AppEnv>) => {
  const p = c.get("practice");
  return new PracticeDb(c.env.DB, p.practiceId, p.email);
};

export const practicePrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = c.get("identityEmail");
  if (!email || email.startsWith("api_key:")) throw new AppError(403, "insufficient_scope", "Practice endpoints are not available to API keys");
  const wanted = c.req.header("x-practice-id");
  const rows =
    (await c.env.DB.prepare("select practice_id, role from practice_staff where email = ?1").bind(email).all<{ practice_id: string; role: PracticeRole }>())
      .results ?? [];
  const row = wanted ? rows.find((r) => r.practice_id === wanted) : rows[0];
  if (!row) throw new AppError(403, "forbidden", rows.length ? "Not a member of that practice" : "No practice membership for this user");
  c.set("practice", { practiceId: row.practice_id, email, role: row.role } satisfies PracticePrincipal);
  return next();
};

export function requirePracticeRole(...roles: PracticeRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roles.includes(c.get("practice").role)) throw forbidden();
    return next();
  };
}
/** Writes are never allowed for read-only staff, whatever the route says. */
export const noReadonlyWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.get("practice").role === "readonly") throw forbidden("Read-only staff cannot make changes");
  return next();
};

export interface ClientRow {
  tenant_id: string;
  name: string;
  status: string;
  year_end: string;
  vat_stagger: 1 | 2 | 3 | null;
  mtd_itsa: number;
  sa_required: number;
  fee_model: "fixed" | "hourly" | "outcome";
  fee_pence: number;
  hourly_rate_pence: number;
  auto_approve_json: string;
  qa_sample_rate: number;
  review_sla_hours: number;
  created_at: string;
}
export const CLIENT_COLS =
  "tenant_id, name, status, year_end, vat_stagger, mtd_itsa, sa_required, fee_model, fee_pence, hourly_rate_pence, auto_approve_json, qa_sample_rate, review_sla_hours, created_at";

/** Loads a client the staff member may access, else 404 (never 403: no enumeration of other firms' clients). */
export async function accessibleClient(pdb: PracticeDb, role: PracticeRole, tenantId: string): Promise<ClientRow> {
  const row = await pdb.first<ClientRow>(
    `select ${CLIENT_COLS} from practice_clients where practice_id = ?1 and tenant_id = ?3 and tenant_id in (${clientScopeSql(role).replace("pc.status != 'archived'", "1 = 1")})`,
    tenantId,
  );
  if (!row) throw notFound("Client");
  return row;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
export const GENESIS = "0".repeat(64);
export interface AuditRow {
  seq: number;
  id: string;
  tenant_id: string | null;
  actor: string;
  action: string;
  subject: string | null;
  meta_json: string | null;
  created_at: string;
  prev_hash: string;
  hash: string;
}
const auditHash = (prev: string, r: Omit<AuditRow, "prev_hash" | "hash">) =>
  sha256(`${prev}|${JSON.stringify([r.seq, r.id, r.tenant_id, r.actor, r.action, r.subject, r.meta_json, r.created_at])}`);

/** Builds hash-chained audit statements for one request; add them to the same batch as the change they describe. */
export class PracticeAudit {
  private head: { seq: number; hash: string } | null = null;
  constructor(private readonly pdb: PracticeDb) {}
  async stmt(action: string, subject: string | null, tenantId: string | null, meta?: unknown): Promise<D1PreparedStatement> {
    if (!this.head) {
      const last = await this.pdb.first<{ seq: number; hash: string }>("select seq, hash from practice_audit where practice_id = ?1 order by seq desc limit 1");
      this.head = last ?? { seq: 0, hash: GENESIS };
    }
    const row = {
      seq: this.head.seq + 1,
      id: newId(),
      tenant_id: tenantId,
      actor: this.pdb.email,
      action,
      subject,
      meta_json: meta === undefined ? null : JSON.stringify(meta),
      created_at: monotonicIso(),
    };
    const hash = await auditHash(this.head.hash, row);
    const prev = this.head.hash;
    this.head = { seq: row.seq, hash };
    return this.pdb.stmt(
      "insert into practice_audit (practice_id, seq, id, tenant_id, actor, action, subject, meta_json, created_at, prev_hash, hash) values (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
      row.seq,
      row.id,
      row.tenant_id,
      row.actor,
      row.action,
      row.subject,
      row.meta_json,
      row.created_at,
      prev,
      hash,
    );
  }
}
/** Recomputes the whole chain; returns the first broken sequence number, if any. */
export async function verifyAuditChain(rows: AuditRow[]): Promise<{ ok: boolean; entries: number; brokenAt: number | null; headHash: string }> {
  let prev = GENESIS;
  let expectSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectSeq || r.prev_hash !== prev || (await auditHash(prev, r)) !== r.hash)
      return { ok: false, entries: rows.length, brokenAt: r.seq, headHash: prev };
    prev = r.hash;
    expectSeq++;
  }
  return { ok: true, entries: rows.length, brokenAt: null, headHash: prev };
}
