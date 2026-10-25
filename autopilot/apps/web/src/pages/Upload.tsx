import { useRef, useState } from "react";
import { raw, type Schemas } from "../api";
import { ErrorNote, Page } from "../ui";

const MAX = 2 * 1024 * 1024;
export function Upload({ onDone }: { onDone: (jobId: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<Schemas["UploadResult"] | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const f = input.current?.files?.[0];
    setError(null);
    setResult(null);
    if (!f) return setError(new Error("Choose a CSV file first."));
    if (f.size > MAX) return setError(new Error("File is larger than 2 MB."));
    if (!/\.csv$/i.test(f.name)) return setError(new Error("Only .csv bank statements are supported here."));
    setBusy(true);
    try {
      const res = await raw("/v1/uploads/bank-csv", { method: "POST", body: await f.text(), headers: { "content-type": "text/csv", "x-filename": f.name } });
      setResult((await res.json()) as Schemas["UploadResult"]);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title="Upload bank statement">
      <form onSubmit={submit} className="card stack" aria-describedby="upload-help">
        <label htmlFor="csv">Bank statement (CSV, max 2 MB)</label>
        <input id="csv" ref={input} type="file" accept=".csv,text/csv" required />
        <p id="upload-help" className="muted">
          Columns: Date, Description, Amount (or Money in / Money out). Dates are read UK-style (DD/MM/YYYY). Duplicate rows are skipped.
        </p>
        <button type="submit" disabled={busy}>
          {busy ? "Uploading…" : "Upload and process"}
        </button>
      </form>
      <ErrorNote error={error} />
      {result ? (
        <div className="note ok" role="status" aria-live="polite">
          <p>
            Imported <strong>{result.inserted}</strong> transactions ({result.duplicates} duplicates skipped, {result.rejectedRows.length} rows rejected).
          </p>
          {result.rejectedRows.length ? (
            <ul>
              {result.rejectedRows.slice(0, 5).map((r, i) => (
                <li key={i}>{JSON.stringify(r)}</li>
              ))}
            </ul>
          ) : null}
          <p className="muted">Checksum {result.sha256.slice(0, 12)}…</p>
          {result.jobId ? (
            <button type="button" onClick={() => onDone(result.jobId!)}>
              View job timeline
            </button>
          ) : null}
        </div>
      ) : null}
    </Page>
  );
}
