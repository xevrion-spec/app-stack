import { useState } from "react";
import { json } from "../api";
import { useLoad } from "../hooks";
import { ErrorNote, Page } from "../ui";

type Answer = { intent: string; answer: string; grounded: boolean; citations: { type: string; id: string; label: string }[]; suggestions?: string[] };

export function Assistant() {
  const sugg = useLoad(() => json<string[]>("/v1/assistant/suggestions"));
  const [a, setA] = useState<Answer | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function ask(question: string) {
    setQ(question);
    setBusy(true);
    setError(null);
    try {
      setA(await json<Answer>("/v1/assistant/ask", "POST", { question }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title="Ask your books">
      <p className="muted">Answers are calculated from your own records and show where each figure came from. Tax figures are unverified estimates.</p>
      <form
        className="card row"
        aria-label="Ask a question"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) void ask(q.trim());
        }}
      >
        <label className="grow">
          Question
          <input name="q" value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} placeholder="How much did I spend on travel last month?" />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>
      <ErrorNote error={error ?? sugg.error} />
      <div aria-live="polite">
        {a ? (
          <section className="card" aria-label="Answer">
            <p className="big">{a.answer}</p>
            {a.citations.length ? (
              <>
                <h2>Sources</h2>
                <ul>
                  {a.citations.map((c) => (
                    <li key={`${c.type}-${c.id}`}>
                      <span className="badge">{c.type}</span> {c.label}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        ) : null}
      </div>
      <h2>Try asking</h2>
      <ul className="chips">
        {(a?.suggestions ?? sugg.data ?? []).map((s) => (
          <li key={s}>
            <button type="button" className="chip" onClick={() => void ask(s)}>
              {s}
            </button>
          </li>
        ))}
      </ul>
    </Page>
  );
}
