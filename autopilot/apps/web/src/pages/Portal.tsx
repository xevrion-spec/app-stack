import { useCallback, useEffect, useState } from "react";
import { ApiError, apiBase } from "../api";
import { Badge, Empty, ErrorNote, Page } from "../ui";

/** Client portal. Separate auth from staff: a single-use code is exchanged for an 8-hour session token (kept in
 * sessionStorage, sent as a Bearer header). Code delivery is a MOCK: staff read the code out; nothing is emailed. */
const KEY = "autopilot.portalSession";
type Me = { business: string; practice: string; email: string };
type DocReq = { id: string; title: string; dueDate: string | null; status: string; overdue: boolean };
type Query = { id: string; question: string; status: string; answer: string | null };
type Letter = { id: string; services: string[]; feeSummary: string; letterText: string; letterSha256: string; status: string };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const s = sessionStorage.getItem(KEY);
  if (s) headers.set("authorization", `Bearer ${s}`);
  if (init.method && init.method !== "GET") headers.set("idempotency-key", crypto.randomUUID());
  const res = await fetch(apiBase + path, { ...init, headers });
  const j = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok) throw new ApiError(res.status, j?.error?.code ?? "http_error", j?.error?.message ?? `Request failed (${res.status})`);
  return j as T;
}
const post = <T,>(path: string, body: unknown) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

function SignInWithCode({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        post<{ sessionToken: string }>("/v1/portal/session", { token: token.trim() }).then((r) => {
          sessionStorage.setItem(KEY, r.sessionToken);
          onSignedIn();
        }, setErr);
      }}
    >
      <p>Enter the single-use code your accountant gave you.</p>
      <ErrorNote error={err} />
      <label>
        Portal code
        <input value={token} onChange={(e) => setToken(e.target.value)} required minLength={10} autoComplete="one-time-code" />
      </label>
      <button type="submit">Open portal</button>
    </form>
  );
}

function Answer({ q, onDone }: { q: Query; onDone: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        post(`/v1/portal/queries/${q.id}/answer`, { answer: text }).then(onDone, setErr);
      }}
    >
      <ErrorNote error={err} />
      <label>
        Your answer
        <textarea value={text} onChange={(e) => setText(e.target.value)} required maxLength={4000} />
      </label>
      <button type="submit">Send answer</button>
    </form>
  );
}

function Upload({ r, onDone }: { r: DocReq; onDone: () => void }) {
  const [err, setErr] = useState<Error | null>(null);
  return (
    <label>
      Upload for {r.title}
      <input
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f)
            call(`/v1/portal/document-requests/${r.id}/upload`, {
              method: "POST",
              body: f,
              headers: { "content-type": f.type || "application/octet-stream" },
            }).then(onDone, setErr);
        }}
      />
      <ErrorNote error={err} />
    </label>
  );
}

function Home({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [data, setData] = useState<{ d: DocReq[]; q: Query[]; l: Letter[] } | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const load = useCallback(() => {
    Promise.all([
      call<{ items: DocReq[] }>("/v1/portal/document-requests"),
      call<{ items: Query[] }>("/v1/portal/queries"),
      call<{ items: Letter[] }>("/v1/portal/engagements"),
    ]).then(([d, q, l]) => setData({ d: d.items, q: q.items, l: l.items }), setErr);
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <p>
        {me.business}, with {me.practice}. Signed in as {me.email}.{" "}
        <button type="button" onClick={() => void post("/v1/portal/logout", {}).finally(onSignOut)}>
          Sign out
        </button>
      </p>
      <ErrorNote error={err} />
      <h2>Documents requested</h2>
      {data && !data.d.length ? <Empty>Nothing requested.</Empty> : null}
      <ul>
        {data?.d.map((r) => (
          <li key={r.id}>
            {r.title} <Badge value={r.overdue ? "overdue" : r.status} /> {r.dueDate ? `due ${r.dueDate}` : ""}
            {r.status === "open" ? <Upload r={r} onDone={load} /> : null}
          </li>
        ))}
      </ul>
      <h2>Questions from your accountant</h2>
      {data && !data.q.length ? <Empty>No questions.</Empty> : null}
      <ul>
        {data?.q.map((q) => (
          <li key={q.id}>
            <p>{q.question}</p>
            {q.status === "open" ? <Answer q={q} onDone={load} /> : <p>Your answer: {q.answer}</p>}
          </li>
        ))}
      </ul>
      <h2>Engagement letters</h2>
      {data && !data.l.length ? <Empty>No letters.</Empty> : null}
      {data?.l.map((l) => (
        <article key={l.id} aria-label={`Engagement letter: ${l.services.join(", ")}`}>
          <p>
            {l.services.join(", ")}: {l.feeSummary} <Badge value={l.status} />
          </p>
          <pre>{l.letterText}</pre>
          {l.status === "sent" ? (
            <button type="button" onClick={() => void post(`/v1/portal/engagements/${l.id}/accept`, { letterSha256: l.letterSha256 }).then(load, setErr)}>
              I have read and accept this letter
            </button>
          ) : null}
        </article>
      ))}
    </>
  );
}

export function Portal() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const refresh = useCallback(() => {
    if (!sessionStorage.getItem(KEY)) return setChecked(true);
    call<Me>("/v1/portal/me")
      .then(setMe, () => sessionStorage.removeItem(KEY))
      .finally(() => setChecked(true));
  }, []);
  useEffect(refresh, [refresh]);
  return (
    <Page title="Client portal">
      {checked && !me ? <SignInWithCode onSignedIn={refresh} /> : null}
      {me ? (
        <Home
          me={me}
          onSignOut={() => {
            sessionStorage.removeItem(KEY);
            setMe(null);
          }}
        />
      ) : null}
    </Page>
  );
}
