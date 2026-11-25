begin;

-- Customer notifications use their own private outbox. Events are inserted
-- only for future paid/shipped transitions; there is deliberately no backfill.
create table public.amuhon_customer_order_notifications (
  order_id uuid not null references public.amuhon_orders(id) on delete restrict,
  notification_type text not null check (notification_type in ('order_confirmed', 'order_shipped')),
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'needs_review', 'suppressed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  next_attempt_at timestamptz not null default clock_timestamp(),
  first_attempt_at timestamptz,
  lease_id uuid,
  lease_expires_at timestamptz,
  resend_email_id text,
  last_error_code text check (last_error_code is null or last_error_code in (
    'resend_retryable_failure', 'resend_rejected', 'resend_outcome_unknown',
    'customer_recipient_not_allowlisted', 'customer_delivery_configuration_invalid',
    'customer_order_invalid', 'retry_window_expired', 'retry_limit_reached'
  )),
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (order_id, notification_type),
  constraint amuhon_customer_order_notifications_lease_pair check (
    (status = 'sending' and lease_id is not null and lease_expires_at is not null) or
    (status <> 'sending' and lease_id is null and lease_expires_at is null)
  ),
  constraint amuhon_customer_order_notifications_sent_data check (
    (status = 'sent' and sent_at is not null and resend_email_id is not null) or
    (status <> 'sent' and sent_at is null and resend_email_id is null)
  ),
  constraint amuhon_customer_order_notifications_email_id_format check (
    resend_email_id is null or resend_email_id ~ '^[A-Za-z0-9_-]{1,128}$'
  )
);
create index amuhon_customer_order_notifications_due_idx
  on public.amuhon_customer_order_notifications (next_attempt_at, created_at, order_id)
  where status in ('queued', 'sending');
alter table public.amuhon_customer_order_notifications enable row level security;
revoke all on public.amuhon_customer_order_notifications from public, anon, authenticated, service_role;

create table public.amuhon_customer_order_notification_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.amuhon_customer_order_notification_settings (singleton, enabled)
values (true, false);
alter table public.amuhon_customer_order_notification_settings enable row level security;
revoke all on public.amuhon_customer_order_notification_settings from public, anon, authenticated, service_role;

create or replace function public.enqueue_amuhon_customer_order_confirmed_notification_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status is distinct from new.status and new.status = 'paid' then
    insert into public.amuhon_customer_order_notifications (order_id, notification_type, status)
    values (
      new.id, 'order_confirmed',
      case when coalesce((select enabled from public.amuhon_customer_order_notification_settings where singleton), false)
        then 'queued' else 'suppressed' end
    )
    on conflict (order_id, notification_type) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.enqueue_amuhon_customer_order_confirmed_notification_v1() from public, anon, authenticated, service_role;
drop trigger if exists enqueue_amuhon_customer_order_confirmed_notification_after_paid on public.amuhon_orders;
create trigger enqueue_amuhon_customer_order_confirmed_notification_after_paid
after update of status on public.amuhon_orders
for each row
when (old.status is distinct from new.status and new.status = 'paid')
execute function public.enqueue_amuhon_customer_order_confirmed_notification_v1();

create or replace function public.enqueue_amuhon_customer_order_shipped_notification_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.printer_submission_status = 'submitted' and
     old.printer_submission_status is distinct from new.printer_submission_status and
     new.printer_submission_status = 'shipped' then
    insert into public.amuhon_customer_order_notifications (order_id, notification_type, status)
    values (
      new.id, 'order_shipped',
      case when coalesce((select enabled from public.amuhon_customer_order_notification_settings where singleton), false)
        then 'queued' else 'suppressed' end
    )
    on conflict (order_id, notification_type) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.enqueue_amuhon_customer_order_shipped_notification_v1() from public, anon, authenticated, service_role;
drop trigger if exists enqueue_amuhon_customer_order_shipped_notification_after_shipped on public.amuhon_orders;
create trigger enqueue_amuhon_customer_order_shipped_notification_after_shipped
after update of printer_submission_status on public.amuhon_orders
for each row
when (old.printer_submission_status = 'submitted' and old.printer_submission_status is distinct from new.printer_submission_status and new.printer_submission_status = 'shipped')
execute function public.enqueue_amuhon_customer_order_shipped_notification_v1();

