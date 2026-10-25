import { useState } from "react";
import { download, json } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Loading, Page } from "../ui";

/** Staff workspace for one client: engagement letters, document requests, client queries, working papers (four-eyes). */
type Engagement = { id: string; services: string[]; feeSummary: string; status: string; letterSha256: string; acceptedAt: string | null };
type DocReq = { id: string; tenantId: string; title: string; dueDate: string | null; status: string; overdue: boolean; sha256: string | null };
type Paper = {
  id: string;
  kind: string;
  periodEnd: string;
  status: string;
  snapshotSha256: string;
  integrityOk: boolean;
  changedSinceSnapshot: boolean;
  preparedBy: string;
  signedBy: string | null;
};
type Query = { id: string; tenantId: string; question: string; status: string; answer: string | null };
type Props = { tenantId: string; me: string; role: string };
const SERVICES = ["bookkeeping", "vat_returns", "mtd_itsa", "self_assessment", "year_end_accounts", "payroll", "management_accounts", "advisory"] as const;
const WRITERS = new Set(["partner", "manager", "preparer"]);
const SIGNERS = new Set(["partner", "manager", "reviewer"]);
const label = (s: string) => s.replace(/_/g, " ");

function Engagements({ tenantId, role }: Omit<Props, "me">) {
  const l = useLoad(() => json<{ items: Engagement[] }>(`/v1/practice/clients/${tenantId}/engagements`), [tenantId]);
  const [services, setServices] = useState<string[]>(["bookkeeping"]);
  const [fee, setFee] = useState("");
  const [text, setText] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  const act = (p: Promise<unknown>) => p.then(() => void l.reload(), setErr);
  const manager = role === "partner" || role === "manager";
  return (
    <section aria-labelledby="eng-h">
      <h2 id="eng-h">Engagement letters</h2>
      <ErrorNote error={l.error ?? err} />
      {manager ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(json(`/v1/practice/clients/${tenantId}/engagements`, "POST", { services, feeSummary: fee, letterText: text }));
          }}
        >
          <fieldset>
            <legend>Services</legend>
            {SERVICES.map((s) => (
              <label key={s} className="check">
                <input
                  type="checkbox"
                  checked={services.includes(s)}
                  onChange={(e) => setServices(e.target.checked ? [...services, s] : services.filter((x) => x !== s))}
                />
                {label(s)}
              </label>
            ))}
          </fieldset>
          <label>
            Fee summary
            <input value={fee} onChange={(e) => setFee(e.target.value)} required maxLength={500} />
          </label>
          <label>
            Letter text
            <textarea value={text} onChange={(e) => setText(e.target.value)} required minLength={20} maxLength={50000} />
          </label>
          <button type="submit">Create draft letter</button>
        </form>
      ) : null}
      {l.data && !l.data.items.length ? <Empty>No engagement letters.</Empty> : null}
      <ul>
        {l.data?.items.map((x) => (
          <li key={x.id}>
            {x.services.map(label).join(", ")}: {x.feeSummary} <Badge value={x.status} />{" "}
            <code title="sha256 of the letter text">{x.letterSha256.slice(0, 12)}</code>
            {manager && x.status === "draft" ? (
              <button type="button" onClick={() => act(json(`/v1/practice/engagements/${x.id}/send`, "POST"))}>
                Send to client
              </button>
            ) : null}
            {manager && (x.status === "draft" || x.status === "sent") ? (
              <button type="button" onClick={() => act(json(`/v1/practice/engagements/${x.id}/withdraw`, "POST"))}>
                Withdraw
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DocumentRequests({ tenantId, role }: Omit<Props, "me">) {
  const l = useLoad(() => json<{ items: DocReq[] }>("/v1/practice/document-requests"), [tenantId]);
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("");
  const [due, setDue] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  const items = (l.data?.items ?? []).filter((r) => r.tenantId === tenantId);
  const act = (p: Promise<unknown>) => p.then(() => void l.reload(), setErr);
  return (
    <section aria-labelledby="docs-h">
      <h2 id="docs-h">Document requests</h2>
      <ErrorNote error={l.error ?? err} />
      {WRITERS.has(role) ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(
              json(`/v1/practice/clients/${tenantId}/document-requests`, "POST", {
                titles: title ? [title] : [],
                ...(template ? { template } : {}),
                ...(due ? { dueDate: due } : {}),
              }).then(() => setTitle("")),
            );
          }}
        >
          <label>
            Document needed
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </label>
          <label>
            Or a template
            <select value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">None</option>
              <option value="onboarding">Onboarding</option>
              <option value="vat_quarter">VAT quarter</option>
              <option value="year_end">Year end</option>
            </select>
          </label>
          <label>
            Due date
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <button type="submit">Request documents</button>
        </form>
      ) : null}
      <Loading show={l.loading} />
      {l.data && !items.length ? <Empty>No document requests.</Empty> : null}
      <ul>
        {items.map((r) => (
          <li key={r.id}>
            {r.title} <Badge value={r.overdue ? "overdue" : r.status} /> {r.dueDate ? `due ${r.dueDate}` : ""}
            {r.sha256 ? <code title="sha256 of the uploaded file">{r.sha256.slice(0, 12)}</code> : null}
            {WRITERS.has(role) && r.status === "open" ? (
              <button type="button" onClick={() => act(json(`/v1/practice/document-requests/${r.id}/waive`, "POST"))}>
                Waive {r.title}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Queries({ tenantId, role }: Omit<Props, "me">) {
  const l = useLoad(() => json<{ items: Query[] }>("/v1/practice/queries"), [tenantId]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  const items = (l.data?.items ?? []).filter((x) => x.tenantId === tenantId);
  return (
    <section aria-labelledby="q-h">
      <h2 id="q-h">Client queries</h2>
      <ErrorNote error={l.error ?? err} />
      {WRITERS.has(role) ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            json(`/v1/practice/clients/${tenantId}/queries`, "POST", { question: q }).then(() => {
              setQ("");
              void l.reload();
            }, setErr);
          }}
        >
          <label>
            Question for the client
            <input value={q} onChange={(e) => setQ(e.target.value)} required minLength={3} maxLength={2000} />
          </label>
          <button type="submit">Ask client</button>
        </form>
      ) : null}
      {l.data && !items.length ? <Empty>No queries.</Empty> : null}
      <ul>
        {items.map((x) => (
          <li key={x.id}>
            {x.question} <Badge value={x.status} /> {x.answer ? <>Answer: {x.answer}</> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkingPapers({ tenantId, role, me }: Props) {
  const l = useLoad(() => json<{ items: Paper[] }>(`/v1/practice/clients/${tenantId}/working-papers`), [tenantId]);
  const [kind, setKind] = useState("trial_balance");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState<Error | null>(null);
  const act = (p: Promise<unknown>) => p.then(() => void l.reload(), setErr);
  return (
    <section aria-labelledby="wp-h">
      <h2 id="wp-h">Working papers</h2>
      <p>Each paper freezes a sha256 snapshot. Someone other than the preparer must sign it off, and once signed it can't be changed.</p>
      <ErrorNote error={l.error ?? err} />
      {WRITERS.has(role) ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(json(`/v1/practice/clients/${tenantId}/working-papers`, "POST", { kind, periodEnd: period }));
          }}
        >
          <label>
            Paper
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="trial_balance">Trial balance</option>
              <option value="bank_reconciliation">Bank reconciliation</option>
              <option value="vat_reconciliation">VAT reconciliation</option>
            </select>
          </label>
          <label>
            Period end
            <input type="date" value={period} onChange={(e) => setPeriod(e.target.value)} required />
          </label>
          <button type="submit">Prepare paper</button>
        </form>
      ) : null}
      {l.data && !l.data.items.length ? <Empty>No working papers.</Empty> : null}
      <ul>
        {l.data?.items.map((p) => (
          <li key={p.id}>
            {label(p.kind)} to {p.periodEnd} <Badge value={p.status} /> prepared by {p.preparedBy}
            {p.signedBy ? `, signed off by ${p.signedBy}` : ""}
            {!p.integrityOk ? <Badge value="integrity failed" /> : null}
            {p.changedSinceSnapshot && p.status !== "signed_off" ? <Badge value="ledger changed" /> : null}
            {p.status === "prepared" && SIGNERS.has(role) ? (
              p.preparedBy === me ? (
                <span> (you prepared this, so someone else must sign it off)</span>
              ) : (
                <button type="button" onClick={() => act(json(`/v1/practice/working-papers/${p.id}/sign-off`, "POST", { note: null }))}>
                  Sign off {label(p.kind)}
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Assignee = { email: string; role: string };
function Assignments({ tenantId, current, onDone }: { tenantId: string; current: Assignee[]; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("reviewer");
  const [err, setErr] = useState<Error | null>(null);
  return (
    <section aria-labelledby="as-h">
      <h2 id="as-h">Assigned staff</h2>
      <p>{current.length ? current.map((a) => `${a.email} (${a.role})`).join(", ") : "Nobody assigned yet."}</p>
      <ErrorNote error={err} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const next = [...current.filter((a) => a.email !== email), { email, role }];
          json(`/v1/practice/clients/${tenantId}/assignments`, "PUT", { assignments: next }).then(() => {
            setEmail("");
            onDone();
          }, setErr);
        }}
      >
        <label>
          Staff email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Assignment role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="preparer">Preparer</option>
            <option value="reviewer">Reviewer</option>
          </select>
        </label>
        <button type="submit">Assign</button>
      </form>
    </section>
  );
}

export function PracticeClient(props: Props) {
  const c = useLoad(() => json<{ summary: { name: string; assignees: Assignee[] } }>(`/v1/practice/clients/${props.tenantId}`), [props.tenantId]);
  return (
    <Page title={c.data ? `Client: ${c.data.summary.name}` : "Client"}>
      <p>
        <a href="#/practice">Back to clients</a>{" "}
        <button type="button" onClick={() => void download(`/v1/practice/clients/${props.tenantId}/audit-export?format=csv`, `audit-${props.tenantId}.csv`)}>
          Export audit trail (CSV)
        </button>
      </p>
      <ErrorNote error={c.error} />
      {c.data && (props.role === "partner" || props.role === "manager") ? (
        <Assignments tenantId={props.tenantId} current={c.data.summary.assignees} onDone={() => void c.reload()} />
      ) : null}
      <Engagements tenantId={props.tenantId} role={props.role} />
      <DocumentRequests tenantId={props.tenantId} role={props.role} />
      <Queries tenantId={props.tenantId} role={props.role} />
      <WorkingPapers {...props} />
    </Page>
  );
}
