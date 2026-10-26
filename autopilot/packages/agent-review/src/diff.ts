/**
 * Structural payload diff (R4): what a reviewer's edit changed, as dot/bracket paths. Deterministic (keys sorted),
 * bounded (at most `limit` entries, deepest 12 levels), and values are clipped so a huge blob never floods the UI.
 */
export type DiffOp = { path: string; op: "add" | "remove" | "change"; from?: unknown; to?: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clip = (v: unknown): unknown => {
  if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  if (typeof v === "object" && v !== null) {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : v;
  }
  return v;
};
const key = (base: string, k: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? (base ? `${base}.${k}` : k) : `${base}[${JSON.stringify(k)}]`);

export function diffPayload(a: unknown, b: unknown, limit = 200): { changes: DiffOp[]; truncated: boolean } {
  const out: DiffOp[] = [];
  let truncated = false;
  const push = (d: DiffOp) => {
    if (out.length >= limit) truncated = true;
    else out.push(d);
  };
  const walk = (x: unknown, y: unknown, path: string, depth: number) => {
    if (truncated) return;
    if (depth < 12 && isObj(x) && isObj(y)) {
      for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
        const p = key(path, k);
        if (!(k in y)) push({ path: p, op: "remove", from: clip(x[k]) });
        else if (!(k in x)) push({ path: p, op: "add", to: clip(y[k]) });
        else walk(x[k], y[k], p, depth + 1);
      }
      return;
    }
    if (depth < 12 && Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const p = `${path}[${i}]`;
        if (i >= y.length) push({ path: p, op: "remove", from: clip(x[i]) });
        else if (i >= x.length) push({ path: p, op: "add", to: clip(y[i]) });
        else walk(x[i], y[i], p, depth + 1);
      }
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) push({ path: path || "$", op: "change", from: clip(x), to: clip(y) });
  };
  walk(a, b, "", 0);
  return { changes: out, truncated };
}
