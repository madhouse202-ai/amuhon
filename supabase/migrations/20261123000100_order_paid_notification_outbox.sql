begin;

-- Notifications are created only for future paid-state transitions. There is
-- deliberately no backfill so historical test orders never send mail.
create table public.amuhon_order_paid_notifications (
  order_id uuid primary key references public.amuhon_orders(id) on delete restrict,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'needs_review', 'suppressed')),
  attempt_count integer not null default 0
    check (attempt_count between 0 and 8),
  next_attempt_at timestamptz not null default clock_timestamp(),
  first_attempt_at timestamptz,
  lease_id uuid,
  lease_expires_at timestamptz,
  resend_email_id text,
  last_error_code text check (last_error_code is null or last_error_code in (
    'resend_retryable_failure', 'resend_rejected', 'resend_outcome_unknown',
    'notification_job_invalid', 'order_not_paid', 'retry_window_expired', 'retry_limit_reached'
  )),
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint amuhon_order_paid_notifications_lease_pair check (
    (status = 'sending' and lease_id is not null and lease_expires_at is not null) or
    (status <> 'sending' and lease_id is null and lease_expires_at is null)
  ),
  constraint amuhon_order_paid_notifications_sent_data check (
    (status = 'sent' and sent_at is not null and resend_email_id is not null) or
    (status <> 'sent' and sent_at is null and resend_email_id is null)
  ),
  constraint amuhon_order_paid_notifications_email_id_format check (
    resend_email_id is null or resend_email_id ~ '^[A-Za-z0-9_-]{1,128}$'
  )
);

create index amuhon_order_paid_notifications_due_idx
  on public.amuhon_order_paid_notifications (next_attempt_at, created_at)
  where status in ('queued', 'sending');

alter table public.amuhon_order_paid_notifications enable row level security;
revoke all on public.amuhon_order_paid_notifications from public, anon, authenticated, service_role;

-- This database-side switch is the source of truth. Paid transitions while
-- disabled are durably marked suppressed and are never released by enabling
-- notifications later. No historical rows are backfilled.
create table public.amuhon_order_paid_notification_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.amuhon_order_paid_notification_settings (singleton, enabled)
values (true, false);
alter table public.amuhon_order_paid_notification_settings enable row level security;
revoke all on public.amuhon_order_paid_notification_settings from public, anon, authenticated, service_role;

create or replace function public.enqueue_amuhon_order_paid_notification_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status is distinct from new.status and new.status = 'paid' then
    insert into public.amuhon_order_paid_notifications (order_id, status)
    values (
      new.id,
      case when coalesce((select enabled from public.amuhon_order_paid_notification_settings where singleton), false)
        then 'queued' else 'suppressed' end
    )
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.enqueue_amuhon_order_paid_notification_v1() from public, anon, authenticated, service_role;

drop trigger if exists enqueue_amuhon_order_paid_notification_after_paid on public.amuhon_orders;
create trigger enqueue_amuhon_order_paid_notification_after_paid
after update of status on public.amuhon_orders
for each row
when (old.status is distinct from new.status and new.status = 'paid')
execute function public.enqueue_amuhon_order_paid_notification_v1();

