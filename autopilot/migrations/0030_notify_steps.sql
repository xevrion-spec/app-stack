-- R3 gap fixes: a delivery belongs to one chain step, so later approvers are notified when a chain advances, and the
-- same person is never messaged twice for the same step of the same request on the same channel.
alter table notify_deliveries add column step integer not null default 0;
create unique index if not exists uq_nd_step on notify_deliveries(tenant_id, request_id, channel_id, coalesce(recipient, ''), step);
