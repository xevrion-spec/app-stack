import { useState } from "react";
import { apiBase, json, sdk, unwrap, type Schemas } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Loading, Page } from "../ui";

type Project = Schemas["ReviewProject"];
type Policy = Schemas["ReviewPolicy"];
type Replay = Schemas["PolicyReplayReport"];
type Routing = Schemas["ReviewRoutingSimulation"];
type Delivery = Schemas["ReviewCallbackDelivery"];
const TEMPLATE = {
  rules: [
    {
      id: "small-refunds",
      when: { action: "refund.*", risk: ["low"], minConfidence: 0.9, payload: [{ path: "amount", op: "lte", value: 50 }] },
      then: { outcome: "auto_approve" },
    },
    { id: "payments", when: { action: "payment.*" }, then: { outcome: "human", approvals: 2, timeoutSeconds: 3600 } },
  ],
  default: { outcome: "human", approvals: 1 },
};
const SCOPES = ["reviews:write", "reviews:read", "reviews:decide"] as const;

/** Run an action and surface its error; returns undefined on failure. */
function useAction() {
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      setError(e as Error);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

/** Developer console: projects, keys, policy-as-code with replay-gated activation, routing simulator and delivery logs. */
export function AgentConsole() {
  const projects = useLoad(async () => unwrap(await sdk().GET("/v1/review-projects")).items);
  const [sel, setSel] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const a = useAction();
  const current = projects.data?.find((p) => p.id === sel) ?? projects.data?.[0] ?? null;
  return (
    <Page title="Agent developer console">
      <p className="muted">Connect an agent, choose what needs a human, and test the rules on past traffic before they go live.</p>
      <ErrorNote error={projects.error ?? a.error} />
      <Loading show={projects.loading} />
      <section aria-labelledby="proj-h" className="card">
        <h2 id="proj-h" className="h3">
          Projects
        </h2>
        {projects.data && !projects.data.length ? <Empty>No projects yet. Create one for each agent or environment.</Empty> : null}
        {projects.data?.length ? (
          <label>
            Project{" "}
            <select value={current?.id ?? ""} onChange={(e) => setSel(e.target.value)}>
              {projects.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.environment})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <form
          className="row wrap"
          aria-label="Create project"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void a.run(async () => {
              const p = unwrap(
                await sdk().POST("/v1/review-projects", { body: { name: String(f.get("name")), environment: String(f.get("environment")) } as never }),
              ) as Project & { callbackSecret: string };
              setSecret(p.callbackSecret);
              setSel(p.id);
              await projects.reload();
            });
          }}
        >
          <label>
            Name <input name="name" required maxLength={80} />
          </label>
          <label>
            Environment{" "}
            <select name="environment" defaultValue="development">
              <option value="development">development</option>
              <option value="staging">staging</option>
              <option value="production">production</option>
            </select>
          </label>
          <button type="submit" disabled={a.busy}>
            Create project
          </button>
        </form>
        {secret ? <OnceSecret label="Callback signing secret" value={secret} /> : null}
      </section>
      {current ? <ProjectPanels key={current.id} project={current} /> : null}
    </Page>
  );
}

function OnceSecret({ label, value }: { label: string; value: string }) {
  return (
    <p className="note warn" role="note">
      {label} (shown once, store it now): <code data-testid="once-secret">{value}</code>{" "}
      <button type="button" className="link" onClick={() => void navigator.clipboard?.writeText(value)}>
        Copy
      </button>
    </p>
  );
}

function ProjectPanels({ project }: { project: Project }) {
  return (
    <>
      <KeyPanel project={project} />
      <PolicyPanel project={project} />
      <SimulatorPanel project={project} />
      <DeliveryPanel project={project} />
      <Quickstart project={project} />
    </>
  );
}

