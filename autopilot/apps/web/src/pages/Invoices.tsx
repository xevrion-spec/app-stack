import { useState } from "react";
import { download, gbp, sdk, unwrap, type Schemas } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Loading, Page } from "../ui";

type Line = Schemas["CreateInvoice"]["lines"][number];
const today = () => new Date().toISOString().slice(0, 10);
const plus30 = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const blank = (): Line => ({ description: "", quantity: 1, unitPence: 0, vatRateCode: "STD" });
const NEXT: Record<string, ("sent" | "paid" | "void")[]> = { draft: ["sent", "void"], sent: ["paid", "void"], paid: [], void: [] };

export function Invoices() {
  const list = useLoad(async () => unwrap(await sdk().GET("/v1/invoices")));
  const [showForm, setShowForm] = useState(false);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const email = String(f.get("email") || "");
      const inv = unwrap(
        await sdk().POST("/v1/invoices", {
          body: {
            customerName: String(f.get("customer")),
            ...(email ? { customerEmail: email } : {}),
            issueDate: String(f.get("issue")),
            dueDate: String(f.get("due")),
            lines,
          },
        }),
      );
      list.setData((l) => [inv, ...(l ?? [])]);
      setShowForm(false);
      setLines([blank()]);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  async function setStatus(id: string, status: "sent" | "paid" | "void") {
    setError(null);
    try {
      const inv = unwrap(await sdk().POST("/v1/invoices/{id}/status", { params: { path: { id } }, body: { status } }));
      list.setData((l) => l?.map((x) => (x.id === id ? inv : x)) ?? l);
    } catch (err) {
      setError(err as Error);
    }
  }
  const upd = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <Page
      title="Invoices"
      actions={
        <button type="button" onClick={() => setShowForm((s) => !s)} aria-expanded={showForm} aria-controls="new-invoice">
          {showForm ? "Close" : "New invoice"}
        </button>
      }
    >
      <ErrorNote error={list.error ?? error} />
      {showForm ? (
        <form id="new-invoice" className="card stack" onSubmit={create} aria-label="New invoice">
          <div className="grid2">
            <label>
              Customer name
              <input name="customer" required maxLength={120} />
            </label>
            <label>
              Customer email (optional; nothing is emailed)
              <input name="email" type="email" />
            </label>
            <label>
              Issue date
              <input name="issue" type="date" required defaultValue={today()} />
            </label>
            <label>
              Due date
              <input name="due" type="date" required defaultValue={plus30()} />
            </label>
          </div>
          <fieldset>
            <legend>Lines</legend>
            {lines.map((l, i) => (
              <div className="line-row" key={i}>
                <label>
                  Description
                  <input value={l.description} onChange={(e) => upd(i, { description: e.target.value })} required maxLength={200} />
                </label>
                <label>
                  Qty
                  <input type="number" min="0.01" step="0.01" value={l.quantity} onChange={(e) => upd(i, { quantity: Number(e.target.value) })} required />
                </label>
                <label>
                  Unit price (£, ex VAT)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={l.unitPence / 100}
                    onChange={(e) => upd(i, { unitPence: Math.round(Number(e.target.value) * 100) })}
                    required
                  />
                </label>
                <label>
                  VAT
                  <select value={l.vatRateCode} onChange={(e) => upd(i, { vatRateCode: e.target.value as Line["vatRateCode"] })}>
                    {["STD", "RED", "ZERO", "EXEMPT", "OUTSIDE"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                {lines.length > 1 ? (
                  <button type="button" className="link" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
            <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, blank()])}>
              Add line
            </button>
          </fieldset>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Create draft invoice"}
          </button>
        </form>
      ) : null}
      <Loading show={list.loading} />
      {list.data && !list.data.length ? <Empty>No invoices yet.</Empty> : null}
      {list.data?.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Invoices</caption>
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Customer</th>
                <th scope="col">Issued</th>
                <th scope="col">Due</th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((i) => (
                <tr key={i.id}>
                  <td>{i.number}</td>
                  <td>{i.customer_name}</td>
                  <td>{i.issue_date}</td>
                  <td>{i.due_date}</td>
                  <td className="num">{gbp(i.gross_pence)}</td>
                  <td>
                    <Badge value={i.status} />
                  </td>
                  <td className="row">
                    {NEXT[i.status]?.map((s) => (
                      <button key={s} type="button" className="link" onClick={() => setStatus(i.id, s)} aria-label={`Mark ${i.number} ${s}`}>
                        Mark {s}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="link"
                      onClick={() => download(`/v1/invoices/${i.id}/pdf`, `invoice-${i.number}.pdf`)}
                      aria-label={`Download PDF for ${i.number}`}
                    >
                      PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Page>
  );
}
