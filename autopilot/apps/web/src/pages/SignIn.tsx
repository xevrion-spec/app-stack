import { useState } from "react";
import { devUser, isProd, sdk, unwrap } from "../api";
import { ErrorNote, Page } from "../ui";

/** Production: Cloudflare Access protects the app, so an unauthenticated visitor only sees this if the API rejects them. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("demo.owner@example.test");
  if (isProd)
    return (
      <Page title="Sign in">
        <div className="card stack">
          <p>Your session has expired or you do not have access yet.</p>
          <a className="button" href="/cdn-cgi/access/login">
            Sign in with Cloudflare Access
          </a>
        </div>
      </Page>
    );
  return (
    <Page title="Sign in (local development)">
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          devUser.set(email.trim().toLowerCase());
          onSignedIn();
        }}
      >
        <p className="note warn">Local mode: identity is a dev header. Production uses Cloudflare Access only.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <button type="submit">Continue</button>
      </form>
    </Page>
  );
}

export function Onboarding({ onCreated }: { onCreated: () => void }) {
  const [error, setError] = useState<Error | null>(null);
  return (
    <Page title="Set up your business">
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setError(null);
          try {
            unwrap(
              await sdk().POST("/v1/tenants", {
                body: {
                  name: String(f.get("name")),
                  vatRegistered: f.get("vat") === "on",
                  vatScheme: f.get("vat") === "on" ? "standard" : null,
                  flatRatePercent: null,
                },
              }),
            );
            onCreated();
          } catch (err) {
            setError(err as Error);
          }
        }}
      >
        <label>
          Trading name
          <input name="name" required maxLength={120} />
        </label>
        <label className="check">
          <input type="checkbox" name="vat" /> VAT registered (standard scheme; change later in Settings)
        </label>
        <button type="submit">Create</button>
        <ErrorNote error={error} />
      </form>
    </Page>
  );
}
