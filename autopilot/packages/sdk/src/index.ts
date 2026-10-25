/**
 * Typed client for the Autopilot API. Types are generated from /openapi/openapi.json (`npm run openapi`),
 * so a backend contract change breaks consumers at compile time.
 */
import createClient, { type Middleware } from "openapi-fetch";
import type { paths, components } from "./schema.js";

export type { paths, components };
export type Schemas = components["schemas"];

export interface SdkOptions {
  baseUrl: string;
  /** Dev only: impersonate a user against a non-production API. */
  devUser?: string;
  tenantId?: string;
  fetch?: typeof fetch;
}

export function createSdk(o: SdkOptions) {
  const client = createClient<paths>({ baseUrl: o.baseUrl, credentials: "include", ...(o.fetch ? { fetch: o.fetch } : {}) });
  const headers: Middleware = {
    onRequest({ request }) {
      if (o.devUser) request.headers.set("x-dev-user", o.devUser);
      if (o.tenantId) request.headers.set("x-tenant-id", o.tenantId);
      if (request.method !== "GET" && !request.headers.has("idempotency-key")) request.headers.set("idempotency-key", crypto.randomUUID());
      return request;
    },
  };
  client.use(headers);
  return client;
}
export type Sdk = ReturnType<typeof createSdk>;
export * from "./agent-review.js";
export * from "./adapters.js";
