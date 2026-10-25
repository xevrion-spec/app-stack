import { useState } from "react";
import { gbp, sdk, unwrap, type Schemas } from "../api";
import { useLoad } from "../hooks";
import { DraftBanner, Empty, ErrorNote, Loading, Page } from "../ui";

const BOXES: [keyof Schemas["VatDraft"], string][] = [
  ["box1", "1 VAT due on sales"],
  ["box2", "2 VAT due on EU acquisitions"],
  ["box3", "3 Total VAT due"],
  ["box4", "4 VAT reclaimed on purchases"],
  ["box5", "5 Net VAT to pay / reclaim"],
  ["box6", "6 Sales ex VAT"],
  ["box7", "7 Purchases ex VAT"],
  ["box8", "8 Supplies to EU"],
  ["box9", "9 Acquisitions from EU"],
];
function quarter() {
  const d = new Date();
  const q = Math.floor(d.getUTCMonth() / 3);
  const start = new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)] as const;
}

export function Vat() {
  const drafts = useLoad(async () => unwrap(await sdk().GET("/v1/vat/drafts")));
  const sa = useLoad(async () => unwrap(await sdk().GET("/v1/sa/summary")));
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [qs, qe] = quarter();
  const current = drafts.data?.[0];

  async function compute(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const scheme = String(f.get("scheme") || "");
      const d = unwrap(
        await sdk().POST("/v1/vat/drafts", {
          body: { periodStart: String(f.get("start")), periodEnd: String(f.get("end")), ...(scheme ? { scheme: scheme as "standard" } : {}) },
        }),
      );
      drafts.setData((l) => [d, ...(l ?? [])]);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title="VAT & Self Assessment">
      <DraftBanner />
      <form className="card row wrap" onSubmit={compute} aria-label="Compute VAT draft">
        <label>
          Period start
          <input type="date" name="start" defaultValue={qs} required />
        </label>
        <label>
          Period end
          <input type="date" name="end" defaultValue={qe} required />
        </label>
        <label>
          Scheme
          <select name="scheme" defaultValue="">
            <option value="">Tenant default</option>
            <option value="standard">Standard (accrual)</option>
            <option value="cash">Cash accounting</option>
            <option value="flat_rate">Flat rate</option>
          </select>
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Computing…" : "Compute draft"}
        </button>
      </form>
      <ErrorNote error={drafts.error ?? error} />
      <Loading show={drafts.loading} />
      {drafts.data && !current ? <Empty>No VAT drafts yet.</Empty> : null}
      {current ? (
        <div className="card">
          <h2>
            {current.periodStart} to {current.periodEnd} · {current.scheme.replace("_", " ")} · <span className="badge b-draft">draft, unverified</span>
          </h2>
          <dl className="boxes">
            {BOXES.map(([k, label]) => (
              <div key={k} className={k === "box5" ? "box hl" : "box"}>
                <dt>Box {label}</dt>
                <dd>{gbp(current[k] as number)}</dd>
              </div>
            ))}
          </dl>
          <ul className="muted">
            {current.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <h2>Self Assessment (current tax year)</h2>
      <ErrorNote error={sa.error} />
      {sa.data ? (
        <div className="card">
          <dl className="boxes">
            <div className="box">
              <dt>Turnover</dt>
              <dd>{gbp(sa.data.turnoverPence)}</dd>
            </div>
            <div className="box">
              <dt>Allowable expenses</dt>
              <dd>{gbp(sa.data.allowableExpensesPence)}</dd>
            </div>
            <div className="box hl">
              <dt>Profit</dt>
              <dd>{gbp(sa.data.profitPence)}</dd>
            </div>
          </dl>
          <ul className="muted">
            {sa.data.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Page>
  );
}
