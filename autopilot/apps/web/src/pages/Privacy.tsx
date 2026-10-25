import { useState } from "react";
import { download, json } from "../api";
import { useLoad } from "../hooks";
import { Empty, ErrorNote, Page } from "../ui";

type Policy = { verified: boolean; notice: string; rules: { data: string; keep: string; erasure: string }[] };
type Consents = { current: { subject: string; purpose: string; granted: boolean; since: string }[] };

export function Privacy() {
  const pol = useLoad(() => json<Policy>("/v1/privacy/retention"));
  const cons = useLoad(() => json<Consents>("/v1/privacy/consents"));
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<string>("");
  const act = async (fn: () => Promise<string>) => {
    setError(null);
    try {
      setResult(await fn());
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <Page title="Privacy (UK GDPR)">
      <ErrorNote error={error ?? pol.error ?? cons.error} />
      {result ? (
        <p role="status" className="note">
          {result}
        </p>
      ) : null}
      <section className="card" aria-labelledby="dsar-h">
        <h2 id="dsar-h">Subject access request</h2>
        <form
          className="row wrap"
          aria-label="Subject access request"
          onSubmit={(e) => {
            e.preventDefault();
            const email = String(new FormData(e.currentTarget).get("email"));
            void act(async () => {
              const r = await json<{ requestId: string; data: Record<string, unknown[] | number> }>("/v1/privacy/dsar", "POST", { email });
              const counts = Object.entries(r.data).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : v}`);
              return `Request ${r.requestId} completed. ${counts.join(", ")}.`;
            });
          }}
        >
          <label>
            Person's email
            <input type="email" name="email" required />
          </label>
          <button type="submit">Find their data</button>
        </form>
      </section>
      <section className="card" aria-labelledby="er-h">
        <h2 id="er-h">Erasure</h2>
        <p className="muted">Removes or pseudonymises personal data. Accounting records and the audit log are kept where the law requires it.</p>
        <form
          className="row wrap"
          aria-label="Erasure request"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(async () => {
              const r = await json<{ retained: string[] }>("/v1/privacy/erasure", "POST", {
                email: String(f.get("email")),
                confirm: f.get("confirm") === "on",
              });
              return `Erased. Retained by law: ${r.retained.join("; ")}`;
            });
          }}
        >
          <label>
            Person's email
            <input type="email" name="email" required />
          </label>
          <label className="check">
            <input type="checkbox" name="confirm" required /> I understand this cannot be undone
          </label>
          <button type="submit" className="danger">
            Erase
          </button>
        </form>
      </section>
      <section className="card" aria-labelledby="ex-h">
        <h2 id="ex-h">Export everything</h2>
        <button type="button" onClick={() => void act(async () => (await download("/v1/privacy/export", "autopilot-export.json"), "Export downloaded."))}>
          Download data export (JSON)
        </button>
      </section>
      <section aria-labelledby="co-h">
        <h2 id="co-h">Consents</h2>
        {cons.data?.current.length ? (
          <ul>
            {cons.data.current.map((c) => (
              <li key={`${c.subject}-${c.purpose}`}>
                {c.subject} · {c.purpose} · {c.granted ? "granted" : "withdrawn"} since {c.since}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No consents recorded.</Empty>
        )}
      </section>
      {pol.data ? (
        <section aria-labelledby="ret-h">
          <h2 id="ret-h">Retention policy {pol.data.verified ? "" : "(unverified placeholder)"}</h2>
          <p className="note warn">{pol.data.notice}</p>
          <ul>
            {pol.data.rules.map((r) => (
              <li key={r.data}>
                <strong>{r.data}</strong>: keep {r.keep}; on erasure {r.erasure}.
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Page>
  );
}
