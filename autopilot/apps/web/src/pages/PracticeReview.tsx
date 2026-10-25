import { useState } from "react";
import { gbp, json } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Loading } from "../ui";

/** Exceptions-only review: the AI first pass categorised everything else; staff confirm or correct what it was unsure of. */
type Item = {
  tenantId: string;
  client: string;
  transactionId: string;
  date: string;
  description: string | null;
  amountPence: number;
  categoryCode: string | null;
  confidence: number | null;
  sla: string;
  reason: string;
};
const ACCOUNTS: [string, string][] = [
  ["4000", "Sales"],
  ["5000", "Cost of goods"],
  ["6100", "Travel"],
  ["6200", "Office & admin"],
  ["6300", "Phone & internet"],
  ["6400", "Software & subscriptions"],
  ["6500", "Advertising"],
  ["6600", "Professional fees"],
  ["6700", "Bank charges"],
  ["8000", "Transfer / drawings"],
  ["9999", "Suspense / needs review"],
];
const REVIEWERS = new Set(["partner", "manager", "preparer", "reviewer"]);

function Row({ it, canAct, onDone }: { it: Item; canAct: boolean; onDone: (e?: Error) => void }) {
  const [code, setCode] = useState(it.categoryCode ?? "9999");
  const desc = it.description ?? "(no description)";
  return (
    <tr>
      <td>{it.client}</td>
      <td>{it.date}</td>
      <th scope="row">{desc}</th>
      <td>{gbp(it.amountPence)}</td>
      <td>
        {it.reason} {it.confidence !== null ? `(${Math.round(it.confidence * 100)}%)` : ""} <Badge value={it.sla} />
      </td>
      <td>
        {canAct ? (
          <>
            <label className="sr-only" htmlFor={`cat-${it.transactionId}`}>{`Category for ${desc}`}</label>
            <select id={`cat-${it.transactionId}`} value={code} onChange={(e) => setCode(e.target.value)}>
              {ACCOUNTS.map(([c, n]) => (
                <option key={c} value={c}>
                  {c} {n}
                </option>
              ))}
            </select>{" "}
            <button
              type="button"
              disabled={code === "9999"}
              onClick={() =>
                json("/v1/practice/review/approve", "POST", { items: [{ clientId: it.tenantId, transactionId: it.transactionId, categoryCode: code }] }).then(
                  () => onDone(),
                  (e: Error) => onDone(e),
                )
              }
            >
              {`Approve ${desc}`}
            </button>
          </>
        ) : (
          (it.categoryCode ?? "—")
        )}
      </td>
    </tr>
  );
}

export function PracticeReview({ role }: { role: string }) {
  const q = useLoad(() => json<{ items: Item[]; total: number }>("/v1/practice/review-queue"));
  const [err, setErr] = useState<Error | null>(null);
  const items = q.data?.items ?? [];
  return (
    <section aria-labelledby="rq-h">
      <h2 id="rq-h">Review queue (exceptions only)</h2>
      <p>The AI first pass categorised everything else. Correct or confirm what it was unsure about. Corrections teach the rules.</p>
      <ErrorNote error={q.error ?? err} />
      <Loading show={q.loading} />
      {q.data && !items.length ? <Empty>Nothing to review.</Empty> : null}
      {items.length ? (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Review queue table">
          <table className="table">
            <caption className="sr-only">Transactions awaiting review</caption>
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Date</th>
                <th scope="col">Description</th>
                <th scope="col">Amount</th>
                <th scope="col">Why</th>
                <th scope="col">Category</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <Row
                  key={it.transactionId}
                  it={it}
                  canAct={REVIEWERS.has(role)}
                  onDone={(e) => {
                    setErr(e ?? null);
                    void q.reload();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
