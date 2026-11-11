-- Add explicit Stripe test/live mode binding without rewriting the already-applied checkout migration.
-- Apply after 20261103000100_order_stripe_checkout.sql.

alter table public.amuhon_orders
  add column if not exists stripe_checkout_livemode boolean;

-- Existing checkout attempts and paid rows could only have been produced by the test-only RPCs.
update public.amuhon_orders
set stripe_checkout_livemode = false
where stripe_checkout_livemode is null
  and (stripe_checkout_attempt_id is not null
    or stripe_checkout_session_id is not null
    or stripe_payment_id is not null
    or status = 'paid');

alter table public.amuhon_stripe_webhook_events
  add column if not exists livemode boolean not null default false;

alter table public.amuhon_stripe_webhook_events
  drop constraint if exists amuhon_stripe_webhook_events_checkout_session_id_check;

alter table public.amuhon_stripe_webhook_events
  add constraint amuhon_stripe_webhook_events_session_mode
  check (
    (livemode = false and checkout_session_id ~ '^cs_test_[A-Za-z0-9]+$') or
    (livemode = true and checkout_session_id ~ '^cs_live_[A-Za-z0-9]+$')
  );

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.amuhon_orders'::regclass
      and conname = 'amuhon_orders_checkout_attempt_mode_required'
  ) then
    alter table public.amuhon_orders add constraint amuhon_orders_checkout_attempt_mode_required
      check (stripe_checkout_attempt_id is null or stripe_checkout_livemode is not null);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.amuhon_orders'::regclass
      and conname = 'amuhon_orders_checkout_session_mode'
  ) then
    alter table public.amuhon_orders add constraint amuhon_orders_checkout_session_mode
      check (
        stripe_checkout_session_id is null or
        (stripe_checkout_livemode is false and stripe_checkout_session_id ~ '^cs_test_[A-Za-z0-9]+$') or
        (stripe_checkout_livemode is true and stripe_checkout_session_id ~ '^cs_live_[A-Za-z0-9]+$')
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.amuhon_orders'::regclass
      and conname = 'amuhon_orders_payment_mode_required'
  ) then
    alter table public.amuhon_orders add constraint amuhon_orders_payment_mode_required
      check (stripe_payment_id is null or stripe_checkout_livemode is not null);
  end if;
end;
$$;

