import { AppError } from "./errors.js";

/**
 * Tenant-scoped data access. EVERY query goes through TenantDb, which:
 *  - binds the tenant id as parameter ?1 automatically, and
 *  - refuses SQL that does not constrain/insert tenant_id = ?1.
 * This makes cross-tenant reads/writes a programming error caught at runtime (and in tests).
 */
const TENANT_GUARD = /tenant_id\s*=\s*\?1\b|\(\s*tenant_id\b[^)]*\)\s*values\s*\(\s*\?1\b/is;

export class TenantDb {
  constructor(
    private readonly db: D1Database,
    public readonly tenantId: string,
  ) {
    if (!tenantId) throw new AppError(500, "internal", "TenantDb requires a tenant id");
  }
  static assertScoped(sql: string): void {
    if (!TENANT_GUARD.test(sql)) throw new AppError(500, "internal", `Unscoped query rejected: ${sql.slice(0, 80)}`);
  }
  stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
    TenantDb.assertScoped(sql);
    return this.db.prepare(sql).bind(this.tenantId, ...params);
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
  /** The tenants table is keyed by id (not tenant_id); access is still pinned to this tenant. */
  tenantRowStmt(columns: string): D1PreparedStatement {
    if (!/^[a-z_, ]+$/.test(columns)) throw new AppError(500, "internal", "bad column list");
    return this.db.prepare(`select ${columns} from tenants where id = ?1`).bind(this.tenantId);
  }
  updateTenantStmt(fields: Record<string, string | number | null>): D1PreparedStatement {
    const keys = Object.keys(fields);
    if (!keys.length || !keys.every((k) => /^[a-z_]+$/.test(k))) throw new AppError(500, "internal", "bad tenant update");
    const sets = keys.map((k, i) => `${k} = ?${i + 2}`).join(", ");
    return this.db.prepare(`update tenants set ${sets} where id = ?1`).bind(this.tenantId, ...keys.map((k) => fields[k]));
  }
  /** Atomic multi-statement write. */
  async batch(stmts: D1PreparedStatement[]): Promise<void> {
    await this.db.batch(stmts);
  }
}

export const newId = () => crypto.randomUUID();

/** Opaque cursor pagination over (created_at, id). */
export function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id]));
}
export function decodeCursor(c: string | undefined): [string, string] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(atob(c));
    return Array.isArray(v) && v.length === 2 ? [String(v[0]), String(v[1])] : null;
  } catch {
    return null;
  }
}
