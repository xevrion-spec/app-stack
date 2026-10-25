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
import { Reports } from "./pages/Reports";
import { Assistant } from "./pages/Assistant";
import { GetStarted } from "./pages/GetStarted";
import { Receivables } from "./pages/Receivables";
import { Team } from "./pages/Team";
import { Banking } from "./pages/Banking";
import { Privacy } from "./pages/Privacy";
import { Ops } from "./pages/Ops";
import { Practice } from "./pages/Practice";
import { Portal } from "./pages/Portal";
import { CommandPalette, type Command } from "./CommandPalette";
import { t, type MessageKey } from "./i18n";
import { applyTheme, getTheme, nextTheme, type Theme } from "./theme";

const ROUTES = [
  ["start", "nav.start"],
  ["review", "nav.review"],
  ["transactions", "nav.transactions"],
  ["upload", "nav.upload"],
  ["invoices", "nav.invoices"],
  ["receivables", "nav.receivables"],
  ["reports", "nav.reports"],
  ["vat", "nav.vat"],
  ["assistant", "nav.assistant"],
  ["practice", "nav.practice"],
  ["team", "nav.team"],
  ["banking", "nav.banking"],
  ["privacy", "nav.privacy"],
  ["ops", "nav.ops"],
  ["jobs", "nav.jobs"],
  ["settings", "nav.settings"],
] as const satisfies readonly (readonly [string, MessageKey])[];
/** Pages an owner sees but a reviewer/accountant does not (the API enforces this too). */
const OWNER_ONLY = new Set<string>(["banking", "privacy"]);
type Route = (typeof ROUTES)[number][0];

/** The client portal has its own auth and never shows the staff navigation. */
const isPortal = () => location.hash.replace(/^#\/?/, "").startsWith("portal");

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
  const [portal, setPortal] = useState(isPortal);
  const main = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState<Theme>(getTheme);
  useEffect(() => applyTheme(theme), [theme]);

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
    const onHash = () => {
      setLoc(readHash());
      setPortal(isPortal());
    };
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
  if (portal) body = <Portal />;
  else if (session.state === "loading") body = <Loading show />;
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
      start: <GetStarted role={role} />,
      receivables: <Receivables role={role} />,
      reports: <Reports />,
      assistant: <Assistant />,
      team: <Team email={session.me.email} role={role} />,
      banking: <Banking />,
      privacy: <Privacy />,
      ops: <Ops />,
      practice: <Practice clientId={arg} />,
    }[route];
  }
  const visible = ROUTES.filter(([k]) => session.state !== "ready" || session.me.role === "owner" || !OWNER_ONLY.has(k));
  const commands: Command[] = [
    ...visible.map(([k, key]) => ({ id: `go-${k}`, label: t(key), hint: "Go to", run: () => go(k) })),
    { id: "theme", label: `${t("theme.label")}: ${t(`theme.${nextTheme(theme)}`)}`, hint: "Switch", run: () => setTheme(nextTheme(theme)) },
  ];
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <span className="brand">Autopilot</span>
        {session.state === "ready" && !portal ? (
          <nav aria-label="Main">
            <ul>
              {visible.map(([k, key]) => (
                <li key={k}>
                  <a href={`#/${k}`} aria-current={route === k ? "page" : undefined}>
                    {t(key)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <button
          type="button"
          className="link"
          aria-label={`${t("theme.label")}: ${t(`theme.${theme}`)}`}
          title={`${t("theme.label")}: ${t(`theme.${theme}`)}`}
          onClick={() => setTheme(nextTheme(theme))}
        >
          {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
        </button>
        {session.state === "ready" && !portal ? (
          <button
            type="button"
            className="link kbd"
            aria-label={t("palette.open")}
            onClick={() => dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))}
          >
            Ctrl K
          </button>
        ) : null}
        {session.state === "ready" && !portal ? (
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
      <footer className="foot muted">{t("footer")}</footer>
      {session.state === "ready" && !portal ? <CommandPalette commands={commands} /> : null}
    </>
  );
}
