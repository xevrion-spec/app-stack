import { useState } from "react";
import { sdk, unwrap } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Loading, Page } from "../ui";

export function Jobs({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const jobs = useLoad(async () => unwrap(await sdk().GET("/v1/jobs", { params: { query: { limit: 25 } as never } })));
  const detail = useLoad(async () => (selected ? unwrap(await sdk().GET("/v1/jobs/{id}", { params: { path: { id: selected } } })) : null), [selected]);
  const [error, setError] = useState<Error | null>(null);
  async function rerun(id: string) {
    setError(null);
    try {
      unwrap(await sdk().POST("/v1/jobs/{id}/rerun", { params: { path: { id } } }));
      setTimeout(() => void detail.reload(), 500);
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <Page
      title="Jobs"
      actions={
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void jobs.reload();
            void detail.reload();
          }}
        >
          Refresh
        </button>
      }
    >
      <ErrorNote error={jobs.error ?? detail.error ?? error} />
      <Loading show={jobs.loading} />
      {jobs.data && !jobs.data.items.length ? <Empty>No jobs yet.</Empty> : null}
      <div className="split">
        <ul className="list" aria-label="Jobs">
          {jobs.data?.items.map((j) => (
            <li key={j.id}>
              <button
                type="button"
                className={`list-item ${selected === j.id ? "active" : ""}`}
                aria-current={selected === j.id}
                onClick={() => onSelect(j.id)}
              >
                <span>{j.kind.replace("_", " ")}</span>
                <Badge value={j.status} />
                <small className="muted">
                  {j.created_at}
                  {j.qa_score != null ? ` · QA ${Math.round(j.qa_score * 100)}%` : ""}
                </small>
              </button>
            </li>
          ))}
        </ul>
        <div>
          {detail.data ? (
            <div className="card">
              <div className="row between">
                <h2>Timeline</h2>
                <button type="button" className="secondary" onClick={() => rerun(detail.data!.job.id)}>
                  Re-run
                </button>
              </div>
              <ol className="timeline">
                {detail.data.events.map((e) => (
                  <li key={e.id}>
                    <strong>{e.stage}</strong> <Badge value={e.status} /> <small className="muted">{e.created_at}</small>
                    {e.detail ? <pre>{e.detail}</pre> : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <Empty>Select a job to see its timeline.</Empty>
          )}
        </div>
      </div>
    </Page>
  );
}
