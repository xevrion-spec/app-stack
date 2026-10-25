/**
 * Bank CSV ingestion shared by the owner upload, the practice import and the client portal: parse, scan, store, de-dupe by
 * fingerprint (one lookup per 100 lines, not per line), insert + events + audit + metering atomically, then queue the
 * pipeline. Quotas are enforced before anything is written.
 */
import type { Env } from "../env.js";
import { type TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { badRequest } from "../lib/errors.js";
import { parseBankCsv, sha256Hex } from "./csv.js";
import { Outbox } from "./events.js";
import { enforceQuota, meterStmt } from "./usage.js";
import { scanHook } from "./scan.js";

export async function ingestBankCsv(env: Env, db: TenantDb, actor: string, bytes: ArrayBuffer, filename?: string | null) {
  const text = new TextDecoder().decode(bytes);
  let parsed;
  try {
    parsed = parseBankCsv(text);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const sha = await sha256Hex(bytes);
  const docId = newId(),
    jobId = newId();
  const key = `${db.tenantId}/statements/${docId}.csv`;
  if ((await scanHook(bytes, "text/csv")) !== "clean") throw badRequest("File rejected by scanner");
  await enforceQuota(db, "transactions", parsed.lines.length);
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: "text/csv" }, sha256: sha, customMetadata: { tenant: db.tenantId } });
  const outbox = new Outbox(db);
  const stmts: D1PreparedStatement[] = [
    db.stmt("insert into jobs (tenant_id, id, kind, period, status) values (?1, ?2, 'monthly_books', null, 'queued')", jobId),
    db.stmt(
      "insert into documents (tenant_id, id, job_id, r2_key, filename, sha256, kind, size_bytes, content_type, scan_status) values (?1, ?2, ?3, ?4, ?5, ?6, 'bank_csv', ?7, 'text/csv', 'clean')",
      docId,
      jobId,
      key,
      filename?.slice(0, 120) || "statement.csv",
      sha,
      bytes.byteLength,
    ),
  ];
  const fps = await Promise.all(parsed.lines.map((l) => sha256Hex(`${l.date}|${l.amountPence}|${l.description.toUpperCase()}`)));
  const known = new Set<string>();
  for (let i = 0; i < fps.length; i += 100) {
    const chunk = fps.slice(i, i + 100);
    const rows = await db.all<{ fingerprint: string }>(
      `select fingerprint from transactions where tenant_id = ?1 and fingerprint in (${chunk.map((_, j) => `?${j + 2}`).join(", ")})`,
      ...chunk,
    );
    for (const r of rows) known.add(r.fingerprint);
  }
  let inserted = 0,
    duplicates = 0;
  parsed.lines.forEach((l, i) => {
    const fp = fps[i]!;
    if (known.has(fp)) return void duplicates++;
    known.add(fp); // the same line twice in one file is a duplicate too
    inserted++;
    const txnId = newId();
    outbox.add(
      "transaction.created",
      { transactionId: txnId, jobId, date: l.date, description: l.description, amountPence: l.amountPence, currency: l.currency },
      actor,
    );
    stmts.push(
      db.stmt(
        "insert or ignore into transactions (tenant_id, id, job_id, source, txn_date, description, amount_pence, currency, document_id, fingerprint, status, original_currency) values (?1, ?2, ?3, 'bank_csv', ?4, ?5, ?6, ?7, ?8, ?9, 'new', ?10)",
        txnId,
        jobId,
        l.date,
        l.description,
        l.amountPence,
        l.currency,
        docId,
        fp,
        l.currency === "GBP" ? null : l.currency,
      ),
    );
  });
  stmts.push(auditStmt(db, actor, "upload.bank_csv", docId, { sha256: sha, inserted, duplicates, rejected: parsed.rejected.length }), ...outbox.stmts);
  if (inserted) stmts.push(meterStmt(db, "transactions", inserted));
  await db.batch(stmts);
  await outbox.publish(env);
  if (inserted) await env.PIPELINE.send({ jobId, tenantId: db.tenantId });
  else await db.run("update jobs set status = 'completed' where tenant_id = ?1 and id = ?2", jobId);
  return { documentId: docId, sha256: sha, jobId, inserted, duplicates, rejectedRows: parsed.rejected };
}
