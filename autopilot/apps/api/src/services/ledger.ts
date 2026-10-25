import { journalForBankLine, type Journal } from "@xevrion/pipeline";
import type { TenantDb } from "../lib/db.js";
import { newId } from "../lib/db.js";

export type Kind = "income" | "expense" | "transfer" | "suspense" | "capital";

export async function categoryKind(db: TenantDb, code: string): Promise<Kind> {
  if (code === "8000") return "transfer";
  if (code === "9999") return "suspense";
  const r = await db.first<{ kind: string }>("select kind from categories where tenant_id = ?1 and code = ?2", code);
  if (!r) return "suspense";
  return r.kind === "income" ? "income" : r.kind === "asset" ? "capital" : "expense";
}

function journalStatements(db: TenantDb, j: Journal, actor: string): D1PreparedStatement[] {
  const jid = newId();
  return [
    db.stmt(
      "insert into journals (tenant_id, id, entry_date, memo, source_type, source_id, created_by) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      jid,
      j.entryDate,
      j.memo.slice(0, 200),
      j.sourceType,
      j.sourceId,
      actor,
    ),
    ...j.lines.map((l) =>
      db.stmt(
        "insert into journal_lines (tenant_id, id, journal_id, account_code, debit_pence, credit_pence, vat_rate_code) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        newId(),
        jid,
        l.accountCode,
        l.debitPence,
        l.creditPence,
        l.vatRateCode ?? null,
      ),
    ),
  ];
}

/**
 * Post (or re-post) the journal for a transaction. Financial rows are never deleted: if a journal already exists for this
 * transaction, a reversing journal is posted first, then the new one.
 */
export async function postTransactionJournal(
  db: TenantDb,
  txn: { id: string; txn_date: string; description: string | null; amount_pence: number },
  categoryCode: string,
  vatPence: number,
  vatRateCode: string | null,
  actor: string,
): Promise<D1PreparedStatement[]> {
  const stmts: D1PreparedStatement[] = [];
  const prior = await db.all<{ account_code: string; debit: number; credit: number }>(
    `select l.account_code, sum(l.debit_pence) as debit, sum(l.credit_pence) as credit from journal_lines l join journals j on j.id = l.journal_id
     where l.tenant_id = ?1 and j.tenant_id = ?1 and j.source_type in ('transaction','reversal') and j.source_id = ?2 group by l.account_code`,
    txn.id,
  );
  const net = prior.map((p) => ({ code: p.account_code, bal: p.debit - p.credit })).filter((p) => p.bal !== 0);
  if (net.length) {
    stmts.push(
      ...journalStatements(
        db,
        {
          entryDate: txn.txn_date,
          memo: `Reversal: ${txn.description ?? ""}`,
          sourceType: "reversal",
          sourceId: txn.id,
          lines: net.map((p) =>
            p.bal > 0 ? { accountCode: p.code, debitPence: 0, creditPence: p.bal } : { accountCode: p.code, debitPence: -p.bal, creditPence: 0 },
          ),
        },
        actor,
      ),
    );
  }
  const kind = await categoryKind(db, categoryCode);
  const j = journalForBankLine({
    id: txn.id,
    date: txn.txn_date,
    description: txn.description ?? "",
    grossPence: txn.amount_pence,
    categoryCode,
    kind,
    vatPence,
    vatRateCode,
  });
  stmts.push(...journalStatements(db, j, actor));
  return stmts;
}
