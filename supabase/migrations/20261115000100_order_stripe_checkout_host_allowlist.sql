-- Use one database-owned trusted-host allowlist for both Checkout URL validation
-- and the application-side redirect check. Additive: no existing migration is rewritten.

create table public.amuhon_stripe_checkout_allowed_hosts (
  hostname text primary key,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint amuhon_stripe_checkout_allowed_hosts_hostname_check check (
    length(hostname) between 1 and 253
    and hostname = lower(hostname)
    and hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    and split_part(hostname, '.', array_length(string_to_array(hostname, '.'), 1)) ~ '^[a-z]'
    and hostname !~ '^[0-9]+([.][0-9]+){3}$'
  )
);

alter table public.amuhon_stripe_checkout_allowed_hosts enable row level security;
revoke all on table public.amuhon_stripe_checkout_allowed_hosts from public, anon, authenticated, service_role;

insert into public.amuhon_stripe_checkout_allowed_hosts (hostname, enabled)
values ('checkout.stripe.com', true);

create or replace function public.get_amuhon_stripe_checkout_allowed_hosts_v1()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'hosts', coalesce(jsonb_agg(hostname order by hostname), '[]'::jsonb)
  )
  from public.amuhon_stripe_checkout_allowed_hosts
  where enabled is true;
$$;
revoke all on function public.get_amuhon_stripe_checkout_allowed_hosts_v1() from public, anon, authenticated;
grant execute on function public.get_amuhon_stripe_checkout_allowed_hosts_v1() to service_role;

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
  session_host text;
begin
  if p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' or p_livemode is null or
     p_session_id is null or
     (p_livemode = false and p_session_id !~ '^cs_test_[A-Za-z0-9]+$') or
     (p_livemode = true and p_session_id !~ '^cs_live_[A-Za-z0-9]+$') or
     p_session_url is null or length(p_session_url) > 4096 or
     p_session_url !~* '^https://[a-z0-9.-]+(:443)?/[^[:space:]]*$' or
     position(chr(92) in p_session_url) > 0 or
     p_expires_at_epoch is null then
    raise exception 'INVALID_CHECKOUT_SESSION';
  end if;
  session_host := lower((regexp_match(p_session_url, '^https://([A-Za-z0-9.-]+)', 'i'))[1]);
  if session_host is null or not exists (
    select 1 from public.amuhon_stripe_checkout_allowed_hosts
    where hostname = session_host and enabled is true
  ) then
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

-- Make the newly added RPC visible to PostgREST after this script commits.
notify pgrst, 'reload schema';
