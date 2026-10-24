-- Xevrion Autopilot: core schema. All tenant data rows carry tenant_id; money stored as integer pence.
create table tenants (id text primary key, name text not null, trading_type text not null default 'sole_trader',
  vat_registered integer not null default 0, vat_scheme text, plan text default 'trial', created_at text default (datetime('now')));
create table users (id text primary key, tenant_id text not null references tenants(id), email text not null,
  role text not null default 'owner', created_at text default (datetime('now')), unique(tenant_id, email));
create table jobs (id text primary key, tenant_id text not null references tenants(id), kind text not null,
  period text, status text not null, qa_score real, created_at text default (datetime('now')), updated_at text);
create table job_events (id text primary key, job_id text not null references jobs(id), stage text not null,
  status text not null, detail text, trace_id text, created_at text default (datetime('now')));
create table documents (id text primary key, tenant_id text not null references tenants(id), job_id text references jobs(id),
  r2_key text not null, filename text, sha256 text, kind text, extracted_json text, created_at text default (datetime('now')));
create table transactions (id text primary key, tenant_id text not null references tenants(id), job_id text references jobs(id),
  source text not null, txn_date text not null, description text, amount_pence integer not null, currency text default 'GBP',
  counterparty text, document_id text references documents(id), created_at text default (datetime('now')));
create table ledger_entries (id text primary key, tenant_id text not null references tenants(id), transaction_id text references transactions(id),
  account_code text not null, category text not null, net_pence integer not null, vat_pence integer not null default 0,
  vat_rate_code text, confidence real, method text, created_at text default (datetime('now')));
create table vat_returns (id text primary key, tenant_id text not null references tenants(id), job_id text references jobs(id),
  period_start text, period_end text, boxes_json text not null, status text not null default 'draft', submitted_at text,
  hmrc_receipt text, created_at text default (datetime('now')));
create table reviews (id text primary key, tenant_id text not null references tenants(id), job_id text not null references jobs(id),
  reviewer text, decision text, notes text, created_at text default (datetime('now')));
create table exceptions (id text primary key, tenant_id text not null references tenants(id), job_id text not null references jobs(id),
  stage text not null, reason text not null, payload_json text, status text not null default 'open', resolved_by text,
  created_at text default (datetime('now')), resolved_at text);
create table audit_log (id text primary key, tenant_id text, actor text not null, action text not null, subject text,
  meta_json text, created_at text default (datetime('now')));
create table billing_events (id text primary key, tenant_id text not null references tenants(id), job_id text references jobs(id),
  event text not null, amount_pence integer, external_ref text, created_at text default (datetime('now')));
create index idx_jobs_tenant on jobs(tenant_id, status);
create index idx_events_job on job_events(job_id);
create index idx_txn_tenant on transactions(tenant_id, txn_date);
create index idx_ledger_tenant on ledger_entries(tenant_id);
create index idx_exc_open on exceptions(status, created_at);
create index idx_audit_tenant on audit_log(tenant_id, created_at);
