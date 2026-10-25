import cats from "../../../../packages/domain-uk-tax/categories.json" with { type: "json" };
import type { TenantDb } from "../lib/db.js";
import { newId } from "../lib/db.js";

const KIND: Record<string, "income" | "expense" | "asset" | "liability" | "equity"> = { "4000": "income", "9999": "liability" };
const SA_BOX: Record<string, string> = {
  "5000": "cost of goods",
  "6100": "travel",
  "6200": "admin/office",
  "6300": "phone/internet",
  "6400": "admin/office",
  "6500": "advertising",
  "6600": "professional fees",
  "6700": "bank charges",
};

/** Seed chart of accounts + keyword rules for a new tenant (from domain-uk-tax/categories.json, unverified heuristics). */
export function defaultSetupStatements(db: TenantDb): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const extra = [
    { code: "1200", name: "Bank", kind: "asset" },
    { code: "1210", name: "Savings (own account)", kind: "asset" },
    { code: "2200", name: "VAT control", kind: "liability" },
    { code: "8000", name: "Transfers between own accounts", kind: "asset" },
  ];
  for (const a of cats.accounts) {
    stmts.push(
      db.stmt(
        "insert or ignore into categories (tenant_id, code, name, kind, sa_box, default_vat_rate_code) values (?1, ?2, ?3, ?4, ?5, ?6)",
        a.code,
        a.name,
        KIND[a.code] ?? "expense",
        SA_BOX[a.code] ?? null,
        a.code === "4000" ? "STD" : null,
      ),
    );
    for (const kw of a.kw) {
      const p = kw.trim();
      if (p.length < 2) continue;
      stmts.push(
        db.stmt(
          "insert into category_rules (tenant_id, id, pattern, match_type, category_code, priority, created_by) values (?1, ?2, ?3, 'contains', ?4, 100, 'system')",
          newId(),
          p.toUpperCase(),
          a.code,
        ),
      );
    }
  }
  for (const a of extra) stmts.push(db.stmt("insert or ignore into categories (tenant_id, code, name, kind) values (?1, ?2, ?3, ?4)", a.code, a.name, a.kind));
  stmts.push(db.stmt("insert or ignore into invoice_sequences (tenant_id, prefix, next_value) values (?1, 'INV-', 1)"));
  return stmts;
}
