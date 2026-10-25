import { useState } from "react";
import { sdk, unwrap } from "../api";
import { useLoad } from "../hooks";
import { ErrorNote, Loading, Page } from "../ui";

export function Settings({ role }: { role: string }) {
  const tenant = useLoad(async () => unwrap(await sdk().GET("/v1/tenant")));
  const users = useLoad(async () => unwrap(await sdk().GET("/v1/users")));
  const rules = useLoad(async () => unwrap(await sdk().GET("/v1/rules")));
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState("");
  const owner = role === "owner";

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setSaved("");
    const scheme = String(f.get("scheme") || "");
    const pct = String(f.get("flat") || "");
    try {
      const t = unwrap(
        await sdk().PATCH("/v1/tenant", {
          body: {
            name: String(f.get("name")),
            vatRegistered: f.get("vatRegistered") === "on",
            vatScheme: (scheme || null) as "standard" | null,
            flatRatePercent: pct ? Number(pct) : null,
          },
        }),
      );
      tenant.setData(t);
      setSaved("Settings saved.");
    } catch (err) {
      setError(err as Error);
    }
  }
  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    try {
      const u = unwrap(await sdk().POST("/v1/users", { body: { email: String(f.get("email")), role: String(f.get("role")) as "reviewer" } }));
      users.setData((l) => [...(l ?? []), u]);
      form.reset();
      setSaved(`Added ${u.email} (no email is sent; they sign in through Cloudflare Access).`);
    } catch (err) {
      setError(err as Error);
    }
  }
  return (
    <Page title="Settings">
      <ErrorNote error={tenant.error ?? error} />
      <p role="status" aria-live="polite" className="ok-text">
        {saved}
      </p>
      <Loading show={tenant.loading} />
      {tenant.data ? (
        <form className="card stack" onSubmit={save} aria-label="Business settings">
          <h2>Business</h2>
          <fieldset disabled={!owner} className="grid2">
            <label>
              Trading name
              <input name="name" defaultValue={tenant.data.name} required maxLength={120} />
            </label>
            <label className="check">
              <input type="checkbox" name="vatRegistered" defaultChecked={!!tenant.data.vat_registered} /> VAT registered
            </label>
            <label>
              VAT scheme
              <select name="scheme" defaultValue={tenant.data.vat_scheme ?? ""}>
                <option value="">Not set</option>
                <option value="standard">Standard</option>
                <option value="cash">Cash accounting</option>
                <option value="flat_rate">Flat rate</option>
              </select>
            </label>
            <label>
              Flat rate % (flat-rate scheme only)
              <input name="flat" type="number" min="0.1" max="99" step="0.1" defaultValue={tenant.data.flat_rate_percent ?? ""} />
            </label>
          </fieldset>
          {owner ? <button type="submit">Save</button> : <p className="muted">Only owners can change settings.</p>}
        </form>
      ) : null}
      <div className="card">
        <h2>People</h2>
        <ErrorNote error={users.error} />
        <ul>
          {users.data?.map((u) => (
            <li key={u.id}>
              {u.email} <span className="muted">({u.role})</span>
            </li>
          ))}
        </ul>
        {owner ? (
          <form className="row wrap" onSubmit={invite} aria-label="Add person">
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              Role
              <select name="role" defaultValue="reviewer">
                <option value="reviewer">Accountant / reviewer</option>
                <option value="owner">Owner</option>
              </select>
            </label>
            <button type="submit">Add</button>
          </form>
        ) : null}
      </div>
      <div className="card">
        <h2>Categorisation rules</h2>
        <p className="muted">Rules run before AI. Create them from a transaction with “Remember as rule”.</p>
        <ul>
          {rules.data?.slice(0, 50).map((r) => (
            <li key={r.id}>
              <code>{r.pattern}</code> ({r.match_type}) → {r.category_code}
            </li>
          ))}
        </ul>
      </div>
    </Page>
  );
}
