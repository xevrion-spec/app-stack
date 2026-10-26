import { useState } from "react";
import { apiBase } from "../api";
import { ErrorNote, Page } from "../ui";

/**
 * One-click review action from a notification (R1). Opening the link never decides: the reviewer confirms here,
 * which POSTs the signed token. The token itself is the credential (single use, bound to one reviewer, expires).
 */
function claims(token: string): { d?: string; rid?: string; exp?: number } {
  try {
    return JSON.parse(atob((token.split(".")[0] ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as { d?: string; rid?: string; exp?: number };
  } catch {
    return {};
  }
}

export function ActConfirm({ token }: { token: string }) {
  const c = claims(token);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "busy" } | { kind: "done"; text: string } | { kind: "error"; error: Error }>({ kind: "idle" });
  const verb = c.d === "reject" ? "Reject" : c.d === "approve" ? "Approve" : null;
  async function confirm() {
    setState({ kind: "busy" });
    try {
      const res = await fetch(`${apiBase}/notify/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...(reason ? { reason } : {}) }),
      });
      const body = (await res.json()) as { status?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
      setState({ kind: "done", text: `Done. The request is now ${body.status}.` });
    } catch (e) {
      setState({ kind: "error", error: e as Error });
    }
  }
  if (!verb)
    return (
      <Page title="Review action">
        <ErrorNote error={new Error("This action link is not valid.")} />
      </Page>
    );
  return (
    <Page title={`${verb} this agent request?`}>
      <p>
        Request <code>{c.rid}</code>. This link works once and only for you.
      </p>
      {state.kind === "done" ? (
        <p role="status">{state.text}</p>
      ) : (
        <form
          aria-label="Confirm review action"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <label className="block">
            Reason {c.d === "reject" ? "(recommended)" : "(optional)"}
            <textarea value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="submit" className={c.d === "reject" ? "danger" : "primary"} disabled={state.kind === "busy"}>
            Confirm {verb.toLowerCase()}
          </button>
        </form>
      )}
      {state.kind === "error" ? <ErrorNote error={state.error} /> : null}
    </Page>
  );
}
