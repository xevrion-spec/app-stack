import { useEffect, useMemo, useState } from "react";
import { useLiveFeed } from "../live";
import { download, json, sdk, unwrap, type Schemas } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Loading, Page } from "../ui";

type Review = Schemas["ReviewRequest"];
type Decision = "approve" | "reject" | "edit" | "escalate";
type Integrity = { ok: boolean; length?: number; reason?: string };

const STATUSES = ["pending", "escalated", "approved", "rejected", "expired", "cancelled"] as const;
function timeLeft(deadline: string, now = Date.now()): string {
  const s = Math.round((Date.parse(deadline) - now) / 1000);
  if (s <= 0) return "overdue";
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  if (s < 86400) return `${Math.floor(s / 3600)} h left`;
  return `${Math.floor(s / 86400)} d left`;
}
/** Top-level key diff between the agent's original payload and the current (edited) one. */
function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map((k) => {
    const x = JSON.stringify(a[k]);
    const y = JSON.stringify(b[k]);
    return { key: k, before: x ?? "—", after: y ?? "—", changed: x !== y };
  });
}

/** Reviewer inbox for agent actions: approve, reject, edit-then-approve or escalate, with full context and audit status. */
export function AgentReviews({ role, selected, onSelect }: { role: string; selected: string | null; onSelect: (id: string | null) => void }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("pending");
  const list = useLoad(async () => unwrap(await sdk().GET("/v1/agent-reviews", { params: { query: { status, limit: 50 } as never } })), [status]);
  const items = list.data?.items ?? [];
  const [flash, setFlash] = useState("");
  const [stale, setStale] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const live = useLiveFeed((ch) => {
    // Silent refresh (no spinner); a reviewer looking at a request someone else just changed gets told, not overwritten.
    void sdk()
      .GET("/v1/agent-reviews", { params: { query: { status, limit: 50 } as never } })
      .then((res) => res.data && list.setData(res.data))
      .catch(() => {});
    if (ch.id === selected) setStale(ch.id);
  });
  return (
    <Page
      title="Agent reviews"
      actions={
        <label>
          Status{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <p className="muted">
        Actions your AI agents want to take that policy sent to a person. Nothing runs until it is approved. Signed in as {role}.{" "}
        <span className={live ? "badge b-live" : "badge"}>{live ? "Live" : "Not live: refresh to update"}</span>
      </p>
      {stale && stale === selected ? (
        <p role="alert" className="note">
          This request was just updated elsewhere.{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setStale(null);
              setRev((n) => n + 1);
            }}
          >
            Show the latest
          </button>
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="sr-live">
        {flash}
      </p>
      <ErrorNote error={list.error} />
      <Loading show={list.loading} />
      {list.data && !items.length ? <Empty>No {status} requests.</Empty> : null}
      <div className="split">
        <ul className="cards" aria-label={`${status} agent requests`}>
          {items.map((r) => (
            <li key={r.id} className={`card${r.id === selected ? " selected" : ""}`}>
              <button type="button" className="link block" aria-current={r.id === selected ? "true" : undefined} onClick={() => onSelect(r.id)}>
                <span className="row between">
                  <strong>{r.action}</strong>
                  <span className="row gap-xs">
                    <RetentionBadges review={r} />
                    <Badge value={r.risk} />
                  </span>
                </span>
                <span className="muted small">
                  {r.approvals}/{r.requiredApprovals} approvals · {r.status === "pending" || r.status === "escalated" ? timeLeft(r.deadlineAt) : r.status}
                  {r.routing.chain && r.routing.chain.currentStep !== null ? ` · step ${r.routing.chain.currentStep + 1}/${r.routing.chain.steps.length}` : ""}
                  {r.routing.group ? ` · ${r.routing.group}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {selected ? (
          <ReviewDetail
            key={`${selected}:${rev}`}
            id={selected}
            onDone={(r, msg) => {
              setFlash(msg);
              list.setData((p) => (p ? { ...p, items: p.items.map((x) => (x.id === r.id ? r : x)).filter((x) => x.status === status) } : p));
              if (r.status !== status) onSelect(null);
            }}
          />
        ) : null}
      </div>
    </Page>
  );
}

function ReviewDetail({ id, onDone }: { id: string; onDone: (r: Review, message: string) => void }) {
  const r = useLoad(async () => unwrap(await sdk().GET("/v1/agent-reviews/{id}", { params: { path: { id } } })), [id]);
  const audit = useLoad(async () => (await json<{ integrity: Integrity }>(`/v1/agent-reviews/${encodeURIComponent(id)}/audit`)).integrity, [id]);
  const [draft, setDraft] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const review = r.data;
  const open = review && (review.status === "pending" || review.status === "escalated");
  const parsed = useMemo(() => {
    if (draft === null) return { ok: true as const, value: null };
    try {
      const v = JSON.parse(draft) as unknown;
      return v && typeof v === "object" && !Array.isArray(v)
        ? { ok: true as const, value: v as Record<string, unknown> }
        : { ok: false as const, msg: "Payload must be a JSON object" };
    } catch (e) {
      return { ok: false as const, msg: `Not valid JSON: ${(e as Error).message}` };
    }
  }, [draft]);

  async function decide(decision: Decision) {
    if (!review) return;
    if (decision === "edit" && (!parsed.ok || !parsed.value)) return setError(new Error(parsed.ok ? "Change the payload before saving an edit." : parsed.msg));
    if (decision === "reject" && !reason.trim()) return setError(new Error("Give a reason when rejecting, so the agent and the audit trail know why."));
    setError(null);
    setBusy(true);
    try {
      const next = unwrap(
        await sdk().POST("/v1/agent-reviews/{id}/decisions", {
          params: { path: { id: review.id } },
          body: {
            decision,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(decision === "edit" && parsed.ok && parsed.value ? { payload: parsed.value } : {}),
          } as never,
        }),
      );
      r.setData(next);
      setDraft(null);
      setReason("");
      onDone(next, `Recorded ${decision} on ${next.action}. Request is now ${next.status}.`);
      void audit.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  // Keyboard: a = approve, r = focus reason (reject needs one), e = edit payload. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (!open || busy || e.ctrlKey || e.metaKey || e.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (e.key === "a") void decide("approve");
      if (e.key === "r") document.getElementById("review-reason")?.focus();
      if (e.key === "e" && review) {
        e.preventDefault();
        setDraft(JSON.stringify(review.payload, null, 2));
        setTimeout(() => document.getElementById("review-payload")?.focus(), 0);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (!review) return <Loading show={r.loading} />;
  return (
    <article className="card detail" aria-labelledby="review-title">
      <h2 id="review-title" className="h3">
        {review.action} <Badge value={review.status} /> <RetentionBadges review={review} />
      </h2>
      <RedactedNote at={review.redactedAt} />
      <Facts review={review} open={!!open} audit={audit.data} />
      {review.context ? (
        <>
          <h3 className="h4">Context from the agent</h3>
          <pre className="code" tabIndex={0} aria-label="Agent context">
            {JSON.stringify(review.context, null, 2)}
          </pre>
        </>
      ) : null}
      <TemplateNote template={review.template} />
      <PayloadDiff review={review} />
      <ErrorNote error={error} />
      {open ? (
        <form
          aria-label="Decide"
          onSubmit={(e) => {
            e.preventDefault();
            void decide(draft !== null ? "edit" : "approve");
          }}
        >
          {draft !== null ? (
            <label className="block">
              Edited payload (JSON)
              <textarea
                id="review-payload"
                rows={8}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={!parsed.ok}
                aria-describedby={!parsed.ok ? "payload-error" : undefined}
                spellCheck={false}
              />
              {!parsed.ok ? (
                <span id="payload-error" className="error small">
                  {parsed.msg}
                </span>
              ) : null}
            </label>
          ) : null}
          <label className="block">
            Reason (required to reject)
            <input id="review-reason" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row wrap">
            {draft === null ? (
              <>
                <button type="submit" disabled={busy}>
                  Approve <kbd aria-hidden="true">A</kbd>
                </button>
                <button type="button" disabled={busy} onClick={() => setDraft(JSON.stringify(review.payload, null, 2))}>
                  Edit then approve <kbd aria-hidden="true">E</kbd>
                </button>
              </>
            ) : (
              <>
                <button type="submit" disabled={busy || !parsed.ok}>
                  Save edit and approve
                </button>
                <button type="button" className="link" onClick={() => setDraft(null)}>
                  Discard edit
                </button>
              </>
            )}
            <button type="button" className="danger" disabled={busy} onClick={() => void decide("reject")}>
              Reject
            </button>
            {review.status === "pending" ? (
              <button type="button" disabled={busy} onClick={() => void decide("escalate")}>
                Escalate
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      <Attachments id={review.id} />
      <History review={review} />
    </article>
  );
}

const STEP_LABEL = { done: "done", current: "now deciding", waiting: "waiting" } as const;
function ChainSteps({ chain }: { chain: NonNullable<Review["routing"]["chain"]> }) {
  return (
    <ol className="chain" aria-label="Approval chain">
      {chain.steps.map((st) => (
        <li key={st.name} className={`chain-${st.state}`} aria-current={st.state === "current" ? "step" : undefined}>
          <strong>{st.name}</strong>
          {st.group ? ` (${st.group})` : ""}: {st.approvals}/{st.required} · {STEP_LABEL[st.state]}
        </li>
      ))}
    </ol>
  );
}

const fmt = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
function EditChanges({ diff }: { diff: NonNullable<Review["payloadDiff"]> }) {
  return (
    <table className="diff">
      <caption>Changes from the agent's original</caption>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Was</th>
          <th scope="col">Now</th>
        </tr>
      </thead>
      <tbody>
        {diff.changes.map((c) => (
          <tr key={c.path} className={`diff-${c.op}`}>
            <th scope="row">
              <code>{c.path}</code> <span className="muted small">({c.op === "add" ? "added" : c.op === "remove" ? "removed" : "changed"})</span>
            </th>
            <td>{c.op === "add" ? "—" : <del>{fmt(c.from)}</del>}</td>
            <td>{c.op === "remove" ? "—" : <ins>{fmt(c.to)}</ins>}</td>
          </tr>
        ))}
      </tbody>
      {diff.truncated ? (
        <tfoot>
          <tr>
            <td colSpan={3}>More changes not shown.</td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

type Attachment = Schemas["ReviewAttachment"];
function Attachments({ id }: { id: string }) {
  const list = useLoad(async () => (await json<{ items: Attachment[] }>(`/v1/agent-reviews/${encodeURIComponent(id)}/attachments`)).items, [id]);
  if (!list.data?.length) return null;
  return (
    <>
      <h3 className="h4">Evidence</h3>
      <ul className="attachments">
        {list.data.map((a) => (
          <li key={a.id}>
            {a.downloadable ? (
              <button
                type="button"
                className="link"
                onClick={() => void download(`/v1/agent-reviews/${encodeURIComponent(id)}/attachments/${a.id}/content`, a.name)}
              >
                Download {a.name}
              </button>
            ) : (
              <span>{a.name}</span>
            )}{" "}
            <span className="muted small">
              {Math.max(1, Math.round(a.size / 1024))} KB ·{" "}
              {a.scan.status === "clean"
                ? `scanned clean (${a.scan.engine === "stub-eicar" ? "basic checks only" : a.scan.engine})`
                : `blocked: ${a.scan.status}${a.scan.detail ? `, ${a.scan.detail}` : ""}`}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function TemplateNote({ template }: { template: Review["template"] }) {
  if (!template?.title && !template?.instructions) return null;
  return (
    <div className="note">
      {template.title ? <p className="h4">{template.title}</p> : null}
      {template.instructions ? <p>{template.instructions}</p> : null}
    </div>
  );
}

function Facts({ review, open, audit }: { review: Review; open: boolean; audit: Integrity | null }) {
  return (
    <dl className="kv">
      <dt>Risk</dt>
      <dd>
        <Badge value={review.risk} />
        {review.confidence != null ? ` · agent confidence ${Math.round(review.confidence * 100)}%` : ""}
      </dd>
      <dt>Approvals</dt>
      <dd>
        {review.approvals} of {review.requiredApprovals} on version {review.payloadVersion}
        {review.routing.chain ? <ChainSteps chain={review.routing.chain} /> : null}
      </dd>
      {review.payloadDiff && review.payloadDiff.changes.length ? (
        <>
          <dt>Edits</dt>
          <dd>
            <EditChanges diff={review.payloadDiff} />
          </dd>
        </>
      ) : null}
      <dt>Routed by</dt>
      <dd>
        policy v{review.routing.policyVersion}
        {review.routing.ruleId ? `, rule ${review.routing.ruleId}` : ", default"}
        {review.routing.group ? ` → ${review.routing.group}` : ""}
        {review.routing.guardrails.length ? <span className="note warn inline"> guardrails: {review.routing.guardrails.join(", ")}</span> : null}
      </dd>
      <dt>Deadline</dt>
      <dd>
        {new Date(review.deadlineAt).toLocaleString()} {open ? `(${timeLeft(review.deadlineAt)})` : ""}
      </dd>
      <dt>Requested by</dt>
      <dd>
        {review.requester}
        {review.externalId ? ` · ref ${review.externalId}` : ""}
      </dd>
      <dt>Audit trail</dt>
      <dd>
        {audit ? (
          audit.ok ? (
            <span className="badge b-approved">verified · {audit.length} entries</span>
          ) : (
            <span className="badge b-rejected" role="alert">
              failed verification: {audit.reason}
            </span>
          )
        ) : (
          "…"
        )}{" "}
        <button
          type="button"
          className="link"
          onClick={() => void download(`/v1/agent-reviews/${encodeURIComponent(review.id)}/evidence`, `review-evidence-${review.id}.json`)}
        >
          Download evidence pack
        </button>
      </dd>
    </dl>
  );
}

function PayloadDiff({ review }: { review: Review }) {
  const diff = diffKeys(review.originalPayload, review.payload);
  return (
    <>
      <h3 className="h4">Proposed action</h3>
      <table className="diff">
        <caption className="sr-only">Payload fields, original versus current</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Agent proposed</th>
            <th scope="col">Current</th>
          </tr>
        </thead>
        <tbody>
          {diff.map((d) => (
            <tr key={d.key} className={d.changed ? "changed" : undefined}>
              <th scope="row">{d.key}</th>
              <td>
                <code>{d.before}</code>
              </td>
              <td>
                <code>{d.after}</code>
                {d.changed ? <span className="sr-only"> (edited)</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function History({ review }: { review: Review }) {
  if (!review.decisions?.length) return null;
  return (
    <>
      <h3 className="h4">History</h3>
      <ol className="history">
        {review.decisions.map((d) => (
          <li key={d.id}>
            <strong>{d.decision}</strong> by {d.reviewer} on v{d.payloadVersion} · {new Date(d.createdAt).toLocaleString()}
            {d.reason ? ` · “${d.reason}”` : ""}
          </li>
        ))}
      </ol>
    </>
  );
}

/** Legal hold / redaction markers: text labels (not colour alone) so they work for screen readers and in dark mode. */
function RetentionBadges({ review }: { review: { legalHold?: boolean; redactedAt?: string | null } }) {
  return (
    <>
      {review.legalHold ? (
        <span className="badge b-hold" title="On legal hold: retention will not delete or redact this request">
          legal hold
        </span>
      ) : null}
      {review.redactedAt ? (
        <span className="badge b-redacted" title={`Redacted ${review.redactedAt}`}>
          redacted
        </span>
      ) : null}
    </>
  );
}

function RedactedNote({ at }: { at?: string | null }) {
  if (!at) return null;
  return (
    <p className="note" role="note">
      Payload and context were redacted on {new Date(at).toLocaleString()}. Decisions and the hash-chained trail are kept.
    </p>
  );
}
