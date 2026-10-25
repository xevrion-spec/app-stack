import { json } from "../api";
import { useLoad } from "../hooks";
import { Badge, ErrorNote, Loading, Page } from "../ui";

type Summary = {
  jobs: Record<string, number>;
  failedJobs7d: number;
  openExceptions: number;
  webhookDeliveries: Record<string, number>;
  undispatchedEvents: number;
  recentRuns: { job: string; run_date: string; status: string }[];
  documents: { stored: number; purged: number };
  health: "ok" | "degraded";
};
type Overview = { tenants: Record<string, number>; jobs: Record<string, number>; undispatchedEvents: number };
const kv = (r: Record<string, number>) =>
  Object.entries(r)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ") || "none";

export function Ops() {
  const s = useLoad(() => json<Summary>("/v1/ops/summary"));
  // Operator-only; a 403 simply hides the section.
  const admin = useLoad(() => json<Overview>("/v1/admin/overview").catch(() => null));
  return (
    <Page title="Ops">
      <ErrorNote error={s.error} />
      <Loading show={s.loading} />
      {s.data ? (
        <>
          <p>
            Health: <Badge value={s.data.health} />
          </p>
          <dl className="boxes">
            <div className="box">
              <dt>Jobs</dt>
              <dd>{kv(s.data.jobs)}</dd>
            </div>
            <div className="box">
              <dt>Failed jobs (7 days)</dt>
              <dd>{s.data.failedJobs7d}</dd>
            </div>
            <div className="box">
              <dt>Open exceptions</dt>
              <dd>{s.data.openExceptions}</dd>
            </div>
            <div className="box">
              <dt>Webhook deliveries</dt>
              <dd>{kv(s.data.webhookDeliveries)}</dd>
            </div>
            <div className="box">
              <dt>Events waiting</dt>
              <dd>{s.data.undispatchedEvents}</dd>
            </div>
            <div className="box">
              <dt>Documents stored / removed</dt>
              <dd>
                {s.data.documents.stored} / {s.data.documents.purged}
              </dd>
            </div>
          </dl>
          <h2>Daily scheduled runs</h2>
          <table className="table">
            <caption className="sr-only">Recent scheduled runs</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Job</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {s.data.recentRuns.map((r) => (
                <tr key={`${r.run_date}-${r.job}`}>
                  <td>{r.run_date}</td>
                  <td>{r.job.replace(/_/g, " ")}</td>
                  <td>
                    <Badge value={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {admin.data ? (
        <section className="card" aria-labelledby="adm-h">
          <h2 id="adm-h">Operator overview (all businesses, counts only)</h2>
          <p>Businesses by plan: {kv(admin.data.tenants)}</p>
          <p>Jobs: {kv(admin.data.jobs)}</p>
          <p>Events waiting: {admin.data.undispatchedEvents}</p>
        </section>
      ) : null}
    </Page>
  );
}
