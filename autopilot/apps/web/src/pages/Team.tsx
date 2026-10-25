import { useState } from "react";
import { json } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Page } from "../ui";

type Notif = { id: string; title: string; body: string | null; read_at: string | null; created_at: string };
type Close = { id: string; period_start: string; period_end: string; status: string; requested_by: string; decided_by: string | null };

export function Team({ email, role }: { email: string; role: string }) {
  const canSign = role === "owner" || role === "accountant";
  const notes = useLoad(() => json<{ unreadCount: number; items: Notif[] }>("/v1/notifications"));
  const closes = useLoad(() => json<Close[]>("/v1/periods/closes"));
  const [error, setError] = useState<Error | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([notes.reload(), closes.reload()]);
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <Page title="Team & month-end close">
      <ErrorNote error={error ?? notes.error ?? closes.error} />
      <section aria-labelledby="n-h">
        <div className="row">
          <h2 id="n-h">Notifications {notes.data ? `(${notes.data.unreadCount} unread)` : ""}</h2>
          <button type="button" className="link" onClick={() => void act(() => json("/v1/notifications/read-all", "POST", {}))}>
            Mark all read
          </button>
        </div>
        {notes.data?.items.length ? (
          <ul className="list">
            {notes.data.items.map((n) => (
              <li key={n.id} className={n.read_at ? "muted" : ""}>
                <strong>{n.title}</strong> {n.body}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No notifications.</Empty>
        )}
      </section>
      <section aria-labelledby="c-h">
        <h2 id="c-h">Period close (needs a second person to approve)</h2>
        <form
          className="card row wrap"
          aria-label="Request period close"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(() => json("/v1/periods/closes", "POST", { periodStart: String(f.get("start")), periodEnd: String(f.get("end")) }));
          }}
        >
          <label>
            Start
            <input type="date" name="start" required />
          </label>
          <label>
            End
            <input type="date" name="end" required />
          </label>
          <button type="submit">Request close</button>
        </form>
        {closes.data?.length ? (
          <table className="table">
            <caption className="sr-only">Period closes</caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Status</th>
                <th scope="col">Requested by</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {closes.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.period_start} to {c.period_end}
                  </td>
                  <td>
                    <Badge value={c.status} />
                  </td>
                  <td>{c.requested_by}</td>
                  <td>
                    {canSign && c.status === "requested" && c.requested_by.toLowerCase() !== email.toLowerCase() ? (
                      <>
                        <button type="button" onClick={() => void act(() => json(`/v1/periods/closes/${c.id}/decision`, "POST", { decision: "approve" }))}>
                          Approve
                        </button>{" "}
                        <button
                          type="button"
                          className="link"
                          onClick={() => void act(() => json(`/v1/periods/closes/${c.id}/decision`, "POST", { decision: "reject" }))}
                        >
                          Reject
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No closes yet.</Empty>
        )}
      </section>
    </Page>
  );
}
