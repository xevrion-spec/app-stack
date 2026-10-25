import type { ReactNode } from "react";
import { ApiError } from "./api";

export function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="note error">
      <strong>{error.message}</strong>
      {error instanceof ApiError && error.requestId ? <small> (request {error.requestId})</small> : null}
    </div>
  );
}
export function Loading({ show }: { show: boolean }) {
  return show ? (
    <p className="muted" role="status" aria-live="polite">
      Loading…
    </p>
  ) : null;
}
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby="page-title">
      <header className="page-head">
        <h1 id="page-title" tabIndex={-1}>
          {title}
        </h1>
        {actions}
      </header>
      {children}
    </section>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
export function Badge({ value }: { value: string | null | undefined }) {
  return <span className={`badge b-${(value ?? "none").replace(/[^a-z_]/gi, "")}`}>{(value ?? "—").replace(/_/g, " ")}</span>;
}
export function DraftBanner() {
  return (
    <p className="note warn" role="note">
      Draft only. VAT and tax figures use <strong>unverified</strong> placeholder rules and are never submitted to HMRC. Not tax advice.
    </p>
  );
}
