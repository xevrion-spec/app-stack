/**
 * D1-compatible adapter over better-sqlite3 (real SQLite, real migrations). Used by tests and the Docker-free local server.
 * Implements the D1 subset the app uses: prepare/bind/first/all/run/batch/exec, with numbered ?N params.
 * Never bundled into the Worker (only imported from test/ and dev/).
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(import.meta.url).replace(/[\\/][^\\/]*$/, "");

export const MIGRATIONS_DIR = join(HERE, "../../../migrations");

class Stmt {
  constructor(
    private db: Database.Database,
    private sql: string,
    private params: unknown[] = [],
  ) {}
  bind(...p: unknown[]) {
    return new Stmt(
      this.db,
      this.sql,
      p.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v)),
    );
  }
  private named() {
    return Object.fromEntries(this.params.map((v, i) => [String(i + 1), v]));
  }
  private prep() {
    return this.db.prepare(this.sql.replace(/\?(\d+)/g, "@$1"));
  }
  async first<T>() {
    const s = this.prep();
    return ((s.reader ? s.get(this.named()) : (s.run(this.named()), undefined)) as T) ?? null;
  }
  async all<T>() {
    const s = this.prep();
    return { results: (s.reader ? s.all(this.named()) : (s.run(this.named()), [])) as T[], success: true, meta: {} };
  }
  async run() {
    const s = this.prep();
    if (s.reader) {
      s.all(this.named());
      return { success: true, meta: { changes: 0 } };
    }
    const r = s.run(this.named());
    return { success: true, meta: { changes: r.changes } };
  }
  runSync() {
    const s = this.prep();
    return s.reader ? s.all(this.named()) : s.run(this.named());
  }
}

/** Applies migrations not yet recorded in d1_migrations (same bookkeeping table name as wrangler). */
export function migrate(raw: Database.Database) {
  raw.exec("create table if not exists d1_migrations (id integer primary key autoincrement, name text unique, applied_at text default (datetime('now')))");
  const done = new Set((raw.prepare("select name from d1_migrations").all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    if (done.has(f)) continue;
    raw.transaction(() => {
      raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      raw.prepare("insert into d1_migrations (name) values (?)").run(f);
    })();
    applied.push(f);
  }
  return applied;
}

export function makeSqliteD1(path = ":memory:"): { d1: D1Database; raw: Database.Database } {
  const raw = new Database(path);
  raw.pragma("foreign_keys = ON");
  if (path !== ":memory:") raw.pragma("journal_mode = WAL");
  migrate(raw);
  const d1 = {
    prepare: (sql: string) => new Stmt(raw, sql),
    batch: async (stmts: Stmt[]) =>
      raw
        .transaction(() => stmts.map((s) => s.runSync()))()
        .map(() => ({ success: true, meta: {} })),
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
  return { d1: d1 as unknown as D1Database, raw };
}
