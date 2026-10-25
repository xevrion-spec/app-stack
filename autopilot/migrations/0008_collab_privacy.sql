-- 0008 collaboration, notifications, period close, privacy. ADDITIVE ONLY.
create table if not exists comments (
  id text primary key, tenant_id text not null references tenants(id), subject_type text not null, subject_id text not null,
  body text not null, author text not null, resolved_at text, resolved_by text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create index if not exists idx_comments_subject on comments (tenant_id, subject_type, subject_id);
create table if not exists period_closes (
  id text primary key, tenant_id text not null references tenants(id), period_start text not null, period_end text not null,
  status text not null default 'requested' check (status in ('requested','approved','rejected','reopened')),
  requested_by text not null, decided_by text, note text, decided_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create table if not exists notifications (
  id text primary key, tenant_id text not null references tenants(id), user_email text not null, kind text not null,
  title text not null, body text, link text, read_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create index if not exists idx_notifications_user on notifications (tenant_id, user_email, read_at);
create table if not exists notification_prefs (
  tenant_id text not null references tenants(id), user_email text not null, kind text not null, enabled integer not null,
  primary key (tenant_id, user_email, kind));
create table if not exists consents (
  id text primary key, tenant_id text not null references tenants(id), subject text not null, purpose text not null,
  granted integer not null, source text, recorded_by text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create table if not exists privacy_requests (
  id text primary key, tenant_id text not null references tenants(id), kind text not null check (kind in ('export','erasure')),
  subject text not null, status text not null, result_json text, requested_by text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
