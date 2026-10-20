-- Experimental, temporary direct uploads. Existing finalized order assets and
-- the legacy amuhon-order-files bucket are deliberately left unchanged.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'amuhon-order-temp-files', 'amuhon-order-temp-files', false, 40000000,
  array['application/pdf', 'image/png']
)
on conflict (id) do nothing;

-- Never rewrite an existing bucket's settings implicitly. If an operator or
-- earlier deployment created this ID with incompatible settings, fail closed
-- and require an explicit review instead of mutating its configuration.
do $$
begin
  if not exists (
    select 1 from storage.buckets
    where id = 'amuhon-order-temp-files'
      and name = 'amuhon-order-temp-files'
      and public is false
      and file_size_limit = 40000000
      and allowed_mime_types = array['application/pdf', 'image/png']::text[]
  ) then
    raise exception 'amuhon-order-temp-files bucket is missing or has incompatible settings';
  end if;
end;
$$;

drop policy if exists amuhon_order_temp_files_deny_public_access on storage.objects;
create policy amuhon_order_temp_files_deny_public_access
  on storage.objects as restrictive
  for all to public
  using (bucket_id <> 'amuhon-order-temp-files')
  with check (bucket_id <> 'amuhon-order-temp-files');

create table if not exists public.amuhon_order_temp_upload_attempts (
  id uuid primary key,
  order_id uuid not null,
  lease_id uuid not null,
  body_object_key text not null unique,
  cover_object_key text not null unique,
  state text not null default 'issued'
    check (state in ('issued', 'cleaning', 'cleaned', 'cleanup_failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  cleanup_lease_id uuid,
  cleanup_claimed_at timestamptz,
  cleaned_at timestamptz,
  check (
    (state = 'cleaning' and cleanup_lease_id is not null and cleanup_claimed_at is not null) or
    (state <> 'cleaning' and cleanup_lease_id is null and cleanup_claimed_at is null)
  ),
  check ((state = 'cleaned') = (cleaned_at is not null))
);
create index if not exists amuhon_order_temp_upload_attempts_expiry_idx
  on public.amuhon_order_temp_upload_attempts (expires_at)
  where state in ('issued', 'cleanup_failed');
alter table public.amuhon_order_temp_upload_attempts enable row level security;
revoke all on public.amuhon_order_temp_upload_attempts from public, anon, authenticated, service_role;

create or replace function public.register_amuhon_order_temp_upload_attempt(
  p_order_id uuid,
  p_upload_token_hash text,
  p_lease_id uuid,
  p_attempt_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  existing_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  body_key text := p_order_id::text || '/' || p_attempt_id::text || '/body.pdf';
  cover_key text := p_order_id::text || '/' || p_attempt_id::text || '/cover.png';
  expires timestamptz;
begin
  if p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'UPLOAD_NOT_AUTHORIZED';
  end if;
  select * into target from public.amuhon_orders where id = p_order_id for update;
  if not found or target.upload_token_hash is distinct from p_upload_token_hash then
    raise exception 'UPLOAD_NOT_AUTHORIZED';
  end if;
  if target.files_validated_at is not null or target.status not in ('draft', 'preparing', 'failed') then
    raise exception 'ORDER_NOT_UPLOADABLE';
  end if;
  if target.upload_lease_id is distinct from p_lease_id or target.upload_lease_expires_at <= clock_timestamp() then
    raise exception 'UPLOAD_LEASE_EXPIRED';
  end if;

  -- Lock order: order row first, then attempt row. Cleanup only locks attempts;
  -- both paths serialize on the attempt row before deciding whether to refresh
  -- its expiry or mark it cleaning.
  select attempts.* into existing_attempt
  from public.amuhon_order_temp_upload_attempts as attempts
  where attempts.id = p_attempt_id
  for update;
  if found then
    if existing_attempt.order_id is distinct from p_order_id or existing_attempt.lease_id is distinct from p_lease_id or
       existing_attempt.body_object_key is distinct from body_key or existing_attempt.cover_object_key is distinct from cover_key or
       existing_attempt.state <> 'issued' or existing_attempt.expires_at <= clock_timestamp() then
      raise exception 'UPLOAD_ATTEMPT_NOT_REUSABLE';
    end if;
    expires := clock_timestamp() + interval '26 hours';
    update public.amuhon_order_temp_upload_attempts set
      expires_at = expires
    where id = p_attempt_id;
    update public.amuhon_orders set upload_lease_expires_at = clock_timestamp() + interval '27 hours'
    where id = p_order_id and upload_lease_id = p_lease_id;
    return jsonb_build_object(
      'attemptId', p_attempt_id,
      'bodyObjectKey', body_key,
      'coverObjectKey', cover_key,
      'expiresAt', expires
    );
  end if;

  expires := clock_timestamp() + interval '26 hours';
  insert into public.amuhon_order_temp_upload_attempts (
    id, order_id, lease_id, body_object_key, cover_object_key, expires_at
  ) values (p_attempt_id, p_order_id, p_lease_id, body_key, cover_key, expires);

  -- TUS upload URLs may remain resumable for up to 24 hours. Keep the existing
  -- order lease alive beyond that period so the legacy cleaner cannot race it.
  update public.amuhon_orders set upload_lease_expires_at = clock_timestamp() + interval '27 hours'
  where id = p_order_id and upload_lease_id = p_lease_id;

  return jsonb_build_object(
    'attemptId', p_attempt_id,
    'bodyObjectKey', body_key,
    'coverObjectKey', cover_key,
    'expiresAt', expires
  );
end;
$$;
revoke all on function public.register_amuhon_order_temp_upload_attempt(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.register_amuhon_order_temp_upload_attempt(uuid, text, uuid, uuid) to service_role;

create or replace function public.get_amuhon_order_temp_upload_attempt(
  p_order_id uuid,
  p_upload_token_hash text,
  p_attempt_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  attempt public.amuhon_order_temp_upload_attempts%rowtype;
begin
  select * into target from public.amuhon_orders where id = p_order_id;
  if not found or target.upload_token_hash is distinct from p_upload_token_hash then
    raise exception 'UPLOAD_NOT_AUTHORIZED';
  end if;
  select * into attempt from public.amuhon_order_temp_upload_attempts
  where id = p_attempt_id and order_id = p_order_id;
  if not found then return null; end if;
  if target.files_validated_at is not null or target.status not in ('draft', 'preparing', 'failed') then
    raise exception 'ORDER_NOT_UPLOADABLE';
  end if;
  -- Return the authenticated historical attempt even after expiry/cleanup. The
  -- caller re-enters the current order lease and register rejects non-issued,
  -- expired, or stale-lease attempts; the API then creates a fresh UUID key.
  -- Do not require the old lease to still be current here: an authorized safe
  -- idempotent retry may have cleared/rotated it. No signature is issued by
  -- this lookup, and the register RPC validates the lease before key reuse.
  return jsonb_build_object(
    'attemptId', attempt.id,
    'leaseId', attempt.lease_id,
    'bodyObjectKey', attempt.body_object_key,
    'coverObjectKey', attempt.cover_object_key,
    'expiresAt', attempt.expires_at
  );
end;
$$;
revoke all on function public.get_amuhon_order_temp_upload_attempt(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.get_amuhon_order_temp_upload_attempt(uuid, text, uuid) to service_role;

create or replace function public.claim_expired_amuhon_order_temp_upload_attempts(
  p_cleanup_lease_id uuid,
  p_limit integer default 50
) returns table (attempt_id uuid, order_id uuid, body_object_key text, cover_object_key text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_limit < 1 or p_limit > 100 then raise exception 'INVALID_CLEANUP_LIMIT'; end if;
  return query
    with picked as (
      select attempts.id
      from public.amuhon_order_temp_upload_attempts as attempts
      where attempts.expires_at <= clock_timestamp() and (
        attempts.state in ('issued', 'cleanup_failed') or
        (attempts.state = 'cleaning' and attempts.cleanup_claimed_at <= clock_timestamp() - interval '10 minutes')
      )
      order by attempts.expires_at
      limit p_limit
      for update skip locked
    )
    update public.amuhon_order_temp_upload_attempts as attempts
    set state = 'cleaning', cleanup_lease_id = p_cleanup_lease_id, cleanup_claimed_at = clock_timestamp()
    from picked
    where attempts.id = picked.id
    returning attempts.id, attempts.order_id, attempts.body_object_key, attempts.cover_object_key;
end;
$$;
revoke all on function public.claim_expired_amuhon_order_temp_upload_attempts(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_expired_amuhon_order_temp_upload_attempts(uuid, integer) to service_role;

create or replace function public.finish_amuhon_order_temp_upload_cleanup(
  p_cleanup_lease_id uuid,
  p_attempt_id uuid,
  p_deleted boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update public.amuhon_order_temp_upload_attempts
  set state = case when p_deleted then 'cleaned' else 'cleanup_failed' end,
      cleanup_lease_id = null,
      cleanup_claimed_at = null,
      cleaned_at = case when p_deleted then now() else null end
  where id = p_attempt_id and state = 'cleaning' and cleanup_lease_id = p_cleanup_lease_id;
  return found;
end;
$$;
revoke all on function public.finish_amuhon_order_temp_upload_cleanup(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.finish_amuhon_order_temp_upload_cleanup(uuid, uuid, boolean) to service_role;

comment on table public.amuhon_order_temp_upload_attempts is
  'Server-issued unique temporary Storage keys for experimental direct upload; contains no raw order upload capability.';