function KeyPanel({ project }: { project: Project }) {
  const [key, setKey] = useState<string | null>(null);
  const a = useAction();
  return (
    <section aria-labelledby="key-h" className="card">
      <h2 id="key-h" className="h3">
        API key for {project.name}
      </h2>
      <ErrorNote error={a.error} />
      <form
        className="row wrap"
        aria-label="Create API key"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const scopes = SCOPES.filter((s) => f.get(s));
          if (!scopes.length) return;
          void a.run(async () => {
            const k = unwrap(await sdk().POST("/v1/api-keys", { body: { name: String(f.get("keyname")), scopes, projectId: project.id } as never })) as {
              key: string;
            };
            setKey(k.key);
          });
        }}
      >
        <label>
          Key name <input name="keyname" required maxLength={80} defaultValue={`${project.name} agent`} />
        </label>
        <fieldset className="row">
          <legend>Scopes</legend>
          {SCOPES.map((s) => (
            <label key={s}>
              <input type="checkbox" name={s} defaultChecked={s !== "reviews:decide"} /> {s}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={a.busy}>
          Create key
        </button>
      </form>
      {key ? <OnceSecret label="API key" value={key} /> : null}
    </section>
  );
}

function PolicyPanel({ project }: { project: Project }) {
  const list = useLoad(
    async () => unwrap(await sdk().GET("/v1/review-projects/{id}/policies", { params: { path: { id: project.id } } })).items as Policy[],
    [project.id],
  );
  const [doc, setDoc] = useState(() => JSON.stringify(TEMPLATE, null, 2));
  const [report, setReport] = useState<Replay | null>(null);
  const [canary, setCanary] = useState("");
  const [flash, setFlash] = useState("");
  const a = useAction();
  const parse = () => JSON.parse(doc) as unknown;
  const path = `/v1/review-projects/${encodeURIComponent(project.id)}/policies`;
  return (
    <section aria-labelledby="pol-h" className="card">
      <h2 id="pol-h" className="h3">
        Policy as code
      </h2>
      <p className="muted small">
        Rules run top to bottom; the first match wins. Guardrails you cannot turn off: critical risk is never auto-approved and needs two people; auto-approve
        needs a confidence floor of at least 0.5.
      </p>
      <p role="status" aria-live="polite" className="sr-live">
        {flash}
      </p>
      <ErrorNote error={list.error ?? a.error} />
      {list.data?.length ? (
        <table>
          <caption className="sr-only">Policy versions</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Description</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((p) => (
              <tr key={p.version}>
                <td>v{p.version}</td>
                <td>
                  <Badge value={p.status} />
                  {p.canaryPercent ? ` ${p.canaryPercent}%` : ""}
                </td>
                <td>{p.description ?? ""}</td>
                <td>
                  {p.status === "draft" ? (
                    <button
                      type="button"
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          const res = await json<{ replay: Replay }>(`${path}/${p.version}/activate`, "POST", canary ? { canaryPercent: Number(canary) } : {});
                          setReport(res.replay);
                          setFlash(`v${p.version} is now ${canary ? `a ${canary}% canary` : "active"}.`);
                          await list.reload();
                        })
                      }
                    >
                      Activate v{p.version}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <label className="block">
        Policy document (JSON)
        <textarea rows={14} value={doc} onChange={(e) => setDoc(e.target.value)} spellCheck={false} />
      </label>
      <div className="row wrap">
        <button
          type="button"
          disabled={a.busy}
          onClick={() => void a.run(async () => setReport(await json<Replay>(`${path}/replay`, "POST", { document: parse() })))}
        >
          Replay on past requests
        </button>
        <button
          type="button"
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              const p = await json<Policy>(path, "POST", { document: parse() });
              setFlash(`Saved draft v${p.version}.`);
              await list.reload();
            })
          }
        >
          Save as draft
        </button>
        <label>
          Canary % (optional){" "}
          <input inputMode="numeric" pattern="[0-9]*" size={4} value={canary} onChange={(e) => setCanary(e.target.value.replace(/\D/g, "").slice(0, 2))} />
        </label>
      </div>
      {report ? <ReplayReport r={report} /> : null}
    </section>
  );
}

function ReplayReport({ r }: { r: Replay }) {
  return (
    <div className={`note ${r.safe ? "" : "error"}`} role="region" aria-label="Replay report">
      <strong>{r.safe ? "Safe to activate" : "Unsafe: activation will be refused"}</strong>
      <ul>
        <li>
          {r.evaluated} past requests replayed, {r.changed} would be routed differently
        </li>
        <li>
          {r.reviewsSaved} fewer human reviews (load change {r.humanLoadDelta})
        </li>
        <li>
          Would auto-approve {r.wouldAutoApproveRejected} that a person rejected and {r.wouldAutoApproveEdited} that a person edited
        </li>
      </ul>
    </div>
  );
}

function SimulatorPanel({ project }: { project: Project }) {
  const [out, setOut] = useState<Routing | null>(null);
  const a = useAction();
  return (
    <section aria-labelledby="sim-h" className="card">
      <h2 id="sim-h" className="h3">
        Routing simulator
      </h2>
      <ErrorNote error={a.error} />
      <form
        className="row wrap"
        aria-label="Simulate a request"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const conf = String(f.get("confidence") || "");
          void a.run(async () => {
            const request = {
              projectId: project.id,
              action: String(f.get("action")),
              risk: String(f.get("risk")),
              payload: JSON.parse(String(f.get("payload") || "{}")) as unknown,
              ...(conf ? { confidence: Number(conf) } : {}),
            };
            setOut(await json<Routing>("/v1/agent-reviews/simulate", "POST", { request }));
          });
        }}
      >
        <label>
          Action <input name="action" required defaultValue="refund.issue" pattern="[a-z0-9][a-z0-9_.:\-]*" />
        </label>
        <label>
          Risk{" "}
          <select name="risk" defaultValue="low">
            {["low", "medium", "high", "critical"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          Confidence <input name="confidence" inputMode="decimal" size={5} defaultValue="0.95" />
        </label>
        <label className="grow">
          Payload (JSON) <input name="payload" defaultValue='{"amount": 20}' />
        </label>
        <button type="submit" disabled={a.busy}>
          Simulate
        </button>
      </form>
      {out ? (
        <div role="region" aria-label="Simulation result" className="note">
          <strong data-testid="sim-outcome">{out.outcome.replace("_", " ")}</strong>
          {out.ruleId ? ` by rule ${out.ruleId}` : " by the default"} · {out.approvals} approval(s)
          {out.guardrails.length ? ` · guardrails: ${out.guardrails.join(", ")}` : ""}
          <ol className="small">
            {out.trace.map((t) => (
              <li key={t.ruleId}>
                {t.ruleId}: {t.matched ? "matched" : `no (${t.failed.join(", ")})`}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function DeliveryPanel({ project }: { project: Project }) {
  const list = useLoad(
    async () => unwrap(await sdk().GET("/v1/agent-reviews", { params: { query: { projectId: project.id, limit: 10 } as never } })).items,
    [project.id],
  );
  const [open, setOpen] = useState<string | null>(null);
  const [log, setLog] = useState<Delivery[] | null>(null);
  const a = useAction();
  const show = (id: string) =>
    void a.run(async () => {
      setOpen(id);
      setLog((await json<{ items: Delivery[] }>(`/v1/agent-reviews/${encodeURIComponent(id)}/callbacks`)).items);
    });
  return (
    <section aria-labelledby="del-h" className="card">
      <h2 id="del-h" className="h3">
        Recent requests and callback deliveries
      </h2>
      <ErrorNote error={list.error ?? a.error} />
      {list.data && !list.data.length ? <Empty>No requests yet. Use the quickstart below.</Empty> : null}
      <ul className="plain">
        {list.data?.map((r) => (
          <li key={r.id}>
            <button type="button" className="link" aria-expanded={open === r.id} onClick={() => show(r.id)}>
              {r.action}
            </button>{" "}
            <Badge value={r.status} /> <span className="muted small">{new Date(r.createdAt).toLocaleString()}</span>
            {open === r.id && log ? (
              <div>
                {log.length ? (
                  <ul className="small">
                    {log.map((d) => (
                      <li key={d.id}>
                        {d.eventType}: <Badge value={d.status} /> attempt {d.attempt}
                        {d.responseStatus ? ` · HTTP ${d.responseStatus}` : ""}
                        {d.error ? ` · ${d.error}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted small">No callback URL on this request.</span>
                )}
                {log.length ? (
                  <button
                    type="button"
                    disabled={a.busy}
                    onClick={() =>
                      void a.run(async () =>
                        setLog((await json<{ items: Delivery[] }>(`/v1/agent-reviews/${encodeURIComponent(r.id)}/callbacks/redeliver`, "POST", {})).items),
                      )
                    }
                  >
                    Redeliver
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Quickstart({ project }: { project: Project }) {
  const base = apiBase || location.origin;
  const ts = `import { ReviewClient } from "@xevrion/sdk";
const reviews = new ReviewClient({ baseUrl: "${base}", apiKey: process.env.XEVRION_KEY! });
const r = await reviews.requestAndWait({ action: "refund.issue", risk: "high", payload: { amount: 120 } });
if (r.status === "approved") await issueRefund(r.payload);`;
  const curl = `curl -X POST ${base}/v1/agent-reviews -H "authorization: Bearer $XEVRION_KEY" \\
  -H "content-type: application/json" -H "idempotency-key: run-1-step-3" \\
  -d '{"action":"refund.issue","risk":"high","payload":{"amount":120}}'`;
  return (
    <section aria-labelledby="qs-h" className="card">
      <h2 id="qs-h" className="h3">
        Quickstart ({project.name})
      </h2>
      <h3 className="h4">TypeScript</h3>
      <pre className="code" tabIndex={0} aria-label="TypeScript example">
        {ts}
      </pre>
      <h3 className="h4">HTTP</h3>
      <pre className="code" tabIndex={0} aria-label="curl example">
        {curl}
      </pre>
    </section>
  );
}
