import { useState } from "react";
import { ApiError, json } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Loading, Page } from "../ui";

type Firm = { id: string; name: string; plan: string; role: string; clients: number; staff: number };
type Client = {
  tenantId: string;
  name: string;
  awaitingReview: number;
  openQueries: number;
  health: { score: number; status: string; reasons: string[] };
  nextDeadline: { title: string; dueDate: string; daysLeft: number } | null;
};
type Usage = { plan: string; period: string; metrics: { metric: string; used: number; cap: number }[] };
type Integration = { id: string; status: string; note: string };
const MANAGERS = new Set(["partner", "manager"]);

function CreateFirm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        json("/v1/practices", "POST", { name }).then(onDone, setErr);
      }}
    >
      <p>You are not part of an accountancy practice yet. Create one to manage clients.</p>
      <ErrorNote error={err} />
      <label>
        Practice name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </label>
      <button type="submit">Create practice</button>
    </form>
  );
}

/** Invite a client contact. Delivery is a MOCK: the single-use code is shown to staff and never emailed. */
function InvitePortal({ client }: { client: Client }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  return (
    <form
      aria-label={`Invite ${client.name} to the portal`}
      onSubmit={(e) => {
        e.preventDefault();
        json<{ magicToken: string }>(`/v1/practice/clients/${client.tenantId}/portal-users`, "POST", { email }).then((r) => setCode(r.magicToken), setErr);
      }}
    >
      <ErrorNote error={err} />
      <label>
        Client contact email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <button type="submit">Invite</button>
      {code ? (
        <p role="status">
          Mock delivery (nothing was emailed). Single-use portal code, valid 15 minutes: <code>{code}</code>
        </p>
      ) : null}
    </form>
  );
}

function Clients({ role, onChange }: { role: string; onChange: () => void }) {
  const c = useLoad(() => json<{ items: Client[] }>("/v1/practice/clients"));
  const [name, setName] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const items = c.data?.items ?? [];
  return (
    <section aria-labelledby="clients-h">
      <h2 id="clients-h">Clients</h2>
      <ErrorNote error={c.error ?? err} />
      <Loading show={c.loading} />
      {MANAGERS.has(role) ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            json("/v1/practice/clients", "POST", { name }).then(() => {
              setName("");
              void c.reload();
              onChange();
            }, setErr);
          }}
        >
          <label>
            New client name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </label>
          <button type="submit">Add client</button>
        </form>
      ) : null}
      {c.data && !items.length ? <Empty>No clients yet.</Empty> : null}
      {items.length ? (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Clients table">
          <table className="table">
            <caption className="sr-only">Clients with health, review backlog and next deadline</caption>
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Health</th>
                <th scope="col">Awaiting review</th>
                <th scope="col">Open queries</th>
                <th scope="col">Next deadline (unverified)</th>
                {MANAGERS.has(role) ? <th scope="col">Portal</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.tenantId}>
                  <th scope="row">{x.name}</th>
                  <td title={x.health.reasons.join("; ")}>
                    <Badge value={x.health.status} /> {x.health.score}
                  </td>
                  <td>{x.awaitingReview}</td>
                  <td>{x.openQueries}</td>
                  <td>{x.nextDeadline ? `${x.nextDeadline.title}, ${x.nextDeadline.dueDate}` : "—"}</td>
                  {MANAGERS.has(role) ? (
                    <td>
                      {invite === x.tenantId ? (
                        <InvitePortal client={x} />
                      ) : (
                        <button type="button" onClick={() => setInvite(x.tenantId)}>
                          Invite contact
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function Ops() {
  const u = useLoad(() => json<Usage>("/v1/practice/usage"));
  const i = useLoad(() => json<{ items: Integration[] }>("/v1/practice/integrations"));
  return (
    <>
      <section aria-labelledby="usage-h">
        <h2 id="usage-h">Usage this month</h2>
        <p>Plan caps are placeholders. Nothing is billed.</p>
        <ErrorNote error={u.error} />
        <ul>
          {u.data?.metrics.map((m) => (
            <li key={m.metric}>
              {m.metric.replace(/_/g, " ")}: {m.used} / {m.cap}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="int-h">
        <h2 id="int-h">Integrations</h2>
        <ErrorNote error={i.error} />
        <ul>
          {i.data?.items.map((x) => (
            <li key={x.id}>
              {x.id.replace(/_/g, " ")} <Badge value={x.status} />: {x.note}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function Practice() {
  const f = useLoad(() =>
    json<Firm>("/v1/practice").catch((e: unknown) => (e instanceof ApiError && e.status === 403 && e.code === "forbidden" ? null : Promise.reject(e))),
  );
  return (
    <Page title="Practice">
      <ErrorNote error={f.error} />
      <Loading show={f.loading} />
      {!f.loading && !f.error && !f.data ? <CreateFirm onDone={() => void f.reload()} /> : null}
      {f.data ? (
        <>
          <p>
            {f.data.name}: your role is {f.data.role}; {f.data.clients} clients, {f.data.staff} staff.
          </p>
          <Clients role={f.data.role} onChange={() => void f.reload()} />
          <Ops />
        </>
      ) : null}
    </Page>
  );
}
