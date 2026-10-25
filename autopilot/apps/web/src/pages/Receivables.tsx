import { useState } from "react";
import { gbp, json, today } from "../api";
import { useLoad } from "../hooks";
import { Empty, ErrorNote, Loading, Page } from "../ui";

const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
type Aged = { totals: Record<string, number>; totalPence: number; customers: { customer: string; buckets: Record<string, number>; totalPence: number }[] };
type Sched = { id: string; cadence: string; next_issue_date: string; active: number; template_json: string };

export function Receivables({ role }: { role: string }) {
  const aged = useLoad(() => json<Aged>(`/v1/receivables/aged?today=${today()}`));
  const sched = useLoad(() => (role === "owner" ? json<Sched[]>("/v1/recurring-invoices") : Promise.resolve([])));
  const [error, setError] = useState<Error | null>(null);
  const [msg, setMsg] = useState("");
  const act = async (fn: () => Promise<string>) => {
    setError(null);
    try {
      setMsg(await fn());
      await sched.reload();
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <Page title="Receivables">
      <ErrorNote error={aged.error ?? error} />
      <Loading show={aged.loading} />
      {msg ? (
        <p role="status" className="note">
          {msg}
        </p>
      ) : null}
      {aged.data ? (
        aged.data.customers.length ? (
          <table className="table">
            <caption>Aged debtors (days overdue) · total {gbp(aged.data.totalPence)}</caption>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                {BUCKETS.map((b) => (
                  <th scope="col" key={b} className="num">
                    {b}
                  </th>
                ))}
                <th scope="col" className="num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {aged.data.customers.map((c) => (
                <tr key={c.customer}>
                  <th scope="row">{c.customer}</th>
                  {BUCKETS.map((b) => (
                    <td key={b} className="num">
                      {c.buckets[b] ? gbp(c.buckets[b]) : "—"}
                    </td>
                  ))}
                  <td className="num">{gbp(c.totalPence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Nobody owes you anything right now.</Empty>
        )
      ) : null}
      {role === "owner" ? (
        <>
          <div className="row">
            <button
              type="button"
              onClick={() =>
                void act(
                  async () =>
                    `${(await json<{ emitted: unknown[] }>("/v1/receivables/reminders/run", "POST", {})).emitted.length} reminder(s) due (recorded, no emails sent).`,
                )
              }
            >
              Check reminders now
            </button>
          </div>
          <h2>Recurring invoices</h2>
          <p className="muted">Draft invoices are created automatically each day when due. Nothing is sent to customers.</p>
          <form
            className="card row wrap"
            aria-label="New recurring invoice"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                await json("/v1/recurring-invoices", "POST", {
                  template: {
                    customerName: String(f.get("customer")),
                    lines: [{ description: String(f.get("desc")), quantity: 1, unitPence: Math.round(Number(f.get("amount")) * 100), vatRateCode: "STD" }],
                  },
                  cadence: String(f.get("cadence")),
                  startDate: String(f.get("start")),
                });
                return "Schedule created.";
              });
            }}
          >
            <label>
              Customer
              <input name="customer" required maxLength={120} />
            </label>
            <label>
              Description
              <input name="desc" required maxLength={200} />
            </label>
            <label>
              Amount (£, ex VAT)
              <input name="amount" type="number" min="0" step="0.01" required />
            </label>
            <label>
              Every
              <select name="cadence" defaultValue="monthly">
                <option value="weekly">Week</option>
                <option value="monthly">Month</option>
                <option value="quarterly">Quarter</option>
                <option value="yearly">Year</option>
              </select>
            </label>
            <label>
              Starting
              <input name="start" type="date" defaultValue={today()} required />
            </label>
            <button type="submit">Create schedule</button>
          </form>
          <ErrorNote error={sched.error} />
          {sched.data?.length ? (
            <ul>
              {sched.data.map((s) => (
                <li key={s.id}>
                  {(JSON.parse(s.template_json) as { customerName: string }).customerName} · {s.cadence} · next {s.next_issue_date} {s.active ? "" : "(ended)"}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No recurring invoices yet.</Empty>
          )}
        </>
      ) : null}
    </Page>
  );
}