create or replace function public.claim_amuhon_order_paid_notification_v1(
  p_order_id uuid,
  p_lease_seconds integer default 90
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  notification public.amuhon_order_paid_notifications%rowtype;
  target public.amuhon_orders%rowtype;
  expected_amount bigint;
  notification_lease uuid;
  title_value text;
  notifications_enabled boolean;
begin
  if p_order_id is null or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'INVALID_ORDER_NOTIFICATION_CLAIM';
  end if;

  select * into notification
  from public.amuhon_order_paid_notifications
  where order_id = p_order_id
  for update;
  if not found then return jsonb_build_object('state', 'missing'); end if;
  if notification.status = 'suppressed' then
    return jsonb_build_object('state', 'suppressed');
  end if;
  select enabled into notifications_enabled from public.amuhon_order_paid_notification_settings where singleton;
  if not coalesce(notifications_enabled, false) then return jsonb_build_object('state', 'disabled'); end if;
  if notification.status = 'sent' then return jsonb_build_object('state', 'sent'); end if;
  if notification.status = 'needs_review' then return jsonb_build_object('state', 'needs_review'); end if;
  if notification.status = 'sending' and notification.lease_expires_at > clock_timestamp() then
    return jsonb_build_object('state', 'busy');
  end if;

  -- Resend retains idempotency keys for 24 hours. Stop automatic retries
  -- before that window expires so an ambiguous send cannot become a duplicate.
  if notification.first_attempt_at is not null and
     notification.first_attempt_at <= clock_timestamp() - interval '23 hours' then
    update public.amuhon_order_paid_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = 'retry_window_expired', updated_at = clock_timestamp()
    where order_id = p_order_id;
    return jsonb_build_object('state', 'needs_review');
  end if;
  if notification.attempt_count >= 8 then
    update public.amuhon_order_paid_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = 'retry_limit_reached', updated_at = clock_timestamp()
    where order_id = p_order_id;
    return jsonb_build_object('state', 'needs_review');
  end if;
  if notification.status = 'queued' and notification.next_attempt_at > clock_timestamp() then
    return jsonb_build_object('state', 'retry_wait');
  end if;

  select * into target from public.amuhon_orders where id = p_order_id;
  if not found or target.status is distinct from 'paid' then
    update public.amuhon_order_paid_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = 'order_not_paid', updated_at = clock_timestamp()
    where order_id = p_order_id;
    return jsonb_build_object('state', 'needs_review');
  end if;

  expected_amount := case
    when target.body_pdf_page_count between 24 and 100 then 1980
    when target.body_pdf_page_count between 101 and 150 then 2280
    when target.body_pdf_page_count between 151 and 200 then 2580
    when target.body_pdf_page_count between 201 and 250 then 2880
    when target.body_pdf_page_count between 251 and 300 then 3180
    else null
  end;
  title_value := target.book_snapshot ->> 'title';
  if target.files_validated_at is null or target.body_pdf_page_count is null or
     target.body_pdf_page_count % 8 <> 0 or expected_amount is null or
     (target.declared_body_pdf_page_count is not null and
      target.declared_body_pdf_page_count is distinct from target.body_pdf_page_count) or
     target.body_pdf_storage_path is null or target.cover_png_storage_path is null or
     target.body_pdf_sha256 is null or target.body_pdf_sha256 !~ '^[a-f0-9]{64}$' or
     target.cover_png_sha256 is null or target.cover_png_sha256 !~ '^[a-f0-9]{64}$' or
     target.amount_minor is distinct from expected_amount or target.currency is distinct from 'JPY' or
     target.shipping_minor is distinct from 0 or target.stripe_payment_id is null or
     target.stripe_payment_id !~ '^pi_[A-Za-z0-9]+$' or
     jsonb_typeof(target.book_snapshot) is distinct from 'object' or
     jsonb_typeof(target.book_snapshot -> 'title') is distinct from 'string' or
     title_value is null or char_length(btrim(title_value)) not between 1 and 200 then
    update public.amuhon_order_paid_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = 'notification_job_invalid', updated_at = clock_timestamp()
    where order_id = p_order_id;
    return jsonb_build_object('state', 'needs_review');
  end if;

  notification_lease := pg_catalog.gen_random_uuid();
  update public.amuhon_order_paid_notifications set
    status = 'sending', attempt_count = attempt_count + 1,
    first_attempt_at = coalesce(first_attempt_at, clock_timestamp()),
    lease_id = notification_lease,
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    last_error_code = null, updated_at = clock_timestamp()
  where order_id = p_order_id;

  return jsonb_build_object(
    'state', 'claimed',
    'orderId', target.id,
    'leaseId', notification_lease,
    'orderNumber', 'AMU-' || to_char(target.created_at, 'YYYYMMDD') || '-' ||
      upper(substr(replace(target.id::text, '-', ''), 1, 8)),
    'title', title_value,
    'pageCount', target.body_pdf_page_count,
    'amountYen', target.amount_minor
  );
end;
$$;
revoke all on function public.claim_amuhon_order_paid_notification_v1(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_amuhon_order_paid_notification_v1(uuid, integer) to service_role;

create or replace function public.claim_next_amuhon_order_paid_notification_v1(
  p_lease_seconds integer default 90
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  candidate_order_id uuid;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'INVALID_ORDER_NOTIFICATION_CLAIM';
  end if;
  if not coalesce((select enabled from public.amuhon_order_paid_notification_settings where singleton), false) then
    return jsonb_build_object('state', 'disabled');
  end if;

  -- Lock only one due row, skipping rows claimed by another worker. The
  -- per-order claim performs the full paid/order/amount validation.
  select order_id into candidate_order_id
  from public.amuhon_order_paid_notifications
  where (status = 'queued' and next_attempt_at <= clock_timestamp()) or
        (status = 'sending' and lease_expires_at <= clock_timestamp())
  order by next_attempt_at, created_at, order_id
  for update skip locked
  limit 1;
  if not found then return jsonb_build_object('state', 'idle'); end if;
  return public.claim_amuhon_order_paid_notification_v1(candidate_order_id, p_lease_seconds);
end;
$$;
revoke all on function public.claim_next_amuhon_order_paid_notification_v1(integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_next_amuhon_order_paid_notification_v1(integer) to service_role;

create or replace function public.complete_amuhon_order_paid_notification_v1(
  p_order_id uuid,
  p_lease_id uuid,
  p_resend_email_id text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  changed integer;
begin
  if p_order_id is null or p_lease_id is null or p_resend_email_id is null or
     p_resend_email_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'INVALID_ORDER_NOTIFICATION_COMPLETION';
  end if;
  update public.amuhon_order_paid_notifications set
    status = 'sent', resend_email_id = p_resend_email_id,
    sent_at = clock_timestamp(), lease_id = null, lease_expires_at = null,
    last_error_code = null, updated_at = clock_timestamp()
  where order_id = p_order_id and status = 'sending' and lease_id = p_lease_id;
  get diagnostics changed = row_count;
  if changed = 1 then return jsonb_build_object('state', 'sent'); end if;
  if exists (select 1 from public.amuhon_order_paid_notifications
      where order_id = p_order_id and status = 'sent') then
    return jsonb_build_object('state', 'sent');
  end if;
  return jsonb_build_object('state', 'lease_lost');
end;
$$;
revoke all on function public.complete_amuhon_order_paid_notification_v1(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.complete_amuhon_order_paid_notification_v1(uuid, uuid, text) to service_role;

create or replace function public.fail_amuhon_order_paid_notification_v1(
  p_order_id uuid,
  p_lease_id uuid,
  p_error_code text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  notification public.amuhon_order_paid_notifications%rowtype;
  terminal boolean;
  delay_seconds integer;
begin
  if p_order_id is null or p_lease_id is null or p_error_code is null or p_error_code not in (
    'resend_retryable_failure', 'resend_rejected', 'resend_outcome_unknown',
    'notification_job_invalid', 'order_not_paid'
  ) then
    raise exception 'INVALID_ORDER_NOTIFICATION_FAILURE';
  end if;
  select * into notification from public.amuhon_order_paid_notifications
  where order_id = p_order_id and status = 'sending' and lease_id = p_lease_id
  for update;
  if not found then return jsonb_build_object('state', 'lease_lost'); end if;

  terminal := p_error_code in ('notification_job_invalid', 'order_not_paid') or
    notification.attempt_count >= 8 or
    notification.first_attempt_at <= clock_timestamp() - interval '23 hours';
  if terminal then
    update public.amuhon_order_paid_notifications set
      status = 'needs_review', lease_id = null, lease_expires_at = null,
      last_error_code = case
        when notification.attempt_count >= 8 then 'retry_limit_reached'
        when notification.first_attempt_at <= clock_timestamp() - interval '23 hours' then 'retry_window_expired'
        else p_error_code
      end,
      updated_at = clock_timestamp()
    where order_id = p_order_id;
    return jsonb_build_object('state', 'needs_review');
  end if;

  delay_seconds := least(3600, 30 * (2 ^ greatest(notification.attempt_count - 1, 0))::integer);
  update public.amuhon_order_paid_notifications set
    status = 'queued', next_attempt_at = clock_timestamp() + make_interval(secs => delay_seconds),
    lease_id = null, lease_expires_at = null, last_error_code = p_error_code,
    updated_at = clock_timestamp()
  where order_id = p_order_id;
  return jsonb_build_object('state', 'queued');
end;
$$;
revoke all on function public.fail_amuhon_order_paid_notification_v1(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_amuhon_order_paid_notification_v1(uuid, uuid, text) to service_role;

create or replace function public.get_amuhon_order_paid_notification_webhook_status_v1(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_status text;
begin
  if p_order_id is null then raise exception 'INVALID_ORDER_NOTIFICATION_STATUS'; end if;
  select status into current_status
  from public.amuhon_order_paid_notifications
  where order_id = p_order_id;
  return jsonb_build_object('state', coalesce(current_status, 'missing'));
end;
$$;
revoke all on function public.get_amuhon_order_paid_notification_webhook_status_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_order_paid_notification_webhook_status_v1(uuid) to service_role;

create or replace function public.get_amuhon_admin_order_paid_notification_status_v1(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  notification public.amuhon_order_paid_notifications%rowtype;
begin
  if p_order_id is null then raise exception 'INVALID_ORDER_NOTIFICATION_STATUS'; end if;
  select * into notification
  from public.amuhon_order_paid_notifications
  where order_id = p_order_id;
  if not found then return jsonb_build_object('state', 'not_created'); end if;
  return jsonb_build_object(
    'state', notification.status,
    'attemptCount', notification.attempt_count,
    'errorCode', notification.last_error_code,
    'nextAttemptAt', case when notification.status = 'queued' then notification.next_attempt_at else null end,
    'sentAt', notification.sent_at
  );
end;
$$;
revoke all on function public.get_amuhon_admin_order_paid_notification_status_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_admin_order_paid_notification_status_v1(uuid) to service_role;

comment on table public.amuhon_order_paid_notifications is
  'Private outbox for one-time operator notification after a future verified paid transition; never backfilled.';
comment on function public.claim_amuhon_order_paid_notification_v1(uuid, integer) is
  'Service-only atomic claim. Returns only the validated order summary needed for a paid-order notification.';
comment on function public.claim_next_amuhon_order_paid_notification_v1(integer) is
  'Service-only single-row claim for the independent order notification worker; honors the database enable switch.';
comment on table public.amuhon_order_paid_notification_settings is
  'Private database-side opt-in switch; paid orders transitioned while disabled are suppressed permanently.';

notify pgrst, 'reload schema';
commit;
