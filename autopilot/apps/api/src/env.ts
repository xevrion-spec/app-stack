export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  CONFIG: KVNamespace;
  PIPELINE: Queue<PipelineMessage>;
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
}

export interface PipelineMessage {
  jobId: string;
  tenantId: string;
  attempt?: number;
}

export type Role = "owner" | "reviewer";
export interface Principal {
  userId: string;
  tenantId: string;
  email: string;
  role: Role;
}

export interface AppVariables {
  requestId: string;
  principal: Principal;
  identityEmail: string;
  identitySubject: string;
}
export type AppEnv = { Bindings: Env; Variables: AppVariables };
