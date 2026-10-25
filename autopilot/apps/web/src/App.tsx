import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, devUser, isProd, sdk, unwrap, type Schemas } from "./api";
import { Exceptions } from "./pages/Exceptions";
import { Invoices } from "./pages/Invoices";
import { Jobs } from "./pages/Jobs";
import { Settings } from "./pages/Settings";
import { Onboarding, SignIn } from "./pages/SignIn";
import { Transactions } from "./pages/Transactions";
import { Upload } from "./pages/Upload";
import { Vat } from "./pages/Vat";
import { ErrorNote, Loading } from "./ui";

const ROUTES = [
  ["review", "Review queue"],
  ["transactions", "Transactions"],
  ["upload", "Upload"],
  ["invoices", "Invoices"],
  ["vat", "VAT & SA"],
  ["jobs", "Jobs"],
  ["settings", "Settings"],
] as const;
type Route = (typeof ROUTES)[number][0];

function readHash(): { route: Route; arg: string | null } {
  const [r, arg] = location.hash.replace(/^#\/?/, "").split("/");
  const route = (ROUTES.find(([k]) => k === r)?.[0] ?? "review") as Route;
  return { route, arg: arg ?? null };
}

type Session =
  { state: "loading" } | { state: "signed_out" } | { state: "onboarding" } | { state: "error"; error: Error } | { state: "ready"; me: Schemas["Me"] };

export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [{ route, arg }, setLoc] = useState(readHash);
  const main = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    if (!isProd && !devUser.get()) return setSession({ state: "signed_out" });
    try {
      setSession({ state: "ready", me: unwrap(await sdk().GET("/v1/me")) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "no_membership") setSession({ state: "onboarding" });
      else if (e instanceof ApiError && e.status === 401) setSession({ state: "signed_out" });
      else setSession({ state: "error", error: e as Error });
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onHash = () => setLoc(readHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [refresh]);
  // Move focus to the page heading on navigation so screen readers announce the new page.
  useEffect(() => {
    main.current?.querySelector<HTMLElement>("#page-title")?.focus();
  }, [route, session.state]);

  const go = (r: Route, a?: string | null) => {
    location.hash = `#/${r}${a ? `/${a}` : ""}`;
  };

  let body: React.ReactNode;
  if (session.state === "loading") body = <Loading show />;
  else if (session.state === "signed_out") body = <SignIn onSignedIn={refresh} />;
  else if (session.state === "onboarding") body = <Onboarding onCreated={refresh} />;
  else if (session.state === "error") body = <ErrorNote error={session.error} />;
  else {
    const role = session.me.role;
    body = {
      review: <Exceptions role={role} />,
      transactions: <Transactions />,
      upload: <Upload onDone={(id) => go("jobs", id)} />,
      invoices: <Invoices />,
      vat: <Vat />,
      jobs: <Jobs selected={arg} onSelect={(id) => go("jobs", id)} />,
      settings: <Settings role={role} />,
    }[route];
  }
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <span className="brand">Autopilot</span>
        {session.state === "ready" ? (
          <nav aria-label="Main">
            <ul>
              {ROUTES.map(([k, label]) => (
                <li key={k}>
                  <a href={`#/${k}`} aria-current={route === k ? "page" : undefined}>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        {session.state === "ready" ? (
          <span className="who">
            {session.me.email} · {session.me.role}
            {!isProd ? (
              <button
                type="button"
                className="link"
                onClick={() => {
                  devUser.set(null);
                  void refresh();
                }}
              >
                Sign out
              </button>
            ) : null}
          </span>
        ) : null}
      </header>
      <main id="main" ref={main}>
        {body}
      </main>
      <footer className="foot muted">Xevrion Autopilot · drafts only, nothing is submitted to HMRC</footer>
    </>
  );
}
