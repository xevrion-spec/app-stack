import { useState } from "react";
import { json } from "../api";
import { useLoad } from "../hooks";
import { ErrorNote, Loading, Page } from "../ui";

type Ob = { steps: { id: string; title: string; done: boolean; href: string }[]; done: number; total: number; sampleData: boolean };

export function GetStarted({ role }: { role: string }) {
  const ob = useLoad(() => json<Ob>("/v1/onboarding"));
  const [error, setError] = useState<Error | null>(null);
  const [msg, setMsg] = useState("");
  async function sample(method: "POST" | "DELETE") {
    setError(null);
    try {
      const r = await json<{ inserted?: number; removed?: number }>("/v1/onboarding/sample-data", method);
      setMsg(method === "POST" ? `Loaded ${r.inserted} sample transactions.` : `Removed ${r.removed} sample transactions.`);
      await ob.reload();
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <Page title="Get started">
      <ErrorNote error={ob.error ?? error} />
      <Loading show={ob.loading} />
      {msg ? (
        <p role="status" className="note">
          {msg}
        </p>
      ) : null}
      {ob.data ? (
        <>
          <label className="progress-label">
            {ob.data.done} of {ob.data.total} done
            <progress max={ob.data.total} value={ob.data.done} />
          </label>
          <ol className="checklist">
            {ob.data.steps.map((s) => (
              <li key={s.id} className={s.done ? "done" : ""}>
                <span aria-hidden="true">{s.done ? "✓" : "○"}</span> <a href={`#${s.href}`}>{s.title}</a>
                <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
              </li>
            ))}
          </ol>
          {role === "owner" ? (
            <div className="card">
              <h2>Explore with sample data</h2>
              <p className="muted">Clearly labelled synthetic transactions you can remove at any time. Only available on an empty account.</p>
              {ob.data.sampleData ? (
                <button type="button" onClick={() => void sample("DELETE")}>
                  Remove sample data
                </button>
              ) : (
                <button type="button" onClick={() => void sample("POST")}>
                  Load sample data
                </button>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
