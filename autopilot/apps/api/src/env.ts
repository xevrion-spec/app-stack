export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  CONFIG: KVNamespace;
  PIPELINE: Queue<QueueMessage>;
  ENVIRONMENT: "development" | "test" | "production";
  ALLOWED_ORIGINS: string;
  /** Cloudflare Access team domain, e.g. "hidden-breeze-99ce.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access application audience tag (AUD). Required in production. */
  ACCESS_AUD?: string;
  /** Optional OpenAI-compatible LLM endpoint (FreeLLMAPI) for categorisation; rules-only when unset. */
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  /** Optional Langfuse (self-hosted) tracing; pipeline traces carry summaries only. */
  LANGFUSE_HOST?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  /** Durable Object namespace for per-tenant realtime fan-out (optional; polling fallback when absent). */
  REALTIME?: DurableObjectNamespace;
  /** Comma-separated hosts allowed over plain http for webhooks (dev only, e.g. 127.0.0.1). */
  WEBHOOK_DEV_HTTP_HOSTS?: string;
  /** Requests per minute per principal (default 600). */
  RATE_LIMIT_PER_MINUTE?: string;
}

export interface PipelineMessage {
  /** Absent = pipeline job (back-compat with messages already in flight). */
  kind?: "pipeline";
  jobId: string;
  tenantId: string;
  attempt?: number;
}
/** Outbox dispatch: deliver these events to automations, webhooks and realtime subscribers. */
export interface EventsMessage {
  kind: "events";
  tenantId: string;
  eventIds: string[];
}
export type QueueMessage = PipelineMessage | EventsMessage;

export type Role = "owner" | "reviewer";
export interface Principal {
  userId: string;
  tenantId: string;
  email: string;
  role: Role;
  /** Set when authenticated with an API key: scopes gate every route. */
  apiKey?: { id: string; prefix: string; scopes: string[] };
}

interface AppVariables {
  requestId: string;
  principal: Principal;
  identityEmail: string;
  identitySubject: string;
}
export type AppEnv = { Bindings: Env; Variables: AppVariables };
