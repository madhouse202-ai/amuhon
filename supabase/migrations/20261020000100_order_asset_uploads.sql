-- Add capability-protected server-side body PDF and cover PNG uploads.
-- Apply after 20261017000100_order_drafts.sql.

alter table public.amuhon_orders
  add column if not exists upload_token_hash text,
  add column if not exists upload_lease_id uuid,
  add column if not exists upload_lease_expires_at timestamptz,
  add column if not exists upload_attempt_count integer not null default 0,
  add column if not exists body_pdf_sha256 text,
  add column if not exists cover_png_sha256 text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.amuhon_orders'::regclass and conname = 'amuhon_orders_upload_token_hash_format') then
    alter table public.amuhon_orders add constraint amuhon_orders_upload_token_hash_format
      check (upload_token_hash is null or upload_token_hash ~ '^[a-f0-9]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.amuhon_orders'::regclass and conname = 'amuhon_orders_upload_lease_pair') then
    alter table public.amuhon_orders add constraint amuhon_orders_upload_lease_pair
      check ((upload_lease_id is null) = (upload_lease_expires_at is null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.amuhon_orders'::regclass and conname = 'amuhon_orders_upload_attempt_count_nonnegative') then
    alter table public.amuhon_orders add constraint amuhon_orders_upload_attempt_count_nonnegative
      check (upload_attempt_count >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.amuhon_orders'::regclass and conname = 'amuhon_orders_asset_sha256_format') then
    alter table public.amuhon_orders add constraint amuhon_orders_asset_sha256_format
      check (
        (body_pdf_sha256 is null or body_pdf_sha256 ~ '^[a-f0-9]{64}$') and
        (cover_png_sha256 is null or cover_png_sha256 ~ '^[a-f0-9]{64}$')
      );
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.amuhon_orders'::regclass and conname = 'amuhon_orders_verified_assets_complete') then
    alter table public.amuhon_orders add constraint amuhon_orders_verified_assets_complete
      check (files_validated_at is null or (
        body_pdf_page_count is not null and body_pdf_storage_path is not null and
        cover_png_storage_path is not null and body_pdf_sha256 is not null and
        cover_png_sha256 is not null
      ));
  end if;
end;
$$;

create table if not exists public.amuhon_order_asset_rate_limits (
  key_hash text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);
alter table public.amuhon_order_asset_rate_limits enable row level security;
revoke all on public.amuhon_order_asset_rate_limits from public, anon, authenticated, service_role;

create or replace function public.create_amuhon_order_draft_with_upload_token(
  p_order_id uuid,
  p_idempotency_key uuid,
  p_customer jsonb,
  p_book_snapshot jsonb,
  p_declared_body_pdf_page_count integer,
  p_rate_limit_key_hash text,
  p_upload_token_hash text,
  p_draft_retention_days integer default 30
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  existing_order public.amuhon_orders%rowtype;
  bucket_count integer;
  inserted_order public.amuhon_orders%rowtype;
begin
  if p_draft_retention_days < 1 or p_draft_retention_days > 365 then
    raise exception 'INVALID_RETENTION_CONFIG';
  end if;
  if p_rate_limit_key_hash is null or length(p_rate_limit_key_hash) < 32 then
    raise exception 'INVALID_RATE_LIMIT_KEY';
  end if;
  if p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'INVALID_UPLOAD_TOKEN_HASH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into existing_order from public.amuhon_orders
    where idempotency_key = p_idempotency_key for update;
  if found then
    if existing_order.customer is distinct from p_customer or
       existing_order.book_snapshot is distinct from p_book_snapshot or
       existing_order.declared_body_pdf_page_count is distinct from p_declared_body_pdf_page_count then
      raise exception 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
    end if;
    if existing_order.files_validated_at is null and existing_order.status in ('draft', 'preparing', 'failed') then
      if existing_order.upload_lease_expires_at > now() then
        raise exception 'ORDER_FILE_UPLOAD_IN_PROGRESS';
      end if;
      update public.amuhon_orders set
        upload_token_hash = p_upload_token_hash,
        upload_lease_id = null,
        upload_lease_expires_at = null
      where id = existing_order.id;
      return jsonb_build_object(
        'id', existing_order.id,
        'status', existing_order.status,
        'createdAt', existing_order.created_at,
        'created', false,
        'uploadTokenAccepted', true
      );
    end if;
    return jsonb_build_object(
      'id', existing_order.id,
      'status', existing_order.status,
      'createdAt', existing_order.created_at,
      'created', false,
      'uploadTokenAccepted', false
    );
  end if;

  delete from public.amuhon_order_rate_limits
    where updated_at < now() - interval '24 hours';
  insert into public.amuhon_order_rate_limits as limits (key_hash, window_started_at, request_count)
  values (p_rate_limit_key_hash, now(), 1)
  on conflict (key_hash) do update set
    request_count = case
      when limits.window_started_at <= now() - interval '15 minutes' then 1
      else limits.request_count + 1
    end,
    window_started_at = case
      when limits.window_started_at <= now() - interval '15 minutes' then now()
      else limits.window_started_at
    end,
    updated_at = now()
  returning request_count into bucket_count;
  if bucket_count > 5 then
    raise exception using errcode = 'P0001', message = 'ORDER_RATE_LIMITED';
  end if;

  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, draft_expires_at, upload_token_hash
  ) values (
    p_order_id, p_idempotency_key, 'draft', p_customer, p_book_snapshot,
    p_declared_body_pdf_page_count,
    now() + make_interval(days => p_draft_retention_days), p_upload_token_hash
  ) returning * into inserted_order;

  return jsonb_build_object(
    'id', inserted_order.id,
    'status', inserted_order.status,
    'createdAt', inserted_order.created_at,
    'created', true,
    'uploadTokenAccepted', true
  );
end;
$$;
revoke all on function public.create_amuhon_order_draft_with_upload_token(uuid, uuid, jsonb, jsonb, integer, text, text, integer) from public, anon, authenticated;
grant execute on function public.create_amuhon_order_draft_with_upload_token(uuid, uuid, jsonb, jsonb, integer, text, text, integer) to service_role;

create or replace function public.begin_amuhon_order_asset_upload(
  p_order_id uuid,
  p_upload_token_hash text,
  p_rate_limit_key_hash text,
  p_lease_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  bucket_count integer;
begin
  if p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' or
     p_rate_limit_key_hash is null or length(p_rate_limit_key_hash) < 32 then
    raise exception 'UPLOAD_NOT_AUTHORIZED';
  end if;
  select * into target from public.amuhon_orders where id = p_order_id for update;
  if not found or target.upload_token_hash is distinct from p_upload_token_hash then
    raise exception 'UPLOAD_NOT_AUTHORIZED';
  end if;
  if target.files_validated_at is not null then
    return jsonb_build_object(
      'state', 'complete',
      'pageCount', target.body_pdf_page_count,
      'bodyPdfSha256', target.body_pdf_sha256,
      'coverPngSha256', target.cover_png_sha256
    );
  end if;
  if target.status not in ('draft', 'preparing', 'failed') then
    raise exception 'ORDER_NOT_UPLOADABLE';
  end if;
  if target.upload_lease_expires_at > now() and target.upload_lease_id <> p_lease_id then
    return jsonb_build_object('state', 'busy');
  end if;

  delete from public.amuhon_order_asset_rate_limits
    where updated_at < now() - interval '24 hours';
  insert into public.amuhon_order_asset_rate_limits as limits (key_hash, window_started_at, request_count)
  values (p_rate_limit_key_hash, now(), 1)
  on conflict (key_hash) do update set
    request_count = case
      when limits.window_started_at <= now() - interval '15 minutes' then 1
      else limits.request_count + 1
    end,
    window_started_at = case
      when limits.window_started_at <= now() - interval '15 minutes' then now()
      else limits.window_started_at
    end,
    updated_at = now()
  returning request_count into bucket_count;
  if bucket_count > 5 then
    raise exception using errcode = 'P0001', message = 'ORDER_FILE_RATE_LIMITED';
  end if;

  update public.amuhon_orders set
    status = 'preparing',
    upload_lease_id = p_lease_id,
    upload_lease_expires_at = now() + interval '5 minutes',
    upload_attempt_count = upload_attempt_count + 1
  where id = p_order_id;
  return jsonb_build_object(
    'state', 'claimed', 'leaseId', p_lease_id,
    'declaredPageCount', target.declared_body_pdf_page_count
  );
end;
$$;
revoke all on function public.begin_amuhon_order_asset_upload(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.begin_amuhon_order_asset_upload(uuid, text, text, uuid) to service_role;

create or replace function public.finish_amuhon_order_asset_upload(
  p_order_id uuid,
  p_upload_token_hash text,
  p_lease_id uuid,
  p_body_pdf_page_count integer,
  p_body_pdf_sha256 text,
  p_cover_png_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
begin
  select * into target from public.amuhon_orders where id = p_order_id for update;
  if not found or target.upload_token_hash is distinct from p_upload_token_hash then
    raise exception 'UPLOAD_NOT_AUTHORIZED';
  end if;
  if target.files_validated_at is not null then
    if target.body_pdf_page_count = p_body_pdf_page_count and
       target.body_pdf_sha256 = p_body_pdf_sha256 and target.cover_png_sha256 = p_cover_png_sha256 then
      return jsonb_build_object('state', 'complete', 'pageCount', target.body_pdf_page_count);
    end if;
    raise exception 'ORDER_FILES_ALREADY_FINALIZED';
  end if;
  if target.status <> 'preparing' or target.upload_lease_id is distinct from p_lease_id or
     target.upload_lease_expires_at <= now() then
    raise exception 'UPLOAD_LEASE_EXPIRED';
  end if;
  if p_body_pdf_page_count < 24 or p_body_pdf_page_count > 496 or p_body_pdf_page_count % 8 <> 0 or
     p_body_pdf_sha256 !~ '^[a-f0-9]{64}$' or p_cover_png_sha256 !~ '^[a-f0-9]{64}$' or
     (target.declared_body_pdf_page_count is not null and
       p_body_pdf_page_count is distinct from target.declared_body_pdf_page_count) then
    raise exception 'VERIFIED_ASSET_METADATA_INVALID';
  end if;

  update public.amuhon_orders set
    body_pdf_page_count = p_body_pdf_page_count,
    body_pdf_storage_path = p_order_id::text || '/body.pdf',
    cover_png_storage_path = p_order_id::text || '/cover.png',
    body_pdf_sha256 = p_body_pdf_sha256,
    cover_png_sha256 = p_cover_png_sha256,
    files_validated_at = now(),
    upload_lease_id = null,
    upload_lease_expires_at = null
  where id = p_order_id;
  return jsonb_build_object('state', 'complete', 'pageCount', p_body_pdf_page_count);
end;
$$;
revoke all on function public.finish_amuhon_order_asset_upload(uuid, text, uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.finish_amuhon_order_asset_upload(uuid, text, uuid, integer, text, text) to service_role;

create or replace function public.abort_amuhon_order_asset_upload(
  p_order_id uuid,
  p_upload_token_hash text,
  p_lease_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update public.amuhon_orders set
    upload_lease_id = null,
    upload_lease_expires_at = null
  where id = p_order_id and upload_token_hash = p_upload_token_hash and
    upload_lease_id = p_lease_id and files_validated_at is null;
  return found;
end;
$$;
revoke all on function public.abort_amuhon_order_asset_upload(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.abort_amuhon_order_asset_upload(uuid, text, uuid) to service_role;

create or replace function public.claim_stale_amuhon_order_asset_cleanup(
  p_cleanup_lease_id uuid,
  p_limit integer default 50
) returns setof uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_limit < 1 or p_limit > 100 then raise exception 'INVALID_CLEANUP_LIMIT'; end if;
  return query
    with stale as (
      select id from public.amuhon_orders
      where status = 'preparing' and files_validated_at is null and
        (upload_lease_id is null or upload_lease_expires_at <= now())
      order by updated_at
      limit p_limit
      for update skip locked
    ), claimed as (
      update public.amuhon_orders as orders set
        upload_lease_id = p_cleanup_lease_id,
        upload_lease_expires_at = now() + interval '5 minutes'
      from stale where orders.id = stale.id
      returning orders.id
    )
    select claimed.id from claimed;
end;
$$;
revoke all on function public.claim_stale_amuhon_order_asset_cleanup(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_stale_amuhon_order_asset_cleanup(uuid, integer) to service_role;

create or replace function public.release_stale_amuhon_order_asset_cleanup(
  p_cleanup_lease_id uuid,
  p_order_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  released_count integer;
begin
  update public.amuhon_orders set
    upload_lease_id = null,
    upload_lease_expires_at = null
  where id = any(p_order_ids) and upload_lease_id = p_cleanup_lease_id and files_validated_at is null;
  get diagnostics released_count = row_count;
  return released_count;
end;
$$;
revoke all on function public.release_stale_amuhon_order_asset_cleanup(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.release_stale_amuhon_order_asset_cleanup(uuid, uuid[]) to service_role;

comment on column public.amuhon_orders.upload_token_hash is
  'SHA-256 hash of the high-entropy upload capability; raw token is returned only by the server-side draft API.';
comment on column public.amuhon_orders.body_pdf_sha256 is
  'SHA-256 of the server-validated body PDF uploaded to private Storage.';
comment on column public.amuhon_orders.cover_png_sha256 is
  'SHA-256 of the server-validated A6 spread cover PNG uploaded to private Storage.';