create or replace function public.claim_amuhon_customer_order_notification_v1(
  p_order_id uuid,
  p_notification_type text,
  p_lease_seconds integer default 90
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  notification public.amuhon_customer_order_notifications%rowtype;
  target public.amuhon_orders%rowtype;
  notifications_enabled boolean;
  notification_lease uuid;
  email_value text;
  title_value text;
begin
  if p_order_id is null or p_notification_type is null or p_notification_type not in ('order_confirmed', 'order_shipped') or
     p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'INVALID_CUSTOMER_ORDER_NOTIFICATION_CLAIM';
  end if;

  select * into notification
  from public.amuhon_customer_order_notifications
  where order_id = p_order_id and notification_type = p_notification_type
  for update;
  if not found then return jsonb_build_object('state', 'missing'); end if;
  if notification.status = 'suppressed' then return jsonb_build_object('state', 'suppressed'); end if;
  select enabled into notifications_enabled from public.amuhon_customer_order_notification_settings where singleton;
  if not coalesce(notifications_enabled, false) then return jsonb_build_object('state', 'disabled'); end if;
  if notification.status = 'sent' then return jsonb_build_object('state', 'sent'); end if;
  if notification.status = 'needs_review' then return jsonb_build_object('state', 'needs_review'); end if;
  if notification.status = 'sending' and notification.lease_expires_at > clock_timestamp() then
    return jsonb_build_object('state', 'busy');
  end if;

  if notification.first_attempt_at is not null and
     notification.first_attempt_at <= clock_timestamp() - interval '23 hours' then
    update public.amuhon_customer_order_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = 'retry_window_expired', updated_at = clock_timestamp()
    where order_id = p_order_id and notification_type = p_notification_type;
    return jsonb_build_object('state', 'needs_review');
  end if;
  if notification.attempt_count >= 8 then
    update public.amuhon_customer_order_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = 'retry_limit_reached', updated_at = clock_timestamp()
    where order_id = p_order_id and notification_type = p_notification_type;
    return jsonb_build_object('state', 'needs_review');
  end if;
  if notification.status = 'queued' and notification.next_attempt_at > clock_timestamp() then
    return jsonb_build_object('state', 'retry_wait');
  end if;

  select * into target from public.amuhon_orders where id = p_order_id for share;
  if not found or target.status is distinct from 'paid' or
     (p_notification_type = 'order_shipped' and target.printer_submission_status is distinct from 'shipped') then
    update public.amuhon_customer_order_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = 'customer_order_invalid', updated_at = clock_timestamp()
    where order_id = p_order_id and notification_type = p_notification_type;
    return jsonb_build_object('state', 'needs_review');
  end if;

  email_value := target.customer ->> 'email';
  title_value := target.book_snapshot ->> 'title';
  if jsonb_typeof(target.customer) is distinct from 'object' or
     email_value is null or length(email_value) > 254 or
     email_value !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+[.][^[:space:]@<>]+$' or
     jsonb_typeof(target.book_snapshot) is distinct from 'object' or
     title_value is null or char_length(btrim(title_value)) not between 1 and 200 or
     target.amount_minor is null or target.amount_minor <= 0 or target.currency is distinct from 'JPY' or
     target.shipping_minor is distinct from 0 or target.stripe_payment_id is null or
     target.stripe_payment_id !~ '^pi_[A-Za-z0-9]+$' then
    update public.amuhon_customer_order_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = 'customer_order_invalid', updated_at = clock_timestamp()
    where order_id = p_order_id and notification_type = p_notification_type;
    return jsonb_build_object('state', 'needs_review');
  end if;

  notification_lease := pg_catalog.gen_random_uuid();
  update public.amuhon_customer_order_notifications set
    status = 'sending', attempt_count = attempt_count + 1,
    first_attempt_at = coalesce(first_attempt_at, clock_timestamp()),
    lease_id = notification_lease,
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    last_error_code = null, updated_at = clock_timestamp()
  where order_id = p_order_id and notification_type = p_notification_type;

  return jsonb_build_object(
    'state', 'claimed',
    'notificationType', case when p_notification_type = 'order_confirmed' then 'customer_order_confirmed' else 'customer_order_shipped' end,
    'orderId', target.id,
    'leaseId', notification_lease,
    'orderNumber', 'AMU-' || to_char(target.created_at, 'YYYYMMDD') || '-' ||
      upper(substr(replace(target.id::text, '-', ''), 1, 8)),
    'title', title_value,
    'amountYen', target.amount_minor,
    'recipientEmail', email_value
  );
end;
$$;
revoke all on function public.claim_amuhon_customer_order_notification_v1(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_amuhon_customer_order_notification_v1(uuid, text, integer) to service_role;

create or replace function public.complete_amuhon_customer_order_notification_v1(
  p_order_id uuid,
  p_notification_type text,
  p_lease_id uuid,
  p_resend_email_id text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare changed integer;
begin
  if p_order_id is null or p_notification_type is null or p_notification_type not in ('order_confirmed', 'order_shipped') or
     p_lease_id is null or p_resend_email_id is null or p_resend_email_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'INVALID_CUSTOMER_ORDER_NOTIFICATION_COMPLETION';
  end if;
  update public.amuhon_customer_order_notifications set
    status = 'sent', resend_email_id = p_resend_email_id, sent_at = clock_timestamp(),
    lease_id = null, lease_expires_at = null, last_error_code = null, updated_at = clock_timestamp()
  where order_id = p_order_id and notification_type = p_notification_type and
        status = 'sending' and lease_id = p_lease_id;
  get diagnostics changed = row_count;
  if changed = 1 then return jsonb_build_object('state', 'sent'); end if;
  if exists (select 1 from public.amuhon_customer_order_notifications
    where order_id = p_order_id and notification_type = p_notification_type and status = 'sent') then
    return jsonb_build_object('state', 'sent');
  end if;
  return jsonb_build_object('state', 'lease_lost');
end;
$$;
revoke all on function public.complete_amuhon_customer_order_notification_v1(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.complete_amuhon_customer_order_notification_v1(uuid, text, uuid, text) to service_role;

create or replace function public.fail_amuhon_customer_order_notification_v1(
  p_order_id uuid,
  p_notification_type text,
  p_lease_id uuid,
  p_error_code text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  notification public.amuhon_customer_order_notifications%rowtype;
  terminal boolean;
  delay_seconds integer;
begin
  if p_order_id is null or p_notification_type is null or p_notification_type not in ('order_confirmed', 'order_shipped') or p_lease_id is null or
     p_error_code is null or p_error_code not in (
       'resend_retryable_failure', 'resend_rejected', 'resend_outcome_unknown',
       'customer_recipient_not_allowlisted', 'customer_delivery_configuration_invalid', 'customer_order_invalid'
     ) then
    raise exception 'INVALID_CUSTOMER_ORDER_NOTIFICATION_FAILURE';
  end if;
  select * into notification from public.amuhon_customer_order_notifications
  where order_id = p_order_id and notification_type = p_notification_type and
        status = 'sending' and lease_id = p_lease_id
  for update;
  if not found then return jsonb_build_object('state', 'lease_lost'); end if;

  terminal := p_error_code in ('customer_recipient_not_allowlisted', 'customer_delivery_configuration_invalid', 'customer_order_invalid') or
    notification.attempt_count >= 8 or
    notification.first_attempt_at <= clock_timestamp() - interval '23 hours';
  if terminal then
    update public.amuhon_customer_order_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = case
        when notification.attempt_count >= 8 then 'retry_limit_reached'
        when notification.first_attempt_at <= clock_timestamp() - interval '23 hours' then 'retry_window_expired'
        else p_error_code end,
      updated_at = clock_timestamp()
    where order_id = p_order_id and notification_type = p_notification_type;
    return jsonb_build_object('state', 'needs_review');
  end if;
  delay_seconds := least(3600, 30 * (2 ^ greatest(notification.attempt_count - 1, 0))::integer);
  update public.amuhon_customer_order_notifications set
    status = 'queued', next_attempt_at = clock_timestamp() + make_interval(secs => delay_seconds),
    lease_id = null, lease_expires_at = null, last_error_code = p_error_code, updated_at = clock_timestamp()
  where order_id = p_order_id and notification_type = p_notification_type;
  return jsonb_build_object('state', 'queued');
end;
$$;
revoke all on function public.fail_amuhon_customer_order_notification_v1(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_amuhon_customer_order_notification_v1(uuid, text, uuid, text) to service_role;

-- The shared notification worker claims from both private queues in due-time
-- order. It locks at most one candidate from each queue and uses SKIP LOCKED;
-- the selected per-event claim performs all final validation and lease writes.
create or replace function public.claim_next_amuhon_email_notification_v1(p_lease_seconds integer default 90)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  paid_enabled boolean;
  customer_enabled boolean;
  paid_order_id uuid;
  paid_due_at timestamptz;
  customer_order_id uuid;
  customer_type text;
  customer_due_at timestamptz;
  claimed jsonb;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'INVALID_ORDER_NOTIFICATION_CLAIM';
  end if;
  select coalesce((select enabled from public.amuhon_order_paid_notification_settings where singleton), false) into paid_enabled;
  select coalesce((select enabled from public.amuhon_customer_order_notification_settings where singleton), false) into customer_enabled;
  if not paid_enabled and not customer_enabled then return jsonb_build_object('state', 'disabled'); end if;

  if paid_enabled then
    select order_id, next_attempt_at into paid_order_id, paid_due_at
    from public.amuhon_order_paid_notifications
    where (status = 'queued' and next_attempt_at <= clock_timestamp()) or
          (status = 'sending' and lease_expires_at <= clock_timestamp())
    order by next_attempt_at, created_at, order_id
    for update skip locked limit 1;
  end if;
  if customer_enabled then
    select order_id, notification_type, next_attempt_at into customer_order_id, customer_type, customer_due_at
    from public.amuhon_customer_order_notifications
    where (status = 'queued' and next_attempt_at <= clock_timestamp()) or
          (status = 'sending' and lease_expires_at <= clock_timestamp())
    order by next_attempt_at, created_at, order_id, notification_type
    for update skip locked limit 1;
  end if;

  if paid_order_id is null and customer_order_id is null then return jsonb_build_object('state', 'idle'); end if;
  if customer_order_id is null or (paid_order_id is not null and paid_due_at <= customer_due_at) then
    claimed := public.claim_amuhon_order_paid_notification_v1(paid_order_id, p_lease_seconds);
    return claimed || jsonb_build_object('notificationType', 'operator_paid');
  end if;
  return public.claim_amuhon_customer_order_notification_v1(customer_order_id, customer_type, p_lease_seconds);
end;
$$;
revoke all on function public.claim_next_amuhon_email_notification_v1(integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_next_amuhon_email_notification_v1(integer) to service_role;

-- Keep the existing webhook compatibility field and expose the new customer
-- receipt state for first-time paid transitions. Historical duplicates remain
-- unbackfilled and are acknowledged by the application.
create or replace function public.get_amuhon_order_paid_notification_webhook_status_v1(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare paid_status text; customer_status text;
begin
  if p_order_id is null then raise exception 'INVALID_ORDER_NOTIFICATION_STATUS'; end if;
  select status into paid_status from public.amuhon_order_paid_notifications where order_id = p_order_id;
  select status into customer_status from public.amuhon_customer_order_notifications
    where order_id = p_order_id and notification_type = 'order_confirmed';
  return jsonb_build_object(
    'state', coalesce(paid_status, 'missing'),
    'customerState', coalesce(customer_status, 'missing')
  );
end;
$$;
revoke all on function public.get_amuhon_order_paid_notification_webhook_status_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_order_paid_notification_webhook_status_v1(uuid) to service_role;

create or replace function public.get_amuhon_admin_order_customer_notification_status_v1(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  confirmation public.amuhon_customer_order_notifications%rowtype;
  shipment public.amuhon_customer_order_notifications%rowtype;
begin
  if p_order_id is null then raise exception 'INVALID_CUSTOMER_ORDER_NOTIFICATION_STATUS'; end if;
  select * into confirmation from public.amuhon_customer_order_notifications
    where order_id = p_order_id and notification_type = 'order_confirmed';
  select * into shipment from public.amuhon_customer_order_notifications
    where order_id = p_order_id and notification_type = 'order_shipped';
  return jsonb_build_object(
    'orderConfirmed', jsonb_build_object(
      'state', coalesce(confirmation.status, 'not_created'),
      'attemptCount', confirmation.attempt_count,
      'errorCode', confirmation.last_error_code,
      'nextAttemptAt', case when confirmation.status = 'queued' then confirmation.next_attempt_at else null end,
      'sentAt', confirmation.sent_at
    ),
    'orderShipped', jsonb_build_object(
      'state', coalesce(shipment.status, 'not_created'),
      'attemptCount', shipment.attempt_count,
      'errorCode', shipment.last_error_code,
      'nextAttemptAt', case when shipment.status = 'queued' then shipment.next_attempt_at else null end,
      'sentAt', shipment.sent_at
    )
  );
end;
$$;
revoke all on function public.get_amuhon_admin_order_customer_notification_status_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_admin_order_customer_notification_status_v1(uuid) to service_role;

comment on table public.amuhon_customer_order_notifications is
  'Private outbox for future customer order-confirmation and first-shipment messages; no historical backfill.';
comment on table public.amuhon_customer_order_notification_settings is
  'Private opt-in switch for customer messages; events observed while disabled are permanently suppressed.';

notify pgrst, 'reload schema';
commit;