create or replace function public.get_amuhon_order_checkout_status(
  p_order_id uuid,
  p_upload_token_hash text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  quoted_amount bigint;
  files_verified boolean;
  price_consistent boolean;
  can_checkout boolean;
  checkout_state text;
begin
  if p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'ORDER_NOT_AUTHORIZED';
  end if;
  select * into target from public.amuhon_orders where id = p_order_id;
  if not found or target.upload_token_hash is distinct from p_upload_token_hash then
    raise exception 'ORDER_NOT_AUTHORIZED';
  end if;

  quoted_amount := case
    when target.body_pdf_page_count between 24 and 100 then 1980
    when target.body_pdf_page_count between 101 and 150 then 2280
    when target.body_pdf_page_count between 151 and 200 then 2580
    when target.body_pdf_page_count between 201 and 250 then 2880
    when target.body_pdf_page_count between 251 and 300 then 3180
    else null
  end;
  files_verified := target.files_validated_at is not null and
    target.body_pdf_page_count is not null and
    (target.declared_body_pdf_page_count is null or target.declared_body_pdf_page_count = target.body_pdf_page_count) and
    target.body_pdf_storage_path is not null and target.cover_png_storage_path is not null and
    target.body_pdf_sha256 is not null and target.cover_png_sha256 is not null;
  price_consistent := coalesce(
    (target.amount_minor is null and target.currency is null and target.shipping_minor is null) or
    (target.amount_minor = quoted_amount and target.currency = 'JPY' and target.shipping_minor = 0), false);
  can_checkout := files_verified and quoted_amount is not null and price_consistent and
    target.status in ('preparing', 'ready_for_payment') and
    (target.stripe_checkout_attempt_id is null or target.stripe_checkout_session_id is not null or
     target.stripe_checkout_started_at > now() - interval '30 minutes') and
    (target.stripe_checkout_session_id is null or target.stripe_checkout_expires_at > now());
  checkout_state := case
    when target.status = 'paid' then 'paid'
    when target.stripe_checkout_session_id is not null and target.stripe_checkout_expires_at <= now() then 'expired_review_required'
    when target.stripe_checkout_attempt_id is not null and target.stripe_checkout_session_id is null and
         target.stripe_checkout_started_at <= now() - interval '30 minutes' then 'uncertain_review_required'
    when target.stripe_checkout_session_id is not null then 'session_available'
    when target.stripe_checkout_attempt_id is not null then 'session_creation_pending'
    else 'not_started'
  end;

  return jsonb_build_object(
    'orderId', target.id,
    'status', target.status,
    'pageCount', target.body_pdf_page_count,
    'filesVerified', files_verified,
    'quotedAmountYen', quoted_amount,
    'amountYen', target.amount_minor,
    'currency', coalesce(target.currency, case when quoted_amount is not null then 'JPY' else null end),
    'priceConsistent', price_consistent,
    'canCheckout', coalesce(can_checkout, false),
    'checkoutState', checkout_state,
    'livemode', target.stripe_checkout_livemode
  );
end;
$$;
revoke all on function public.get_amuhon_order_checkout_status(uuid, text) from public, anon, authenticated;
grant execute on function public.get_amuhon_order_checkout_status(uuid, text) to service_role;

create or replace function public.begin_amuhon_order_checkout_v2(
  p_order_id uuid,
  p_upload_token_hash text,
  p_checkout_attempt_id uuid,
  p_livemode boolean
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  quoted_amount bigint;
  attempt_started timestamptz;
begin
  if p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' or
     p_checkout_attempt_id is null or p_livemode is null then
    raise exception 'ORDER_NOT_AUTHORIZED';
  end if;
  select * into target from public.amuhon_orders where id = p_order_id for update;
  if not found or target.upload_token_hash is distinct from p_upload_token_hash then
    raise exception 'ORDER_NOT_AUTHORIZED';
  end if;
  if target.stripe_checkout_livemode is not null and target.stripe_checkout_livemode is distinct from p_livemode then
    raise exception 'STRIPE_MODE_MISMATCH';
  end if;
  if target.status = 'paid' then
    return jsonb_build_object('state', 'paid', 'orderId', target.id, 'livemode', target.stripe_checkout_livemode);
  end if;
  if target.status not in ('preparing', 'ready_for_payment') or target.files_validated_at is null or
     target.body_pdf_page_count is null or target.body_pdf_storage_path is null or target.cover_png_storage_path is null or
     target.body_pdf_sha256 is null or target.cover_png_sha256 is null or
     (target.declared_body_pdf_page_count is not null and target.declared_body_pdf_page_count <> target.body_pdf_page_count) then
    raise exception 'ORDER_ASSETS_NOT_VERIFIED';
  end if;

  quoted_amount := case
    when target.body_pdf_page_count between 24 and 100 then 1980
    when target.body_pdf_page_count between 101 and 150 then 2280
    when target.body_pdf_page_count between 151 and 200 then 2580
    when target.body_pdf_page_count between 201 and 250 then 2880
    when target.body_pdf_page_count between 251 and 300 then 3180
    else null
  end;
  if quoted_amount is null then raise exception 'ORDER_PAGE_COUNT_UNSUPPORTED'; end if;
  if target.amount_minor is not null and target.amount_minor <> quoted_amount then raise exception 'ORDER_PRICE_MISMATCH'; end if;
  if target.currency is not null and target.currency <> 'JPY' then raise exception 'ORDER_PRICE_MISMATCH'; end if;
  if target.shipping_minor is not null and target.shipping_minor <> 0 then raise exception 'ORDER_PRICE_MISMATCH'; end if;

  if target.status = 'preparing' then
    update public.amuhon_orders set status = 'ready_for_payment', amount_minor = quoted_amount,
      shipping_minor = 0, currency = 'JPY'
    where id = p_order_id;
    select * into target from public.amuhon_orders where id = p_order_id for update;
  end if;
  if target.amount_minor is distinct from quoted_amount or target.currency is distinct from 'JPY' or target.shipping_minor is distinct from 0 then
    raise exception 'ORDER_PRICE_MISMATCH';
  end if;

  if target.stripe_checkout_attempt_id is null then
    attempt_started := now();
    update public.amuhon_orders set stripe_checkout_attempt_id = p_checkout_attempt_id,
      stripe_checkout_started_at = attempt_started, stripe_checkout_livemode = p_livemode
    where id = p_order_id;
    return jsonb_build_object('state', 'create_session', 'orderId', p_order_id,
      'attemptId', p_checkout_attempt_id, 'pageCount', target.body_pdf_page_count,
      'amountYen', quoted_amount, 'currency', 'JPY', 'attemptStartedAt', attempt_started,
      'livemode', p_livemode);
  end if;

  if target.stripe_checkout_livemode is distinct from p_livemode then raise exception 'STRIPE_MODE_MISMATCH'; end if;
  if target.stripe_checkout_session_id is not null then
    if target.stripe_checkout_expires_at <= now() then raise exception 'CHECKOUT_SESSION_EXPIRED_REVIEW_REQUIRED'; end if;
    if target.stripe_checkout_url is null then raise exception 'CHECKOUT_SESSION_REVIEW_REQUIRED'; end if;
    return jsonb_build_object('state', 'session_available', 'orderId', p_order_id,
      'attemptId', target.stripe_checkout_attempt_id, 'pageCount', target.body_pdf_page_count,
      'amountYen', quoted_amount, 'currency', 'JPY', 'sessionId', target.stripe_checkout_session_id,
      'checkoutUrl', target.stripe_checkout_url, 'livemode', target.stripe_checkout_livemode);
  end if;
  if target.stripe_checkout_started_at <= now() - interval '30 minutes' then
    raise exception 'CHECKOUT_SESSION_UNCERTAIN_REVIEW_REQUIRED';
  end if;
  return jsonb_build_object('state', 'create_session', 'orderId', p_order_id,
    'attemptId', target.stripe_checkout_attempt_id, 'pageCount', target.body_pdf_page_count,
    'amountYen', quoted_amount, 'currency', 'JPY', 'attemptStartedAt', target.stripe_checkout_started_at,
    'livemode', target.stripe_checkout_livemode);
end;
$$;
revoke all on function public.begin_amuhon_order_checkout_v2(uuid, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.begin_amuhon_order_checkout_v2(uuid, text, uuid, boolean) to service_role;
revoke all on function public.begin_amuhon_order_checkout(uuid, text, uuid) from public, anon, authenticated, service_role;

create or replace function public.record_amuhon_order_checkout_session_v2(
  p_order_id uuid,
  p_upload_token_hash text,
  p_checkout_attempt_id uuid,
  p_session_id text,
  p_session_url text,
  p_expires_at_epoch bigint,
  p_livemode boolean
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  session_expiry timestamptz;
  expected_amount bigint;
begin
  if p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' or p_livemode is null or
     p_session_id is null or
     (p_livemode = false and p_session_id !~ '^cs_test_[A-Za-z0-9]+$') or
     (p_livemode = true and p_session_id !~ '^cs_live_[A-Za-z0-9]+$') or
     p_session_url is null or p_session_url !~ ('^https://checkout\.stripe\.com/c/pay/' || p_session_id || '($|[?#])') or
     p_expires_at_epoch is null then
    raise exception 'INVALID_CHECKOUT_SESSION';
  end if;
  session_expiry := to_timestamp(p_expires_at_epoch);
  if session_expiry <= now() or session_expiry > now() + interval '65 minutes' then raise exception 'INVALID_CHECKOUT_EXPIRY'; end if;
  select * into target from public.amuhon_orders where id = p_order_id for update;
  if not found or target.upload_token_hash is distinct from p_upload_token_hash then raise exception 'ORDER_NOT_AUTHORIZED'; end if;
  if target.stripe_checkout_livemode is distinct from p_livemode then raise exception 'STRIPE_MODE_MISMATCH'; end if;
  if target.body_pdf_page_count is null or target.files_validated_at is null or target.stripe_checkout_attempt_id is distinct from p_checkout_attempt_id or
     target.amount_minor is null or target.currency is distinct from 'JPY' or target.shipping_minor is distinct from 0 then
    raise exception 'ORDER_NOT_READY_FOR_PAYMENT';
  end if;
  expected_amount := case
    when target.body_pdf_page_count between 24 and 100 then 1980
    when target.body_pdf_page_count between 101 and 150 then 2280
    when target.body_pdf_page_count between 151 and 200 then 2580
    when target.body_pdf_page_count between 201 and 250 then 2880
    when target.body_pdf_page_count between 251 and 300 then 3180
    else null
  end;
  if expected_amount is null or target.amount_minor is distinct from expected_amount then raise exception 'ORDER_PRICE_MISMATCH'; end if;
  if session_expiry < target.stripe_checkout_started_at - interval '1 minute' or
     session_expiry > target.stripe_checkout_started_at + interval '65 minutes' then raise exception 'INVALID_CHECKOUT_EXPIRY'; end if;
  if target.stripe_checkout_attempt_id is distinct from p_checkout_attempt_id or
     (target.stripe_checkout_session_id is not null and target.stripe_checkout_session_id is distinct from p_session_id) then
    raise exception 'CHECKOUT_ATTEMPT_MISMATCH';
  end if;
  if target.stripe_checkout_session_id = p_session_id and
     (target.stripe_checkout_expires_at is distinct from session_expiry or
      (target.stripe_checkout_url is not null and target.stripe_checkout_url is distinct from p_session_url)) then
    raise exception 'CHECKOUT_SESSION_RESPONSE_MISMATCH';
  end if;
  if target.status not in ('ready_for_payment', 'paid') then raise exception 'ORDER_NOT_READY_FOR_PAYMENT'; end if;
  if target.status = 'paid' and target.stripe_checkout_session_id is distinct from p_session_id then raise exception 'CHECKOUT_SESSION_MISMATCH'; end if;
  update public.amuhon_orders set stripe_checkout_session_id = p_session_id,
    stripe_checkout_url = coalesce(stripe_checkout_url, p_session_url), stripe_checkout_expires_at = session_expiry
  where id = p_order_id;
  return jsonb_build_object('state', case when target.status = 'paid' then 'paid' else 'recorded' end,
    'sessionId', p_session_id, 'checkoutUrl', p_session_url, 'expiresAt', session_expiry,
    'livemode', p_livemode);
end;
$$;
revoke all on function public.record_amuhon_order_checkout_session_v2(uuid, text, uuid, text, text, bigint, boolean) from public, anon, authenticated;
grant execute on function public.record_amuhon_order_checkout_session_v2(uuid, text, uuid, text, text, bigint, boolean) to service_role;
revoke all on function public.record_amuhon_order_checkout_session(uuid, text, uuid, text, text, bigint) from public, anon, authenticated, service_role;

create or replace function public.apply_amuhon_stripe_checkout_paid_v2(
  p_event_id text,
  p_event_type text,
  p_order_id uuid,
  p_checkout_attempt_id uuid,
  p_session_id text,
  p_session_expires_at_epoch bigint,
  p_amount_total bigint,
  p_currency text,
  p_payment_intent_id text,
  p_livemode boolean
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  event_row public.amuhon_stripe_webhook_events%rowtype;
  session_expiry timestamptz;
  expected_amount bigint;
begin
  if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$' or
     p_event_type is distinct from 'checkout.session.completed' or p_livemode is null or
     p_session_id is null or
     (p_livemode = false and p_session_id !~ '^cs_test_[A-Za-z0-9]+$') or
     (p_livemode = true and p_session_id !~ '^cs_live_[A-Za-z0-9]+$') or
     p_session_expires_at_epoch is null or p_amount_total is null or p_amount_total < 1 or
     p_currency is distinct from 'jpy' or p_payment_intent_id is null or p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$' then
    raise exception 'INVALID_STRIPE_PAYMENT_EVENT';
  end if;
  select * into target from public.amuhon_orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if target.stripe_checkout_livemode is distinct from p_livemode then raise exception 'STRIPE_MODE_MISMATCH'; end if;
  select * into event_row from public.amuhon_stripe_webhook_events where event_id = p_event_id;
  if found then
    if event_row.event_type <> 'checkout.session.completed' or event_row.order_id <> p_order_id or
       event_row.checkout_session_id <> p_session_id or event_row.livemode is distinct from p_livemode then
      raise exception 'STRIPE_EVENT_ID_CONFLICT';
    end if;
    return jsonb_build_object('state', 'duplicate', 'orderId', p_order_id, 'livemode', p_livemode);
  end if;

  expected_amount := case
    when target.body_pdf_page_count between 24 and 100 then 1980
    when target.body_pdf_page_count between 101 and 150 then 2280
    when target.body_pdf_page_count between 151 and 200 then 2580
    when target.body_pdf_page_count between 201 and 250 then 2880
    when target.body_pdf_page_count between 251 and 300 then 3180
    else null
  end;
  session_expiry := to_timestamp(p_session_expires_at_epoch);
  if target.stripe_checkout_attempt_id is distinct from p_checkout_attempt_id or
     expected_amount is null or target.amount_minor is distinct from expected_amount or p_amount_total is distinct from expected_amount or
     target.currency is distinct from 'JPY' or target.shipping_minor is distinct from 0 or
     target.files_validated_at is null or target.body_pdf_storage_path is null or target.cover_png_storage_path is null or
     target.body_pdf_sha256 is null or target.cover_png_sha256 is null or
     (target.declared_body_pdf_page_count is not null and target.declared_body_pdf_page_count <> target.body_pdf_page_count) then
    raise exception 'STRIPE_PAYMENT_MISMATCH';
  end if;
  if target.stripe_checkout_expires_at is not null and target.stripe_checkout_expires_at is distinct from session_expiry then
    raise exception 'STRIPE_SESSION_EXPIRY_MISMATCH';
  end if;
  if target.status = 'paid' then
    if target.stripe_checkout_session_id is distinct from p_session_id or target.stripe_payment_id is distinct from p_payment_intent_id then
      raise exception 'STRIPE_PAYMENT_CONFLICT';
    end if;
  elsif target.status = 'ready_for_payment' then
    if target.stripe_checkout_session_id is not null and target.stripe_checkout_session_id is distinct from p_session_id then
      raise exception 'STRIPE_SESSION_MISMATCH';
    end if;
    if session_expiry < target.stripe_checkout_started_at - interval '1 minute' or
       session_expiry > target.stripe_checkout_started_at + interval '65 minutes' then
      raise exception 'STRIPE_SESSION_EXPIRY_MISMATCH';
    end if;
    update public.amuhon_orders set status = 'paid', stripe_checkout_session_id = p_session_id,
      stripe_checkout_expires_at = session_expiry, stripe_payment_id = p_payment_intent_id
    where id = p_order_id;
  else
    raise exception 'ORDER_NOT_READY_FOR_PAYMENT';
  end if;

  insert into public.amuhon_stripe_webhook_events (event_id, event_type, order_id, checkout_session_id, livemode)
  values (p_event_id, p_event_type, p_order_id, p_session_id, p_livemode);
  return jsonb_build_object('state', case when target.status = 'paid' then 'duplicate' else 'paid' end,
    'orderId', p_order_id, 'livemode', p_livemode);
end;
$$;
revoke all on function public.apply_amuhon_stripe_checkout_paid_v2(text, text, uuid, uuid, text, bigint, bigint, text, text, boolean) from public, anon, authenticated;
grant execute on function public.apply_amuhon_stripe_checkout_paid_v2(text, text, uuid, uuid, text, bigint, bigint, text, text, boolean) to service_role;
revoke all on function public.apply_amuhon_stripe_checkout_paid(text, text, uuid, uuid, text, bigint, bigint, text, text) from public, anon, authenticated, service_role;

comment on column public.amuhon_orders.stripe_checkout_livemode is
  'Immutable mode binding for a checkout attempt. Existing rows produced by the test-only checkout RPCs are backfilled to false.';
comment on column public.amuhon_stripe_webhook_events.livemode is
  'Stripe event mode, checked against the immutable checkout mode on its order.';
