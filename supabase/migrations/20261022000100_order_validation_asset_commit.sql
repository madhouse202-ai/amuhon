-- Atomically publish verified asset metadata and validation-job success.
-- This is additive: it does not rewrite existing order or Storage data.

alter table public.amuhon_orders
  add column if not exists body_pdf_size_bytes integer,
  add column if not exists cover_png_size_bytes integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.amuhon_orders'::regclass
      and conname = 'amuhon_orders_verified_asset_size_pair'
  ) then
    alter table public.amuhon_orders
      add constraint amuhon_orders_verified_asset_size_pair check (
        (body_pdf_size_bytes is null and cover_png_size_bytes is null) or
        (body_pdf_size_bytes is not null and cover_png_size_bytes is not null and
         body_pdf_size_bytes between 1 and 40000000 and
         cover_png_size_bytes between 1 and 40000000)
      );
  end if;
end;
$$;

comment on column public.amuhon_orders.body_pdf_size_bytes is
  'Verified byte length for files committed by the validation worker; NULL is retained for legacy orders.';
comment on column public.amuhon_orders.cover_png_size_bytes is
  'Verified byte length for files committed by the validation worker; NULL is retained for legacy orders.';

create or replace function public.commit_amuhon_order_validation_assets(
  p_order_id uuid,
  p_attempt_id uuid,
  p_lease_id uuid,
  p_body_pdf_page_count integer,
  p_body_pdf_storage_path text,
  p_cover_png_storage_path text,
  p_body_pdf_sha256 text,
  p_cover_png_sha256 text,
  p_body_pdf_size_bytes integer,
  p_cover_png_size_bytes integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_order public.amuhon_orders%rowtype;
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  target_job public.amuhon_order_validation_jobs%rowtype;
  commit_time timestamptz;
  updated_count integer;
begin
  if p_order_id is null or p_attempt_id is null or p_lease_id is null then
    raise exception 'VALIDATION_COMMIT_INPUT_INVALID';
  end if;
  if p_body_pdf_page_count is null or p_body_pdf_page_count < 24 or
     p_body_pdf_page_count > 496 or p_body_pdf_page_count % 8 <> 0 then
    raise exception 'VALIDATED_PAGE_COUNT_INVALID';
  end if;
  if p_body_pdf_sha256 is null or p_body_pdf_sha256 !~ '^[a-f0-9]{64}$' or
     p_cover_png_sha256 is null or p_cover_png_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'VALIDATED_ASSET_HASH_INVALID';
  end if;
  if p_body_pdf_size_bytes is null or p_body_pdf_size_bytes < 1 or p_body_pdf_size_bytes > 40000000 or
     p_cover_png_size_bytes is null or p_cover_png_size_bytes < 1 or p_cover_png_size_bytes > 40000000 then
    raise exception 'VALIDATED_ASSET_SIZE_INVALID';
  end if;
  if p_body_pdf_storage_path is distinct from (p_order_id::text || '/' || p_attempt_id::text || '/body.pdf') or
     p_cover_png_storage_path is distinct from (p_order_id::text || '/' || p_attempt_id::text || '/cover.png') then
    raise exception 'VALIDATED_ASSET_PATH_INVALID';
  end if;

  -- Lock order -> upload attempt -> validation job. This matches enqueue and
  -- upload registration. Claim/fail/retry lock attempt -> job and never wait on
  -- an order row, so they cannot form the reverse half of a lock cycle.
  select * into target_order
  from public.amuhon_orders
  where id = p_order_id
  for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  select * into target_attempt
  from public.amuhon_order_temp_upload_attempts
  where id = p_attempt_id
  for update;
  if not found or target_attempt.order_id is distinct from p_order_id then
    raise exception 'ORDER_ATTEMPT_MISMATCH';
  end if;

  select * into target_job
  from public.amuhon_order_validation_jobs
  where attempt_id = p_attempt_id
  for update;
  if not found then raise exception 'VALIDATION_JOB_NOT_FOUND'; end if;

  commit_time := clock_timestamp();

  -- Never rewrite legacy or already-committed order assets, even if a worker
  -- retries with different paths or claims that it has the same files.
  if target_order.files_validated_at is not null or
     target_order.body_pdf_page_count is not null or
     target_order.body_pdf_storage_path is not null or
     target_order.cover_png_storage_path is not null or
     target_order.body_pdf_sha256 is not null or
     target_order.cover_png_sha256 is not null then
    raise exception 'ORDER_FILES_ALREADY_FINALIZED';
  end if;
  if target_order.status <> 'preparing' then raise exception 'ORDER_NOT_PREPARING'; end if;
  if target_order.declared_body_pdf_page_count is not null and
     target_order.declared_body_pdf_page_count is distinct from p_body_pdf_page_count then
    raise exception 'DECLARED_PAGE_COUNT_MISMATCH';
  end if;

  if target_order.upload_lease_id is distinct from target_attempt.lease_id or
     target_order.upload_lease_expires_at is null or target_order.upload_lease_expires_at <= commit_time then
    raise exception 'ORDER_UPLOAD_LEASE_STALE';
  end if;
  if target_attempt.state <> 'issued' or target_attempt.expires_at <= commit_time then
    raise exception 'UPLOAD_ATTEMPT_NOT_ACTIVE';
  end if;
  if target_attempt.body_object_key is distinct from (p_order_id::text || '/' || p_attempt_id::text || '/body.pdf') or
     target_attempt.cover_object_key is distinct from (p_order_id::text || '/' || p_attempt_id::text || '/cover.png') then
    raise exception 'TEMP_ASSET_PATH_INVALID';
  end if;
  if target_job.state <> 'validating' or target_job.lease_id is distinct from p_lease_id or
     target_job.lease_expires_at is null or target_job.lease_expires_at <= commit_time or
     target_attempt.expires_at <= commit_time then
    raise exception 'VALIDATION_LEASE_STALE';
  end if;

  -- Storage I/O and byte verification are deliberately outside PostgreSQL.
  -- The trusted worker must have verified and saved these exact bytes first.
  update public.amuhon_orders set
    body_pdf_page_count = p_body_pdf_page_count,
    body_pdf_storage_path = p_body_pdf_storage_path,
    cover_png_storage_path = p_cover_png_storage_path,
    body_pdf_sha256 = p_body_pdf_sha256,
    cover_png_sha256 = p_cover_png_sha256,
    body_pdf_size_bytes = p_body_pdf_size_bytes,
    cover_png_size_bytes = p_cover_png_size_bytes,
    files_validated_at = commit_time,
    upload_lease_id = null,
    upload_lease_expires_at = null
  where id = p_order_id;

  update public.amuhon_order_validation_jobs set
    state = 'succeeded', lease_id = null, lease_expires_at = null,
    error_code = null, updated_at = commit_time
  where attempt_id = p_attempt_id and state = 'validating' and lease_id = p_lease_id
    and lease_expires_at > commit_time;
  get diagnostics updated_count = row_count;
  if updated_count <> 1 then raise exception 'VALIDATION_LEASE_STALE'; end if;

  return jsonb_build_object(
    'state', 'committed',
    'orderId', p_order_id,
    'attemptId', p_attempt_id,
    'bodyPdfPageCount', p_body_pdf_page_count,
    'filesValidatedAt', commit_time
  );
end;
$$;
revoke all on function public.commit_amuhon_order_validation_assets(uuid, uuid, uuid, integer, text, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.commit_amuhon_order_validation_assets(uuid, uuid, uuid, integer, text, text, text, text, integer, integer)
  to service_role;

create or replace function public.get_amuhon_order_validation_asset_commit_status(
  p_attempt_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_order public.amuhon_orders%rowtype;
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  target_job public.amuhon_order_validation_jobs%rowtype;
begin
  if p_attempt_id is null then
    raise exception 'VALIDATION_STATUS_INPUT_INVALID';
  end if;
  select * into target_attempt
  from public.amuhon_order_temp_upload_attempts
  where id = p_attempt_id;
  if not found then raise exception 'ORDER_ATTEMPT_MISMATCH'; end if;
  select * into target_order from public.amuhon_orders where id = target_attempt.order_id;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  select * into target_job from public.amuhon_order_validation_jobs where attempt_id = p_attempt_id;
  if not found then raise exception 'VALIDATION_JOB_NOT_FOUND'; end if;

  if target_job.state = 'succeeded' and target_order.files_validated_at is not null and
     target_order.body_pdf_page_count between 24 and 496 and target_order.body_pdf_page_count % 8 = 0 and
     target_order.body_pdf_storage_path = (target_attempt.order_id::text || '/' || p_attempt_id::text || '/body.pdf') and
     target_order.cover_png_storage_path = (target_attempt.order_id::text || '/' || p_attempt_id::text || '/cover.png') and
     target_order.body_pdf_sha256 ~ '^[a-f0-9]{64}$' and target_order.cover_png_sha256 ~ '^[a-f0-9]{64}$' and
     target_order.body_pdf_size_bytes between 1 and 40000000 and
     target_order.cover_png_size_bytes between 1 and 40000000 and
     (target_order.declared_body_pdf_page_count is null or
       target_order.declared_body_pdf_page_count = target_order.body_pdf_page_count) then
    return jsonb_build_object(
      'state', 'committed', 'orderId', target_attempt.order_id, 'attemptId', p_attempt_id,
      'bodyPdfPageCount', target_order.body_pdf_page_count,
      'bodyPdfSha256', target_order.body_pdf_sha256,
      'coverPngSha256', target_order.cover_png_sha256,
      'bodyPdfSizeBytes', target_order.body_pdf_size_bytes,
      'coverPngSizeBytes', target_order.cover_png_size_bytes,
      'filesValidatedAt', target_order.files_validated_at
    );
  end if;

  if target_order.files_validated_at is not null or target_order.body_pdf_page_count is not null or
     target_order.body_pdf_storage_path is not null or target_order.cover_png_storage_path is not null or
     target_order.body_pdf_sha256 is not null or target_order.cover_png_sha256 is not null or
     target_order.body_pdf_size_bytes is not null or target_order.cover_png_size_bytes is not null or
     target_job.state = 'succeeded' then
    return jsonb_build_object('state', 'inconsistent', 'orderId', target_attempt.order_id, 'attemptId', p_attempt_id);
  end if;
  return jsonb_build_object(
    'state', 'not_committed', 'orderId', target_attempt.order_id, 'attemptId', p_attempt_id,
    'jobState', target_job.state
  );
end;
$$;
revoke all on function public.get_amuhon_order_validation_asset_commit_status(uuid)
  from public, anon, authenticated;
grant execute on function public.get_amuhon_order_validation_asset_commit_status(uuid)
  to service_role;

-- Retain the old signature for compatibility, but never let this RPC turn a
-- validation-only job into success. All success transitions now require the
-- atomic order+job commit above.
create or replace function public.complete_amuhon_order_validation_job(
  p_attempt_id uuid,
  p_lease_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'ATOMIC_ASSET_FINALIZATION_REQUIRED';
end;
$$;
revoke all on function public.complete_amuhon_order_validation_job(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_amuhon_order_validation_job(uuid, uuid)
  to service_role;

-- Preserve enqueue's signature while preventing an old validation-only
-- succeeded row from being reported as committed. No existing row is rewritten.
create or replace function public.enqueue_amuhon_order_validation_job(
  p_order_id uuid,
  p_upload_token_hash text,
  p_attempt_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_order public.amuhon_orders%rowtype;
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  target_job public.amuhon_order_validation_jobs%rowtype;
begin
  if p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'UPLOAD_NOT_AUTHORIZED';
  end if;
  select * into target_order from public.amuhon_orders
  where id = p_order_id for update;
  if not found or target_order.upload_token_hash is distinct from p_upload_token_hash then
    raise exception 'UPLOAD_NOT_AUTHORIZED';
  end if;
  if target_order.files_validated_at is not null or target_order.status not in ('draft', 'preparing', 'failed') then
    raise exception 'ORDER_NOT_UPLOADABLE';
  end if;

  select * into target_attempt from public.amuhon_order_temp_upload_attempts
  where id = p_attempt_id and order_id = p_order_id for update;
  if not found or target_attempt.state <> 'issued' or target_attempt.expires_at <= clock_timestamp() then
    raise exception 'UPLOAD_ATTEMPT_NOT_ACTIVE';
  end if;
  select * into target_job from public.amuhon_order_validation_jobs
  where attempt_id = p_attempt_id for update;
  if found then
    if target_job.state = 'succeeded' and not (
      target_order.files_validated_at is not null and
      target_order.body_pdf_storage_path = (p_order_id::text || '/' || p_attempt_id::text || '/body.pdf') and
      target_order.cover_png_storage_path = (p_order_id::text || '/' || p_attempt_id::text || '/cover.png') and
      target_order.body_pdf_sha256 is not null and target_order.cover_png_sha256 is not null
    ) then
      raise exception 'VALIDATION_JOB_LEGACY_SUCCESS_REQUIRES_REVIEW';
    end if;
    if target_job.state in ('queued', 'validating', 'succeeded') then
      return jsonb_build_object(
        'attemptId', target_job.attempt_id, 'state', target_job.state,
        'attemptCount', target_job.attempt_count, 'createdAt', target_job.created_at
      );
    end if;
    raise exception 'VALIDATION_JOB_TERMINAL';
  end if;
  if target_order.files_validated_at is not null or target_order.status not in ('draft', 'preparing', 'failed') then
    raise exception 'ORDER_NOT_UPLOADABLE';
  end if;
  insert into public.amuhon_order_validation_jobs (attempt_id)
  values (p_attempt_id) returning * into target_job;
  return jsonb_build_object(
    'attemptId', target_job.attempt_id, 'state', target_job.state,
    'attemptCount', target_job.attempt_count, 'createdAt', target_job.created_at
  );
end;
$$;
revoke all on function public.enqueue_amuhon_order_validation_job(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_amuhon_order_validation_job(uuid, text, uuid)
  to service_role;

-- Eligibility is shared by the exact-attempt staging-safe RPC and the existing
-- global cleaner. A successful job is cleanable only after the order row points
-- at both immutable final keys. No Storage operation occurs inside this helper.
create or replace function public.amuhon_order_temp_upload_attempt_cleanup_eligible(
  p_attempt_id uuid
) returns boolean
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from public.amuhon_order_temp_upload_attempts as attempts
    left join public.amuhon_order_validation_jobs as jobs on jobs.attempt_id = attempts.id
    left join public.amuhon_orders as orders on orders.id = attempts.order_id
    where attempts.id = p_attempt_id
      and attempts.expires_at <= clock_timestamp()
      and (
        attempts.state in ('issued', 'cleanup_failed') or
        (attempts.state = 'cleaning' and attempts.cleanup_claimed_at <= clock_timestamp() - interval '10 minutes')
      )
      and (
        jobs.attempt_id is null or jobs.state = 'failed' or
        (jobs.state = 'succeeded' and orders.files_validated_at is not null and
         orders.body_pdf_storage_path = (attempts.order_id::text || '/' || attempts.id::text || '/body.pdf') and
         orders.cover_png_storage_path = (attempts.order_id::text || '/' || attempts.id::text || '/cover.png') and
         orders.body_pdf_page_count between 24 and 496 and orders.body_pdf_page_count % 8 = 0 and
         (orders.declared_body_pdf_page_count is null or
           orders.declared_body_pdf_page_count = orders.body_pdf_page_count) and
         orders.body_pdf_sha256 ~ '^[a-f0-9]{64}$' and orders.cover_png_sha256 ~ '^[a-f0-9]{64}$' and
         orders.body_pdf_size_bytes between 1 and 40000000 and
         orders.cover_png_size_bytes between 1 and 40000000)
      )
  );
$$;
revoke all on function public.amuhon_order_temp_upload_attempt_cleanup_eligible(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.claim_amuhon_order_temp_upload_attempt_cleanup(
  p_attempt_id uuid,
  p_cleanup_lease_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
begin
  if p_attempt_id is null or p_cleanup_lease_id is null then
    raise exception 'INVALID_CLEANUP_INPUT';
  end if;
  select * into target_attempt
  from public.amuhon_order_temp_upload_attempts
  where id = p_attempt_id
  for update skip locked;
  if not found or not public.amuhon_order_temp_upload_attempt_cleanup_eligible(p_attempt_id) then
    return null;
  end if;
  update public.amuhon_order_temp_upload_attempts set
    state = 'cleaning', cleanup_lease_id = p_cleanup_lease_id,
    cleanup_claimed_at = clock_timestamp()
  where id = p_attempt_id;
  return jsonb_build_object(
    'attemptId', target_attempt.id, 'orderId', target_attempt.order_id,
    'bodyObjectKey', target_attempt.body_object_key,
    'coverObjectKey', target_attempt.cover_object_key
  );
end;
$$;
revoke all on function public.claim_amuhon_order_temp_upload_attempt_cleanup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_amuhon_order_temp_upload_attempt_cleanup(uuid, uuid)
  to service_role;

-- Keep the existing global cleaner signature and return shape. It locks only
-- attempt rows and checks the order via a non-locking read, avoiding a reverse
-- order-lock edge against the atomic commit RPC.
create or replace function public.claim_expired_amuhon_order_temp_upload_attempts(
  p_cleanup_lease_id uuid,
  p_limit integer default 50
) returns table (attempt_id uuid, order_id uuid, body_object_key text, cover_object_key text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  candidate_id uuid;
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  claimed integer := 0;
begin
  if p_cleanup_lease_id is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_CLEANUP_LIMIT';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'CLEANUP_REQUIRES_READ_COMMITTED';
  end if;
  for candidate_id in
    select attempts.id
    from public.amuhon_order_temp_upload_attempts as attempts
    where attempts.expires_at <= clock_timestamp() and (
      attempts.state in ('issued', 'cleanup_failed') or
      (attempts.state = 'cleaning' and attempts.cleanup_claimed_at <= clock_timestamp() - interval '10 minutes')
    )
    order by attempts.expires_at
  loop
    select * into target_attempt
    from public.amuhon_order_temp_upload_attempts
    where id = candidate_id
    for update skip locked;
    if not found or not public.amuhon_order_temp_upload_attempt_cleanup_eligible(candidate_id) then
      continue;
    end if;
    update public.amuhon_order_temp_upload_attempts set
      state = 'cleaning', cleanup_lease_id = p_cleanup_lease_id,
      cleanup_claimed_at = clock_timestamp()
    where id = candidate_id;
    attempt_id := target_attempt.id;
    order_id := target_attempt.order_id;
    body_object_key := target_attempt.body_object_key;
    cover_object_key := target_attempt.cover_object_key;
    return next;
    claimed := claimed + 1;
    if claimed >= p_limit then exit; end if;
  end loop;
end;
$$;
revoke all on function public.claim_expired_amuhon_order_temp_upload_attempts(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_expired_amuhon_order_temp_upload_attempts(uuid, integer)
  to service_role;

comment on table public.amuhon_order_validation_jobs is
  'Private one-per-temp-attempt validation queue. succeeded means validated final objects and matching order metadata were committed atomically; it does not mean the order is payable.';

