-- Practice co-pilot M3: engagement letters, authorisation records (data only, no HMRC calls), document requests,
-- client portal users + mock magic-link tokens (never emailed), working papers with immutable sign-off. Additive only.
create table if not exists engagements (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  services_json text not null,
  fee_summary text not null,
  letter_text text not null,
  letter_sha256 text not null,
  status text not null default 'draft' check (status in ('draft','sent','accepted','withdrawn')),
  created_by text not null,
  created_at text not null,
  sent_at text,
  accepted_by text,
  accepted_at text
);
create index if not exists idx_engagements_tenant on engagements(practice_id, tenant_id, status);
-- Letter text and hash are frozen once sent, so what the client accepted is provable.
create trigger if not exists engagements_frozen before update of letter_text, letter_sha256, services_json, fee_summary on engagements
  when old.status != 'draft' begin select raise(abort, 'engagement letter is frozen once sent'); end;

create table if not exists authorisations (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  kind text not null check (kind in ('agent_64_8','mtd_vat','mtd_itsa','paye','corporation_tax','self_assessment')),
  reference_masked text,
  status text not null default 'requested' check (status in ('requested','confirmed','revoked')),
  evidence_note text,
  recorded_by text not null,
  recorded_at text not null,
  confirmed_at text,
  revoked_at text
);
create index if not exists idx_authorisations_tenant on authorisations(practice_id, tenant_id, kind);

create table if not exists document_requests (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  title text not null,
  due_date text,
  status text not null default 'open' check (status in ('open','fulfilled','waived')),
  document_key text,
  content_type text,
  size_bytes integer,
  sha256 text,
  created_by text not null,
  created_at text not null,
  fulfilled_by text,
  fulfilled_at text
);
create index if not exists idx_docreq_tenant on document_requests(practice_id, tenant_id, status);

create table if not exists portal_users (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  email text not null,
  status text not null default 'active' check (status in ('active','revoked')),
  created_by text not null,
  created_at text not null
);
create unique index if not exists idx_portal_users_email on portal_users(tenant_id, email);
create table if not exists portal_tokens (
  token_hash text not null primary key,
  portal_user_id text not null references portal_users(id),
  kind text not null check (kind in ('magic','session')),
  expires_at text not null,
  used_at text
);
create index if not exists idx_portal_tokens_user on portal_tokens(portal_user_id);

create table if not exists working_papers (
  practice_id text not null references practices(id),
  id text not null primary key,
  tenant_id text not null references tenants(id),
  kind text not null check (kind in ('trial_balance','bank_reconciliation','vat_reconciliation')),
  period_end text not null,
  status text not null default 'prepared' check (status in ('prepared','signed_off')),
  snapshot_json text not null,
  snapshot_sha256 text not null,
  prepared_by text not null,
  prepared_at text not null,
  signed_by text,
  signed_at text,
  sign_note text
);
create index if not exists idx_wp_tenant on working_papers(practice_id, tenant_id, period_end);
create trigger if not exists working_papers_immutable before update on working_papers
  when old.status = 'signed_off' begin select raise(abort, 'signed-off working paper is immutable'); end;
create trigger if not exists working_papers_snapshot_fixed before update of snapshot_json, snapshot_sha256 on working_papers
  begin select raise(abort, 'working paper snapshot is immutable; prepare a new one'); end;
create trigger if not exists working_papers_no_delete before delete on working_papers
  when old.status = 'signed_off' begin select raise(abort, 'signed-off working paper is immutable'); end;
