import { useState } from "react";
import { gbp, json, today } from "../api";
import { useLoad } from "../hooks";
import { DraftBanner, ErrorNote, Loading, Page } from "../ui";

type Line = { code: string; name: string; pence: number };
type PnL = { income: Line[]; expenses: Line[]; totalIncomePence: number; totalExpensesPence: number; netProfitPence: number };
type BS = {
  assets: Line[];
  liabilities: Line[];
  equity: Line[];
  totalAssetsPence: number;
  totalLiabilitiesPence: number;
  totalEquityPence: number;
  balances: boolean;
};
type Fc = { startBalancePence: number; runwayDays: number | null; lowestBalancePence: number; monthlyBurnPence: number };
type Deadline = { id: string; title: string; dueDate: string };

function Lines({ caption, rows, total }: { caption: string; rows: Line[]; total: number }) {
  return (
    <table className="table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Account</th>
          <th scope="col" className="num">
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.code}>
            <td>
              {r.code} {r.name}
            </td>
            <td className="num">{gbp(r.pence)}</td>
          </tr>
        ))}
        <tr className="total">
          <th scope="row">Total</th>
          <td className="num">{gbp(total)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function Reports() {
  const y = today().slice(0, 4);
  const [range, setRange] = useState({ from: `${y}-01-01`, to: today() });
  const pnl = useLoad(() => json<PnL>(`/v1/books/reports/pnl?from=${range.from}&to=${range.to}`), [range.from, range.to]);
  const bs = useLoad(() => json<BS>(`/v1/books/reports/balance-sheet?asAt=${range.to}`), [range.to]);
  const fc = useLoad(() => json<Fc>("/v1/books/forecast"));
  const dl = useLoad(() => json<Deadline[]>(`/v1/books/deadlines?today=${today()}&days=120`));
  return (
    <Page title="Reports">
      <form
        className="card row wrap"
        aria-label="Report period"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setRange({ from: String(f.get("from")), to: String(f.get("to")) });
        }}
      >
        <label>
          From
          <input type="date" name="from" defaultValue={range.from} required />
        </label>
        <label>
          To
          <input type="date" name="to" defaultValue={range.to} required />
        </label>
        <button type="submit">Update</button>
      </form>
      <ErrorNote error={pnl.error ?? bs.error ?? fc.error ?? dl.error} />
      <Loading show={pnl.loading} />
      <div className="grid2">
        {pnl.data ? (
          <section className="card" aria-labelledby="pnl-h">
            <h2 id="pnl-h">Profit and loss</h2>
            <Lines caption="Income" rows={pnl.data.income} total={pnl.data.totalIncomePence} />
            <Lines caption="Expenses" rows={pnl.data.expenses} total={pnl.data.totalExpensesPence} />
            <p className="big">
              Net profit <strong>{gbp(pnl.data.netProfitPence)}</strong>
            </p>
          </section>
        ) : null}
        {bs.data ? (
          <section className="card" aria-labelledby="bs-h">
            <h2 id="bs-h">Balance sheet at {range.to}</h2>
            <Lines caption="Assets" rows={bs.data.assets} total={bs.data.totalAssetsPence} />
            <Lines caption="Liabilities" rows={bs.data.liabilities} total={bs.data.totalLiabilitiesPence} />
            <p className={bs.data.balances ? "muted" : "note error"}>{bs.data.balances ? "Balances ✓" : "Does not balance: check the review queue"}</p>
          </section>
        ) : null}
      </div>
      {fc.data ? (
        <section className="card" aria-labelledby="fc-h">
          <h2 id="fc-h">Cash forecast</h2>
          <dl className="boxes">
            <div className="box">
              <dt>Cash now</dt>
              <dd>{gbp(fc.data.startBalancePence)}</dd>
            </div>
            <div className="box">
              <dt>Lowest point</dt>
              <dd>{gbp(fc.data.lowestBalancePence)}</dd>
            </div>
            <div className="box hl">
              <dt>Runway</dt>
              <dd>{fc.data.runwayDays === null ? "Positive throughout" : `${fc.data.runwayDays} days`}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {dl.data ? (
        <section className="card" aria-labelledby="dl-h">
          <h2 id="dl-h">Upcoming deadlines</h2>
          <DraftBanner />
          <ul>
            {dl.data.map((d) => (
              <li key={d.id}>
                <time dateTime={d.dueDate}>{d.dueDate}</time> {d.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Page>
  );
}
