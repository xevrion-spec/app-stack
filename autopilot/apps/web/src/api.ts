import { createSdk, type Schemas } from "@xevrion/sdk";

export type { Schemas };
const PROD_HOST = "app.xevrion.co.uk";
export const isProd = typeof location !== "undefined" && location.hostname === PROD_HOST;
export const apiBase: string = import.meta.env.VITE_apiBase ?? (isProd ? "https://api.xevrion.co.uk" : "http://127.0.0.1:8787");

const DEV_KEY = "autopilot.devUser";
export const devUser = {
  get: () => (isProd ? null : localStorage.getItem(DEV_KEY)),
  set: (email: string | null) => (email ? localStorage.setItem(DEV_KEY, email) : localStorage.removeItem(DEV_KEY)),
};

/** One SDK per identity. In production the Cloudflare Access cookie authenticates; in dev, x-dev-user does. */
export function sdk() {
  const u = devUser.get();
  return createSdk({ baseUrl: apiBase, ...(u ? { devUser: u } : {}) });
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

/** Unwraps an openapi-fetch result: returns data or throws a typed ApiError carrying the request id. */
export function unwrap<T>(r: { data?: T; error?: unknown; response: Response }): T {
  if (r.error !== undefined || !r.response.ok) {
    const e = (r.error as { error?: { code?: string; message?: string; requestId?: string } } | undefined)?.error;
    throw new ApiError(r.response.status, e?.code ?? "http_error", e?.message ?? `Request failed (${r.response.status})`, e?.requestId);
  }
  return r.data as T;
}

/** Raw request for non-JSON endpoints (CSV upload, PDF and CSV downloads). */
export async function raw(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const u = devUser.get();
  if (u) headers.set("x-dev-user", u);
  if (init.method && init.method !== "GET") headers.set("idempotency-key", crypto.randomUUID());
  const res = await fetch(apiBase + path, { ...init, headers, credentials: "include" });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; requestId?: string } } | null;
    throw new ApiError(res.status, j?.error?.code ?? "http_error", j?.error?.message ?? `Request failed (${res.status})`, j?.error?.requestId);
  }
  return res;
}

export const gbp = (pence: number | null | undefined) =>
  pence == null ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);

export async function download(path: string, filename: string) {
  const blob = await (await raw(path)).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** JSON helper for endpoints whose responses are loosely typed in the OpenAPI spec (reports, ops, privacy). */
export async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await raw(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  return (await res.json()) as T;
}
export const today = () => new Date().toISOString().slice(0, 10);
