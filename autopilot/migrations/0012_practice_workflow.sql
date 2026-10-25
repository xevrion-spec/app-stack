-- Practice work queues and workflow: review claims + log, close checklists, client queries, tasks, time, billing records.
create table if not exists review_claims (
  practice_id text not null references practices(id),
  tenant_id text not null references tenants(id),
  transaction_id text not null,
  assignee text not null,
  claimed_at text not null,
  primary key (tenant_id, transaction_id)
);
create index if not exists idx_review_claims_assignee on review_claims(practice_id, assignee);
-- One row per first-pass review decision: the AI suggestion vs the accountant's final answer (feeds the eval harness).
create table if not exists review_log (
  practice_id text not null references practices(id),
  tenant_id text not null references tenants(id),
  id text not null primary key,
  transaction_id text not null,
  ai_category_code text,
  ai_confidence real,
  final_category_code text not null,
  method text not null check (method in ('manual','bulk','auto_rule','qa')),
  reviewed_by text not null,
  reviewed_at text not null
);
create index if not exists idx_review_log_time on review_log(practice_id, reviewed_at);
create index if not exists idx_review_log_tenant on review_log(practice_id, tenant_id, reviewed_at);
create table if not exists close_templates (
  practice_id text not null references practices(id),
  id text not null primary key,
  name text not null,
  kind text not null check (kind in ('month','quarter','year')),
  items_json text not null,
  created_at text not null default (datetime('now'))
);
create table if not exists close_checklists (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  template_id text,
  name text not null,
  kind text not null,
  period_end text not null,
  status text not null default 'open' check (status in ('open','complete')),
  created_by text not null,
  completed_by text,
  completed_at text,
  created_at text not null default (datetime('now')),
  unique (tenant_id, kind, period_end)
);
create index if not exists idx_checklists_status on close_checklists(practice_id, status, period_end);
create table if not exists close_items (
  practice_id text not null references practices(id),
  checklist_id text not null references close_checklists(id),
  idx integer not null,
  title text not null,
  required integer not null default 1,
  done_by text,
  done_at text,
  note text,
  primary key (checklist_id, idx)
);
create table if not exists client_queries (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  transaction_id text,
  question text not null,
  status text not null default 'open' check (status in ('open','answered','closed')),
  asked_by text not null,
  asked_at text not null,
  answer text,
  answered_by text,
  answered_at text,
  closed_by text,
  closed_at text
);
create index if not exists idx_queries_status on client_queries(practice_id, status, asked_at);
create index if not exists idx_queries_tenant on client_queries(tenant_id, status);
create table if not exists task_templates (
  practice_id text not null references practices(id),
  id text not null primary key,
  name text not null,
  recurrence text not null check (recurrence in ('monthly','quarterly','yearly')),
  due_day integer not null default 28 check (due_day between 1 and 28),
  default_role text check (default_role in ('preparer','reviewer')),
  created_at text not null default (datetime('now'))
);
create table if not exists tasks (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  template_id text,
  title text not null,
  due_date text not null,
  assignee text,
  status text not null default 'todo' check (status in ('todo','doing','done')),
  created_at text not null default (datetime('now')),
  done_at text,
  unique (template_id, tenant_id, due_date)
);
create index if not exists idx_tasks_status on tasks(practice_id, status, due_date);
create table if not exists time_entries (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  email text not null,
  minutes integer not null check (minutes > 0 and minutes <= 1440),
  entry_date text not null,
  note text,
  billable integer not null default 1,
  billing_record_id text,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_time_tenant on time_entries(practice_id, tenant_id, billing_record_id);
-- Internal billing records (what the firm could bill). Never sent, never charged.
create table if not exists billing_records (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  kind text not null check (kind in ('fixed','hourly','outcome')),
  description text not null,
  amount_pence integer not null,
  period_end text not null,
  status text not null default 'ready' check (status in ('ready','billed','void')),
  created_by text not null,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_billing_tenant on billing_records(practice_id, tenant_id, created_at);
