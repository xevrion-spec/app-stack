import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

export interface Env {
  DB: D1Database; DOCS: R2Bucket; CONFIG: KVNamespace; PIPELINE: Queue<PipelineMsg>;
  ENVIRONMENT: string; ALLOWED_ORIGINS: string;
}
type PipelineMsg = { jobId: string; tenantId: string; stage: string };
const STAGES = ["intake","extract","categorise","reconcile","draft","qa","review","deliver","outcome"] as const;

const app = new Hono<{ Bindings: Env }>();
app.use("*", secureHeaders({ strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] }, referrerPolicy: "no-referrer" }));
app.use("*", async (c, next) => cors({ origin: c.env.ALLOWED_ORIGINS.split(","), credentials: true })(c, next));

// naive per-IP fixed-window limiter on KV (replace with Rate Limiting binding / WAF rule when available)
app.use("/v1/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const key = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const n = Number((await c.env.CONFIG.get(key)) ?? 0);
  if (n > 120) return c.json({ error: "rate_limited" }, 429);
  await c.env.CONFIG.put(key, String(n + 1), { expirationTtl: 120 });
  await next();
});

app.get("/", (c) => c.json({ service: "xevrion-autopilot-api", status: "ok", docs: "https://docs.xevrion.co.uk" }));
app.get("/health", async (c) => {
  const db = await c.env.DB.prepare("select count(*) as n from tenants").first<{ n: number }>().catch((e) => ({ error: String(e) }));
  return c.json({ ok: true, env: c.env.ENVIRONMENT, db, stages: STAGES, time: new Date().toISOString() });
});

// TODO(auth): every /v1 route must require a verified session (Cloudflare Access / OIDC) and tenant scoping.
app.use("/v1/*", async (c, next) => {
  if (c.env.ENVIRONMENT === "production" && !c.req.header("cf-access-jwt-assertion"))
    return c.json({ error: "auth_required", detail: "Customer auth not live yet" }, 401);
  await next();
});

app.post("/v1/jobs", async (c) => {
  const body = await c.req.json<{ tenantId: string; kind: string; period?: string }>();
  const id = crypto.randomUUID();
  await c.env.DB.prepare("insert into jobs (id, tenant_id, kind, period, status) values (?,?,?,?, 'queued')")
    .bind(id, body.tenantId, body.kind, body.period ?? null).run();
  await audit(c.env, body.tenantId, "job.created", id);
  await c.env.PIPELINE.send({ jobId: id, tenantId: body.tenantId, stage: "intake" });
  return c.json({ id, status: "queued" }, 201);
});
app.get("/v1/jobs/:id", async (c) => {
  const job = await c.env.DB.prepare("select * from jobs where id=?").bind(c.req.param("id")).first();
  const events = await c.env.DB.prepare("select * from job_events where job_id=? order by created_at").bind(c.req.param("id")).all();
  return job ? c.json({ job, events: events.results }) : c.json({ error: "not_found" }, 404);
});
app.put("/v1/jobs/:id/documents/:name", async (c) => {
  const job = await c.env.DB.prepare("select tenant_id from jobs where id=?").bind(c.req.param("id")).first<{ tenant_id: string }>();
  if (!job) return c.json({ error: "not_found" }, 404);
  const key = `${job.tenant_id}/${c.req.param("id")}/${crypto.randomUUID()}-${c.req.param("name")}`;
  await c.env.DOCS.put(key, c.req.raw.body, { httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" } });
  await c.env.DB.prepare("insert into documents (id, tenant_id, job_id, r2_key, filename) values (?,?,?,?,?)")
    .bind(crypto.randomUUID(), job.tenant_id, c.req.param("id"), key, c.req.param("name")).run();
  return c.json({ stored: true }, 201);
});
app.get("/v1/exceptions", async (c) => {
  const rows = await c.env.DB.prepare("select * from exceptions where status='open' order by created_at limit 100").all();
  return c.json(rows.results);
});

async function audit(env: Env, tenantId: string | null, action: string, subject: string) {
  await env.DB.prepare("insert into audit_log (id, tenant_id, actor, action, subject) values (?,?,?,?,?)")
    .bind(crypto.randomUUID(), tenantId, "system", action, subject).run();
}

export default {
  fetch: app.fetch,
  // Queue consumer: records stage transitions. Heavy AI work runs in the Temporal worker (see local/), which
  // posts results back. Here we only advance state and log, so the edge stays cheap and auditable.
  async queue(batch: MessageBatch<PipelineMsg>, env: Env) {
    for (const m of batch.messages) {
      const { jobId, tenantId, stage } = m.body;
      await env.DB.prepare("insert into job_events (id, job_id, stage, status, detail) values (?,?,?,?,?)")
        .bind(crypto.randomUUID(), jobId, stage, "received", "awaiting worker").run();
      await env.DB.prepare("update jobs set status=?, updated_at=datetime('now') where id=?").bind(`stage:${stage}`, jobId).run();
      await audit(env, tenantId, `pipeline.${stage}`, jobId);
      m.ack();
    }
  },
} satisfies ExportedHandler<Env, PipelineMsg>;
