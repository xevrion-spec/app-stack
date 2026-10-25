import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./env.js";
import { AppError } from "./lib/errors.js";
import { identity, principal } from "./lib/auth.js";
import { idempotency } from "./lib/idempotency.js";
import { log } from "./lib/log.js";
import { TenantDb, newId } from "./lib/db.js";
import { auditStmt } from "./lib/audit.js";
import { def } from "./lib/route.js";
import * as S from "./schemas.js";
import { defaultSetupStatements } from "./services/defaults.js";
import { v1 } from "./routes/v1.js";

export function createApp() {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          { error: { code: "validation_failed", message: "Request validation failed", requestId: c.get("requestId"), details: result.error.flatten() } },
          400,
        );
      return undefined;
    },
  });

  app.use("*", async (c, next) => {
    const rid = c.req.header("x-request-id")?.slice(0, 64) || newId();
    c.set("requestId", rid);
    const t = Date.now();
    await next();
    c.header("x-request-id", rid);
    log("info", "request", {
      rid,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ms: Date.now() - t,
      tenant: c.get("principal")?.tenantId,
    });
  });
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      referrerPolicy: "no-referrer",
    }),
  );
  app.use("*", async (c, next) =>
    cors({
      origin: (c.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()),
      credentials: true,
      allowHeaders: ["content-type", "idempotency-key", "x-tenant-id", "x-request-id", "x-dev-user", "x-filename"],
    })(c, next),
  );

  app.onError((err, c) => {
    const rid = c.get("requestId");
    if (err instanceof AppError)
      return c.json({ error: { code: err.code, message: err.message, requestId: rid, ...(err.details ? { details: err.details } : {}) } }, err.status as 400);
    if (err instanceof HTTPException) return c.json({ error: { code: "bad_request", message: err.message, requestId: rid } }, err.status);
    log("error", "unhandled", { rid, err: String(err), stack: (err as Error).stack?.split("\n").slice(0, 4).join(" | ") });
    return c.json({ error: { code: "internal", message: "Internal error", requestId: rid } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found", requestId: c.get("requestId") } }, 404));

  app.get("/", (c) => c.json({ service: "xevrion-autopilot-api", docs: "/openapi.json" }));
  app.get("/health", async (c) => {
    const db = await c.env.DB.prepare("select count(*) as n from tenants")
      .first<{ n: number }>()
      .then(() => "ok")
      .catch(() => "error");
    return c.json({ ok: db === "ok", db, env: c.env.ENVIRONMENT, time: new Date().toISOString() }, db === "ok" ? 200 : 503);
  });

  // Bootstrap: an authenticated identity with no membership creates its tenant and becomes owner.
  app.use("/v1/*", identity);
  app.openapi(
    def({
      method: "post",
      path: "/v1/tenants",
      tag: "Account",
      summary: "Create a tenant (caller becomes owner) with default chart of accounts",
      body: S.CreateTenantBody,
      response: S.TenantSchema,
      status: 201,
    }),
    async (c) => {
      const b = c.req.valid("json");
      if (b.vatScheme === "flat_rate" && b.flatRatePercent == null)
        return c.json({ error: { code: "validation_failed", message: "flatRatePercent required for flat_rate", requestId: c.get("requestId") } }, 400) as never;
      const email = c.get("identityEmail");
      const tid = newId(),
        uid = newId();
      const raw = c.env.DB;
      const db = new TenantDb(raw, tid);
      await raw.batch([
        raw
          .prepare(
            "insert into tenants (id, name, trading_type, vat_registered, vat_scheme, flat_rate_percent, plan) values (?1, ?2, 'sole_trader', ?3, ?4, ?5, 'trial')",
          )
          .bind(tid, b.name, b.vatRegistered ? 1 : 0, b.vatScheme, b.flatRatePercent),
        db.stmt("insert into users (tenant_id, id, email, role, access_subject) values (?1, ?2, ?3, 'owner', ?4)", uid, email, c.get("identitySubject")),
        ...defaultSetupStatements(db),
        auditStmt(db, email, "tenant.created", tid, { name: b.name }),
      ]);
      return c.json(
        {
          id: tid,
          name: b.name,
          trading_type: "sole_trader",
          vat_registered: b.vatRegistered ? 1 : 0,
          vat_scheme: b.vatScheme,
          vat_basis: "accrual",
          flat_rate_percent: b.flatRatePercent,
          plan: "trial",
        },
        201,
      );
    },
  );

  app.use("/v1/*", async (c, next) => (c.req.method === "POST" && new URL(c.req.url).pathname === "/v1/tenants" ? next() : principal(c, next)));
  app.use("/v1/*", idempotency);
  app.route("/v1", v1);

  app.openAPIRegistry.registerComponent("securitySchemes", "accessJwt", {
    type: "apiKey",
    in: "header",
    name: "Cf-Access-Jwt-Assertion",
    description: "Cloudflare Access JWT",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Xevrion Autopilot API",
      version: "0.2.0",
      description: "Back-office automation for UK sole traders. VAT/SA outputs are DRAFTS on unverified rules; not tax advice.",
    },
    servers: [{ url: "https://api.xevrion.co.uk" }],
  });
  return app;
}
