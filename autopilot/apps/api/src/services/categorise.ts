import { TenantDb } from "../lib/db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { auditStmt } from "../lib/audit.js";
import { postTransactionJournal } from "./ledger.js";
import type { Outbox } from "./events.js";

/** Categorise one transaction: update + reversing/new journal + audit + transaction.categorised event, atomically. */
// eslint-disable-next-line max-params -- known debt (docs/quality.md): split in a follow-up
export async function categoriseTransaction(
  db: TenantDb,
  actor: string,
  id: string,
  categoryCode: string,
  vatRateCode: string | null,
  vatPence: number,
  opts: { outbox?: Outbox; method?: string; causationChain?: string[]; extra?: D1PreparedStatement[] } = {},
) {
  const t = await db.first<{ id: string; txn_date: string; description: string | null; amount_pence: number }>(
    "select id, txn_date, description, amount_pence from transactions where tenant_id = ?1 and id = ?2",
    id,
  );
  if (!t) throw notFound("Transaction");
  if (!(await db.first("select code from categories where tenant_id = ?1 and code = ?2", categoryCode))) throw badRequest(`Unknown category ${categoryCode}`);
  if (vatPence > Math.abs(t.amount_pence)) throw badRequest("VAT cannot exceed the transaction amount");
  opts.outbox?.add(
    "transaction.categorised",
    { transactionId: id, categoryCode, method: opts.method ?? "manual", confidence: 1, description: t.description ?? "", amountPence: t.amount_pence },
    actor,
    opts.causationChain ?? [],
  );
  await db.batch([
    db.stmt(
      "update transactions set category_code = ?3, vat_rate_code = ?4, vat_pence = ?5, confidence = 1, status = 'categorised' where tenant_id = ?1 and id = ?2",
      id,
      categoryCode,
      vatRateCode,
      vatPence,
    ),
    ...(await postTransactionJournal(db, t, categoryCode, vatPence, vatRateCode, actor)),
    auditStmt(db, actor, "transaction.categorised", id, { categoryCode, vatRateCode, vatPence }),
    ...(opts.outbox?.stmts.splice(0) ?? []),
    ...(opts.extra ?? []),
  ]);
  return t;
}
