import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "../dev/sqlite-d1.js";
import { GENESIS, PracticeAudit, PracticeDb, clientScopeSql, verifyAuditChain, type AuditRow } from "../src/lib/practice.js";

describe("PracticeDb guard", () => {
  it("rejects unscoped SQL and accepts scoped forms", () => {
    expect(() => PracticeDb.assertScoped("select * from practice_clients")).toThrow(/Unscoped/);
    expect(() => PracticeDb.assertScoped("select * from practice_clients where practice_id = ?2")).toThrow();
    expect(() => PracticeDb.assertScoped("select * from practice_clients where practice_id = ?10")).toThrow();
    for (const ok of [
      "select 1 from x where practice_id = ?1",
      "insert into x (practice_id, a) values (?1, ?3)",
      "insert into x (practice_id, a) select ?1, a from y",
      "select plan from practices where id = ?1",
    ])
      expect(() => PracticeDb.assertScoped(ok)).not.toThrow();
    expect(() => new PracticeDb({} as D1Database, "", "x")).toThrow();
  });
  it("binds ?1 practice, ?2 email, caller params from ?3, and refuses misnumbered params", async () => {
    const { d1 } = makeSqliteD1();
    const db = new PracticeDb(d1, "p1", "me@x.test");
    const r = await db.first<{ a: string; b: string; c: number }>("select ?1 a, ?2 b, ?3 c from (select 'p1' practice_id) where practice_id = ?1", 7);
    expect(r).toEqual({ a: "p1", b: "me@x.test", c: 7 });
    expect(() => db.stmt("select ?2 x from t where practice_id = ?1", 5)).toThrow(/start at \?3/);
  });
  it("client scope SQL: all clients for partner/manager/readonly, assignment-gated otherwise", () => {
    for (const r of ["partner", "manager", "readonly"] as const) expect(clientScopeSql(r)).not.toContain("client_assignments");
    for (const r of ["preparer", "reviewer"] as const) expect(clientScopeSql(r)).toContain("a.email = ?2");
  });
});

describe("hash-chained practice audit", () => {
  async function seeded(n: number) {
    const { d1, raw } = makeSqliteD1();
    raw.prepare("insert into practices (id, name) values ('p1', 'P')").run();
    const db = new PracticeDb(d1, "p1", "me@x.test");
    const a = new PracticeAudit(db);
    const stmts = [];
    for (let i = 0; i < n; i++) stmts.push(await a.stmt(`act.${i}`, `s${i}`, null, { i }));
    await db.batch(stmts);
    const rows = () =>
      raw
        .prepare("select seq, id, tenant_id, actor, action, subject, meta_json, created_at, prev_hash, hash from practice_audit order by seq")
        .all() as AuditRow[];
    return { raw, db, rows };
  }
  it("chains from genesis and verifies; a second writer continues the chain", async () => {
    const { db, rows } = await seeded(5);
    expect(rows()[0]!.prev_hash).toBe(GENESIS);
    const more = new PracticeAudit(db);
    await db.batch([await more.stmt("later", null, null)]);
    const v = await verifyAuditChain(rows());
    expect(v).toMatchObject({ ok: true, entries: 6, brokenAt: null });
    expect(v.headHash).toBe(rows()[5]!.hash);
    expect(await verifyAuditChain([])).toEqual({ ok: true, entries: 0, brokenAt: null, headHash: GENESIS });
  });
  it("the database refuses updates and deletes", async () => {
    const { raw } = await seeded(2);
    expect(() => raw.prepare("update practice_audit set action = 'x' where seq = 1").run()).toThrow(/append-only/);
    expect(() => raw.prepare("delete from practice_audit where seq = 1").run()).toThrow(/append-only/);
  });
  it("tampering below the triggers (edited, deleted or reordered rows) is detected at the first bad entry", async () => {
    const { raw, rows } = await seeded(4);
    raw.exec("drop trigger practice_audit_no_update; drop trigger practice_audit_no_delete;");
    const base = rows();
    expect((await verifyAuditChain(base.map((r) => (r.seq === 3 ? { ...r, meta_json: '{"i":99}' } : r)))).brokenAt).toBe(3);
    expect((await verifyAuditChain(base.filter((r) => r.seq !== 2))).brokenAt).toBe(3);
    expect((await verifyAuditChain([base[1]!, base[0]!, ...base.slice(2)])).brokenAt).toBe(2);
    expect((await verifyAuditChain(base.map((r) => (r.seq === 4 ? { ...r, prev_hash: GENESIS } : r)))).brokenAt).toBe(4);
    raw.prepare("update practice_audit set actor = 'mallory' where seq = 2").run();
    expect(await verifyAuditChain(rows())).toMatchObject({ ok: false, brokenAt: 2 });
  });
});
