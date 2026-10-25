import { useState } from "react";
import { download, gbp, sdk, unwrap, type Schemas } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Loading, Page } from "../ui";

type Txn = Schemas["Transaction"];
const STATUSES = ["", "needs_review", "categorised", "reconciled", "new"] as const;

export function Transactions() {
  const [status, setStatus] = useState<string>("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const cats = useLoad(async () => unwrap(await sdk().GET("/v1/categories")));
  const page = useLoad(
    async () =>
      unwrap(await sdk().GET("/v1/transactions", { params: { query: { limit: 25, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) } as never } })),
    [status, cursor],
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  async function categorise(t: Txn, form: FormData) {
    setError(null);
    try {
      const updated = unwrap(
        await sdk().PATCH("/v1/transactions/{id}", {
          params: { path: { id: t.id } },
          body: {
            categoryCode: String(form.get("category")),
            vatRateCode: (String(form.get("vat")) || null) as never,
            vatPence: Math.round(Number(form.get("vatPounds") || 0) * 100),
            createRule: form.get("rule") === "on",
          },
        }),
      );
      page.setData((p) => (p ? { ...p, items: p.items.map((x) => (x.id === t.id ? updated : x)) } : p));
      setEditing(null);
    } catch (e) {
      setError(e as Error);
    }
  }
  const catName = (code: string | null) => cats.data?.find((c) => c.code === code)?.name ?? code ?? "—";

  return (
    <Page
      title="Transactions"
      actions={
        <div className="row">
          <label>
            Status{" "}
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setCursor(undefined);
                setHistory([]);
              }}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s ? s.replace("_", " ") : "All"}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="secondary" onClick={() => download("/v1/export/transactions.csv", "transactions.csv")}>
            Export CSV
          </button>
        </div>
      }
    >
      <ErrorNote error={page.error ?? error} />
      <Loading show={page.loading} />
      {page.data && !page.data.items.length ? <Empty>No transactions yet. Upload a bank statement to begin.</Empty> : null}
      {page.data?.items.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Bank transactions</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Description</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Category</th>
                <th scope="col" className="num">
                  VAT
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((t) => (
                <tr key={t.id}>
                  <td>{t.txn_date}</td>
                  <td>{t.description}</td>
                  <td className={`num ${t.amount_pence < 0 ? "neg" : "pos"}`}>{gbp(t.amount_pence)}</td>
                  <td>
                    {editing === t.id ? (
                      <form
                        className="inline-form"
                        aria-label={`Categorise ${t.description}`}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void categorise(t, new FormData(e.currentTarget));
                        }}
                      >
                        <label className="sr-only" htmlFor={`cat-${t.id}`}>
                          Category
                        </label>
                        <select id={`cat-${t.id}`} name="category" defaultValue={t.category_code ?? ""} required>
                          {cats.data?.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code} {c.name}
                            </option>
                          ))}
                        </select>
                        <label className="sr-only" htmlFor={`vat-${t.id}`}>
                          VAT rate
                        </label>
                        <select id={`vat-${t.id}`} name="vat" defaultValue={t.vat_rate_code ?? ""}>
                          <option value="">No VAT</option>
                          {["STD", "RED", "ZERO", "EXEMPT", "OUTSIDE"].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                        <label className="sr-only" htmlFor={`vp-${t.id}`}>
                          VAT amount (£)
                        </label>
                        <input
                          id={`vp-${t.id}`}
                          name="vatPounds"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="VAT £"
                          defaultValue={t.vat_pence ? t.vat_pence / 100 : ""}
                        />
                        <label>
                          <input type="checkbox" name="rule" /> Remember as rule
                        </label>
                        <button type="submit">Save</button>
                        <button type="button" className="secondary" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      catName(t.category_code)
                    )}
                  </td>
                  <td className="num">{gbp(t.vat_pence)}</td>
                  <td>
                    <Badge value={t.status} />
                  </td>
                  <td>
                    {editing !== t.id ? (
                      <button type="button" className="link" onClick={() => setEditing(t.id)} aria-label={`Categorise ${t.description}`}>
                        Categorise
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <nav className="row pager" aria-label="Pagination">
        <button
          type="button"
          className="secondary"
          disabled={!history.length}
          onClick={() => {
            const h = [...history];
            setCursor(h.pop());
            setHistory(h);
          }}
        >
          Previous
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!page.data?.nextCursor}
          onClick={() => {
            setHistory([...history, cursor]);
            setCursor(page.data?.nextCursor ?? undefined);
          }}
        >
          Next
        </button>
      </nav>
    </Page>
  );
}
