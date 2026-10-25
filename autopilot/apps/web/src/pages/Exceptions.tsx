import { useState } from "react";
import { sdk, unwrap, type Schemas } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Loading, Page } from "../ui";

type Ex = Schemas["Exception"];
export function Exceptions({ role }: { role: string }) {
  const [status, setStatus] = useState("open");
  const list = useLoad(async () => unwrap(await sdk().GET("/v1/exceptions", { params: { query: { status, limit: 50 } as never } })), [status]);
  const cats = useLoad(async () => unwrap(await sdk().GET("/v1/categories")));
  const [error, setError] = useState<Error | null>(null);
  const [flash, setFlash] = useState("");

  async function resolve(ex: Ex, form: FormData) {
    setError(null);
    const decision = String(form.get("decision")) as "approve" | "override" | "dismiss";
    const note = String(form.get("note") || "");
    const category = String(form.get("category") || "");
    if (decision === "override" && !category) return setError(new Error("Choose a category to override with."));
    try {
      unwrap(
        await sdk().POST("/v1/exceptions/{id}/resolve", {
          params: { path: { id: ex.id } },
          body: { decision, ...(note ? { note } : {}), ...(decision === "override" ? { override: { categoryCode: category } } : {}) },
        }),
      );
      list.setData((p) => (p ? { ...p, items: p.items.filter((x) => x.id !== ex.id) } : p));
      setFlash(`Resolved: ${ex.reason}`);
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <Page
      title="Review queue"
      actions={
        <label>
          Show{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
      }
    >
      <p className="muted">Autopilot handles the routine work. Only items it is unsure about land here. Signed in as {role}.</p>
      <p role="status" aria-live="polite" className="sr-live">
        {flash}
      </p>
      <ErrorNote error={list.error ?? error} />
      <Loading show={list.loading} />
      {list.data && !list.data.items.length ? <Empty>Nothing to review. 🎉</Empty> : null}
      <ul className="cards">
        {list.data?.items.map((ex) => (
          <li key={ex.id} className="card">
            <div className="row between">
              <h2 className="h3">{ex.reason}</h2>
              <Badge value={ex.reason_code} />
            </div>
            <p className="muted">
              {ex.subject_type} {ex.subject_id?.slice(0, 8)} · stage {ex.stage} · {ex.created_at}
            </p>
            {ex.status === "open" ? (
              <form
                className="row wrap"
                aria-label={`Resolve ${ex.reason}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  void resolve(ex, new FormData(e.currentTarget));
                }}
              >
                <label>
                  Decision
                  <select name="decision" defaultValue="approve">
                    <option value="approve">Approve as is</option>
                    <option value="override">Override category</option>
                    <option value="dismiss">Dismiss</option>
                  </select>
                </label>
                <label>
                  Category (for override)
                  <select name="category" defaultValue="">
                    <option value="">—</option>
                    {cats.data?.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grow">
                  Note
                  <input name="note" maxLength={500} />
                </label>
                <button type="submit">Resolve</button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </Page>
  );
}
