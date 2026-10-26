export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  CONFIG: KVNamespace;
  PIPELINE: Queue<QueueMessage>;
  ENVIRONMENT: "development" | "test" | "staging" | "production";
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
  /** Secret: Ed25519 private JWK (with kid) that signs agent-review decision receipts. Receipts return 503 when unset. */
  RECEIPT_SIGNING_JWK?: string;
  /** HMAC key (>= 32 chars) for SSO session tokens (ses_...). SSO login is disabled without it. */
  SESSION_SIGNING_KEY?: string;
  /** Public JWKs (JSON array) of retired receipt keys, still published so old receipts keep verifying after rotation. */
  RECEIPT_RETIRED_PUBLIC_JWKS?: string;
  /** Requests per minute per principal (default 600). */
  RATE_LIMIT_PER_MINUTE?: string;
  RATE_LIMIT_LOGIN_PER_MINUTE?: string;
  /** Secret for signing one-click reviewer action tokens (R1). Unset = notifications carry open links only. */
  NOTIFY_ACTION_KEY?: string;
  /** Requests per minute per API key (default 120). */
  RATE_LIMIT_API_KEY_PER_MINUTE?: string;
  /** "1" freezes all writes with 503 (disaster-recovery runbook step 1); reads keep working. */
  MAINTENANCE?: string;
  /** Document retention in days (>= 365). Unset = retention job reports eligible files only (dry run). UNVERIFIED period. */
  DOCUMENT_RETENTION_DAYS?: string;
  /** Comma-separated operator emails allowed to read the cross-tenant ops overview (aggregates only, no PII). */
  ADMIN_EMAILS?: string;
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

export type Role = "owner" | "reviewer" | "accountant";
export interface Principal {
  userId: string;
  tenantId: string;
  email: string;
  role: Role;
  /** Set when authenticated with an API key: scopes gate every route. */
  apiKey?: { id: string; prefix: string; scopes: string[] };
}

export type PracticeRole = "partner" | "manager" | "preparer" | "reviewer" | "readonly";
export interface PracticePrincipal {
  practiceId: string;
  email: string;
  role: PracticeRole;
}
/** A client contact signed in to the portal with a (mock) magic-link session: one business, one practice. */
interface PortalPrincipal {
  portalUserId: string;
  practiceId: string;
  tenantId: string;
  email: string;
}
interface AppVariables {
  requestId: string;
  principal: Principal;
  practice: PracticePrincipal;
  portal: PortalPrincipal;
  identityEmail: string;
  identitySubject: string;
  /** Set when the caller authenticated with an SSO session: the session's tenant wins over x-tenant-id. */
  ssoTenant?: string;
}
export type AppEnv = { Bindings: Env; Variables: AppVariables };
