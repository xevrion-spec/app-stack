-- Reverts 0019_agent_review_ledger.sql (agent review layer A4). Manual, confirmed rollback only: destroys audit evidence.
drop index if exists idx_rledger_at;
drop table if exists review_ledger;
alter table review_requests drop column chain_head;
alter table review_requests drop column chain_seq;
