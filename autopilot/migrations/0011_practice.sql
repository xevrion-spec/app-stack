-- Practice (accountancy firm) model: a practice manages many client businesses (tenants). Additive only.
create table if not exists practices (
  id text primary key,
  name text not null,
  plan text not null default 'trial',
  settings_json text not null default '{}',
  created_at text not null default (datetime('now'))
);
create table if not exists practice_staff (
  practice_id text not null references practices(id),
  email text not null,
  role text not null check (role in ('partner','manager','preparer','reviewer','readonly')),
  display_name text,
  created_at text not null default (datetime('now')),
  primary key (practice_id, email)
);
create index if not exists idx_practice_staff_email on practice_staff(email);
create table if not exists practice_clients (
  practice_id text not null references practices(id),
  tenant_id text not null references tenants(id),
  name text not null,
  status text not null default 'onboarding' check (status in ('onboarding','active','archived')),
  year_end text not null default '04-05',
  vat_stagger integer check (vat_stagger in (1,2,3)),
  mtd_itsa integer not null default 0,
  sa_required integer not null default 1,
  fee_model text not null default 'fixed' check (fee_model in ('fixed','hourly','outcome')),
  fee_pence integer not null default 0,
  hourly_rate_pence integer not null default 0,
  auto_approve_json text not null default '{"threshold":0.97,"categories":[]}',
  qa_sample_rate real not null default 0.1,
  review_sla_hours integer not null default 48,
  created_at text not null default (datetime('now')),
  primary key (practice_id, tenant_id)
);
-- A business belongs to at most one practice: the isolation boundary between firms.
create unique index if not exists idx_practice_clients_tenant on practice_clients(tenant_id);
create table if not exists client_assignments (
  practice_id text not null references practices(id),
  tenant_id text not null references tenants(id),
  email text not null,
  role text not null check (role in ('preparer','reviewer')),
  created_at text not null default (datetime('now')),
  primary key (practice_id, tenant_id, email, role)
);
create index if not exists idx_assign_email on client_assignments(practice_id, email);
-- Hash-chained, append-only practice audit log (tamper-evident; see docs/practice.md).
create table if not exists practice_audit (
  practice_id text not null references practices(id),
  seq integer not null,
  id text not null,
  tenant_id text,
  actor text not null,
  action text not null,
  subject text,
  meta_json text,
  created_at text not null,
  prev_hash text not null,
  hash text not null,
  primary key (practice_id, seq)
);
create index if not exists idx_practice_audit_tenant on practice_audit(practice_id, tenant_id, seq);
create trigger if not exists practice_audit_no_update before update on practice_audit
  begin select raise(abort, 'practice_audit is append-only'); end;
create trigger if not exists practice_audit_no_delete before delete on practice_audit
  begin select raise(abort, 'practice_audit is append-only'); end;
-- Review state on transactions (who approved the first pass, how, and QA sampling).
alter table transactions add column reviewed_by text;
alter table transactions add column reviewed_at text;
alter table transactions add column review_method text;
alter table transactions add column qa_sample integer not null default 0;
alter table transactions add column qa_result text;
create index if not exists idx_txn_review on transactions(tenant_id, reviewed_at, created_at);
