begin;

-- This narrowly-scoped pair of service-only RPCs lets an order owner recover
-- a verified paid Checkout Session after a missed webhook. The browser never
-- supplies trusted payment state; the server retrieves it from Stripe first.
create or replace function public.get_amuhon_order_payment_reconciliation_v1(
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

  -- Session and attempt identifiers are returned only to the authenticated
  -- same-origin server request; the public status endpoint omits them.
  return jsonb_build_object(
    'orderId', target.id,
    'status', target.status,
    'filesVerified', files_verified,
    'priceConsistent', price_consistent,
    'amountYen', target.amount_minor,
    'currency', target.currency,
    'livemode', target.stripe_checkout_livemode,
    'attemptId', target.stripe_checkout_attempt_id,
    'sessionId', target.stripe_checkout_session_id,
    'sessionExpiresAtEpoch', case when target.stripe_checkout_expires_at is null then null
      else extract(epoch from target.stripe_checkout_expires_at)::bigint end
  );
end;
$$;
revoke all on function public.get_amuhon_order_payment_reconciliation_v1(uuid, text) from public, anon, authenticated;
grant execute on function public.get_amuhon_order_payment_reconciliation_v1(uuid, text) to service_role;

create or replace function public.reconcile_amuhon_stripe_checkout_paid_v1(
  p_order_id uuid,
  p_upload_token_hash text,
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
  expected_amount bigint;
  session_expiry timestamptz;
begin
  if p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' or
     p_checkout_attempt_id is null or p_livemode is null or
     p_session_id is null or
     (p_livemode = false and p_session_id !~ '^cs_test_[A-Za-z0-9]+$') or
     (p_livemode = true and p_session_id !~ '^cs_live_[A-Za-z0-9]+$') or
     p_session_expires_at_epoch is null or p_amount_total is null or p_amount_total < 1 or
     p_currency is distinct from 'jpy' or p_payment_intent_id is null or
     p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$' then
    raise exception 'INVALID_STRIPE_PAYMENT_RECONCILIATION';
  end if;

  select * into target from public.amuhon_orders where id = p_order_id for update;
  if not found or target.upload_token_hash is distinct from p_upload_token_hash then
    raise exception 'ORDER_NOT_AUTHORIZED';
  end if;
  if target.stripe_checkout_livemode is distinct from p_livemode then
    raise exception 'STRIPE_MODE_MISMATCH';
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
     target.stripe_checkout_session_id is distinct from p_session_id or
     target.stripe_checkout_expires_at is distinct from session_expiry or
     target.stripe_checkout_started_at is null or
     session_expiry < target.stripe_checkout_started_at - interval '1 minute' or
     session_expiry > target.stripe_checkout_started_at + interval '65 minutes' or
     expected_amount is null or target.amount_minor is distinct from expected_amount or
     p_amount_total is distinct from expected_amount or target.currency is distinct from 'JPY' or
     target.shipping_minor is distinct from 0 or target.files_validated_at is null or
     target.body_pdf_storage_path is null or target.cover_png_storage_path is null or
     target.body_pdf_sha256 is null or target.body_pdf_sha256 !~ '^[a-f0-9]{64}$' or
     target.cover_png_sha256 is null or target.cover_png_sha256 !~ '^[a-f0-9]{64}$' or
     (target.declared_body_pdf_page_count is not null and
       target.declared_body_pdf_page_count <> target.body_pdf_page_count) then
    raise exception 'STRIPE_PAYMENT_MISMATCH';
  end if;

  if target.status = 'paid' then
    if target.stripe_payment_id is distinct from p_payment_intent_id then
      raise exception 'STRIPE_PAYMENT_CONFLICT';
    end if;
    return jsonb_build_object('state', 'already_paid', 'orderId', target.id, 'livemode', p_livemode);
  end if;
  if target.status is distinct from 'ready_for_payment' then
    raise exception 'ORDER_NOT_READY_FOR_PAYMENT';
  end if;

  -- Updating status fires the existing paid-transition PDF queue trigger.
  -- A row lock and paid-state check make retries and webhook races idempotent.
  update public.amuhon_orders
  set status = 'paid', stripe_payment_id = p_payment_intent_id
  where id = p_order_id;

  return jsonb_build_object('state', 'paid', 'orderId', target.id, 'livemode', p_livemode);
end;
$$;
revoke all on function public.reconcile_amuhon_stripe_checkout_paid_v1(uuid, text, uuid, text, bigint, bigint, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.reconcile_amuhon_stripe_checkout_paid_v1(uuid, text, uuid, text, bigint, bigint, text, text, boolean)
  to service_role;

notify pgrst, 'reload schema';
commit;
