/** Working-paper snapshots built from the client ledger. Deterministic JSON so the sha256 is reproducible (ADR 0025). */
import type { TenantDb } from "../lib/db.js";
import { sha256Hex } from "./csv.js";

export type PaperKind = "trial_balance" | "bank_reconciliation" | "vat_reconciliation";
const quarterStart = (periodEnd: string) => {
  const [y, m] = periodEnd.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 3, 1));
  return d.toISOString().slice(0, 10);
};

export async function buildSnapshot(tdb: TenantDb, kind: PaperKind, periodEnd: string): Promise<{ json: string; sha256: string }> {
  let body: Record<string, unknown>;
  if (kind === "trial_balance") {
    const rows = await tdb.all<{ account_code: string; net: number; vat: number; n: number }>(
      "select l.account_code, sum(l.net_pence) net, sum(l.vat_pence) vat, count(*) n from ledger_entries l join transactions t on t.id = l.transaction_id and t.tenant_id = ?1 where l.tenant_id = ?1 and t.txn_date <= ?2 group by l.account_code order by l.account_code",
      periodEnd,
    );
    body = {
      accounts: rows.map((r) => ({ account: r.account_code, netPence: r.net, vatPence: r.vat, entries: r.n })),
      totalNetPence: rows.reduce((a, r) => a + r.net, 0),
    };
  } else if (kind === "bank_reconciliation") {
    const r = await tdb.first<{ n: number; total: number | null; unreviewed: number | null; uncategorised: number | null }>(
      "select count(*) n, sum(amount_pence) total, sum(case when reviewed_at is null then 1 else 0 end) unreviewed, sum(case when category_code is null or category_code = '9999' then 1 else 0 end) uncategorised from transactions where tenant_id = ?1 and txn_date <= ?2",
      periodEnd,
    );
    body = {
      transactions: r?.n ?? 0,
      bookBalancePence: r?.total ?? 0,
      unreviewed: r?.unreviewed ?? 0,
      uncategorised: r?.uncategorised ?? 0,
      statementBalancePence: null,
    };
  } else {
    const from = quarterStart(periodEnd);
    const rows = await tdb.all<{ code: string | null; net: number; vat: number }>(
      "select l.vat_rate_code code, sum(l.net_pence) net, sum(l.vat_pence) vat from ledger_entries l join transactions t on t.id = l.transaction_id and t.tenant_id = ?1 where l.tenant_id = ?1 and t.txn_date >= ?2 and t.txn_date <= ?3 group by l.vat_rate_code order by coalesce(l.vat_rate_code, '')",
      from,
      periodEnd,
    );
    body = {
      from,
      rates: rows.map((r) => ({ rate: r.code, netPence: r.net, vatPence: r.vat })),
      totalVatPence: rows.reduce((a, r) => a + r.vat, 0),
      ratesVerified: false,
    };
  }
  const json = JSON.stringify({ kind, periodEnd, ...body });
  return { json, sha256: await sha256Hex(json) };
}
