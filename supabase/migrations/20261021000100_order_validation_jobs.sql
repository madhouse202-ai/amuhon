-- Additive queue/lease management for temporary-upload validation.
-- This migration does not alter orders, Storage objects, or existing assets.

create table if not exists public.amuhon_order_validation_jobs (
  attempt_id uuid primary key
    references public.amuhon_order_temp_upload_attempts (id) on delete restrict,
  state text not null default 'queued'
    check (state in ('queued', 'validating', 'succeeded', 'failed')),
  lease_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    error_code is null or error_code in (
      'invalid_pdf', 'invalid_cover', 'page_count_mismatch',
      'dimensions_mismatch', 'unsupported_format', 'file_too_large',
      'attempt_expired', 'storage_unavailable', 'processing_timeout',
      'worker_unavailable', 'internal_error'
    )
  ),
  check (
    (state = 'queued' and lease_id is null and lease_expires_at is null and error_code is null) or
    (state = 'validating' and lease_id is not null and lease_expires_at is not null and error_code is null) or
    (state = 'succeeded' and lease_id is null and lease_expires_at is null and error_code is null) or
    (state = 'failed' and lease_id is null and lease_expires_at is null and error_code is not null)
  )
);

create index if not exists amuhon_order_validation_jobs_claim_idx
  on public.amuhon_order_validation_jobs (created_at, attempt_id)
  where state in ('queued', 'validating');
create unique index if not exists amuhon_order_validation_jobs_live_lease_idx
  on public.amuhon_order_validation_jobs (lease_id)
  where lease_id is not null;

alter table public.amuhon_order_validation_jobs enable row level security;
revoke all on public.amuhon_order_validation_jobs from public, anon, authenticated, service_role;

comment on table public.amuhon_order_validation_jobs is
  'Private one-per-temp-attempt validation queue. succeeded means file validation passed; it does not mean the order is payable or final assets were promoted.';

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

  -- Keep the existing order -> attempt lock order used by upload registration.
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
    if target_job.state in ('queued', 'validating', 'succeeded') then
      return jsonb_build_object(
        'attemptId', target_job.attempt_id,
        'state', target_job.state,
        'attemptCount', target_job.attempt_count,
        'createdAt', target_job.created_at
      );
    end if;
    -- Failed attempts retain immutable Storage keys. Retries use a fresh
    -- temporary attempt instead of risking conflict with leftover objects.
    raise exception 'VALIDATION_JOB_TERMINAL';
  end if;

  insert into public.amuhon_order_validation_jobs (attempt_id)
  values (p_attempt_id)
  returning * into target_job;
  return jsonb_build_object(
    'attemptId', target_job.attempt_id,
    'state', target_job.state,
    'attemptCount', target_job.attempt_count,
    'createdAt', target_job.created_at
  );
end;
$$;
revoke all on function public.enqueue_amuhon_order_validation_job(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_amuhon_order_validation_job(uuid, text, uuid) to service_role;

create or replace function public.claim_amuhon_order_validation_job(
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  candidate record;
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  target_job public.amuhon_order_validation_jobs%rowtype;
  claim_started_at timestamptz := clock_timestamp();
  next_lease_expiry timestamptz;
  new_lease_id uuid;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'INVALID_VALIDATION_LEASE';
  end if;

  -- Candidate rows are only read here. All mutating paths lock the temp
  -- attempt first and the job second, matching the cleaner's attempt lock.
  for candidate in
    select jobs.attempt_id
    from public.amuhon_order_validation_jobs as jobs
    where jobs.state = 'queued' or
      (jobs.state = 'validating' and jobs.lease_expires_at <= claim_started_at)
    order by jobs.created_at, jobs.attempt_id
    limit 100
  loop
    select * into target_attempt
    from public.amuhon_order_temp_upload_attempts
    where id = candidate.attempt_id
    for update skip locked;
    if not found then continue; end if;

    select * into target_job
    from public.amuhon_order_validation_jobs
    where attempt_id = candidate.attempt_id
    for update;
    if not found or not (
      target_job.state = 'queued' or
      (target_job.state = 'validating' and target_job.lease_expires_at <= clock_timestamp())
    ) then
      continue;
    end if;

    if target_attempt.state <> 'issued' or target_attempt.expires_at <= clock_timestamp() + interval '30 seconds' then
      update public.amuhon_order_validation_jobs set
        state = 'failed', lease_id = null, lease_expires_at = null,
        error_code = 'attempt_expired', updated_at = clock_timestamp()
      where attempt_id = candidate.attempt_id;
      continue;
    end if;
    if target_job.attempt_count >= 5 then
      update public.amuhon_order_validation_jobs set
        state = 'failed', lease_id = null, lease_expires_at = null,
        error_code = 'processing_timeout', updated_at = clock_timestamp()
      where attempt_id = candidate.attempt_id;
      continue;
    end if;

    next_lease_expiry := least(
      clock_timestamp() + make_interval(secs => p_lease_seconds),
      target_attempt.expires_at
    );
    -- Lease identity is generated inside the database for every successful
    -- claim. A caller cannot deliberately reuse an expired worker's token.
    new_lease_id := pg_catalog.gen_random_uuid();
    update public.amuhon_order_validation_jobs set
      state = 'validating', lease_id = new_lease_id,
      lease_expires_at = next_lease_expiry,
      attempt_count = attempt_count + 1,
      error_code = null,
      updated_at = clock_timestamp()
    where attempt_id = candidate.attempt_id
    returning * into target_job;

    return jsonb_build_object(
      'attemptId', target_job.attempt_id,
      'state', target_job.state,
      'leaseId', target_job.lease_id,
      'leaseExpiresAt', target_job.lease_expires_at,
      'attemptCount', target_job.attempt_count,
      'orderId', target_attempt.order_id,
      'bodyObjectKey', target_attempt.body_object_key,
      'coverObjectKey', target_attempt.cover_object_key
    );
  end loop;
  return null;
end;
$$;
revoke all on function public.claim_amuhon_order_validation_job(integer) from public, anon, authenticated;
grant execute on function public.claim_amuhon_order_validation_job(integer) to service_role;

create or replace function public.complete_amuhon_order_validation_job(
  p_attempt_id uuid,
  p_lease_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  target_job public.amuhon_order_validation_jobs%rowtype;
begin
  select * into target_attempt from public.amuhon_order_temp_upload_attempts
  where id = p_attempt_id for update;
  if not found then raise exception 'VALIDATION_JOB_NOT_CLAIMED'; end if;
  select * into target_job from public.amuhon_order_validation_jobs
  where attempt_id = p_attempt_id for update;
  if not found or target_job.state <> 'validating' or target_job.lease_id is distinct from p_lease_id or
     target_job.lease_expires_at <= clock_timestamp() or target_attempt.state <> 'issued' or
     target_attempt.expires_at <= clock_timestamp() then
    raise exception 'VALIDATION_LEASE_STALE';
  end if;
  update public.amuhon_order_validation_jobs set
    state = 'succeeded', lease_id = null, lease_expires_at = null,
    error_code = null, updated_at = clock_timestamp()
  where attempt_id = p_attempt_id;
  return true;
end;
$$;
revoke all on function public.complete_amuhon_order_validation_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_amuhon_order_validation_job(uuid, uuid) to service_role;

create or replace function public.fail_amuhon_order_validation_job(
  p_attempt_id uuid,
  p_lease_id uuid,
  p_error_code text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  target_job public.amuhon_order_validation_jobs%rowtype;
begin
  if p_error_code is null or p_error_code not in (
    'invalid_pdf', 'invalid_cover', 'page_count_mismatch',
    'dimensions_mismatch', 'unsupported_format', 'file_too_large',
    'attempt_expired', 'storage_unavailable', 'processing_timeout',
    'worker_unavailable', 'internal_error'
  ) then
    raise exception 'INVALID_VALIDATION_ERROR_CODE';
  end if;
  select * into target_attempt from public.amuhon_order_temp_upload_attempts
  where id = p_attempt_id for update;
  if not found then raise exception 'VALIDATION_JOB_NOT_CLAIMED'; end if;
  select * into target_job from public.amuhon_order_validation_jobs
  where attempt_id = p_attempt_id for update;
  if not found or target_job.state <> 'validating' or target_job.lease_id is distinct from p_lease_id or
     target_job.lease_expires_at <= clock_timestamp() or target_attempt.state <> 'issued' or
     target_attempt.expires_at <= clock_timestamp() then
    raise exception 'VALIDATION_LEASE_STALE';
  end if;
  update public.amuhon_order_validation_jobs set
    state = 'failed', lease_id = null, lease_expires_at = null,
    error_code = p_error_code, updated_at = clock_timestamp()
  where attempt_id = p_attempt_id;
  return true;
end;
$$;
revoke all on function public.fail_amuhon_order_validation_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_amuhon_order_validation_job(uuid, uuid, text) to service_role;

create or replace function public.retry_amuhon_order_validation_job(
  p_attempt_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  target_job public.amuhon_order_validation_jobs%rowtype;
begin
  select * into target_attempt from public.amuhon_order_temp_upload_attempts
  where id = p_attempt_id for update;
  if not found then raise exception 'VALIDATION_JOB_NOT_RETRYABLE'; end if;
  select * into target_job from public.amuhon_order_validation_jobs
  where attempt_id = p_attempt_id for update;
  if not found or target_job.state <> 'failed' or target_job.error_code not in (
       'storage_unavailable', 'processing_timeout', 'worker_unavailable', 'internal_error'
     ) or target_job.attempt_count >= 5 or target_attempt.state <> 'issued' or
     target_attempt.expires_at <= clock_timestamp() then
    raise exception 'VALIDATION_JOB_NOT_RETRYABLE';
  end if;
  update public.amuhon_order_validation_jobs set
    state = 'queued', lease_id = null, lease_expires_at = null,
    error_code = null, updated_at = clock_timestamp()
  where attempt_id = p_attempt_id;
  return true;
end;
$$;
revoke all on function public.retry_amuhon_order_validation_job(uuid) from public, anon, authenticated;
grant execute on function public.retry_amuhon_order_validation_job(uuid) to service_role;

-- The existing cleaner is global. Serialize on the attempt row and retain all
-- attempts with live/passed validation work; failed attempts may be cleaned
-- after expiry. succeeded is retained for the later verified-file promotion
-- stage because this migration does not copy or finalize files.
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
  -- Recheck job state in a separate statement after locking each attempt.
  -- Under READ COMMITTED this sees an enqueue that committed while cleanup
  -- waited for the same row lock. Other isolation levels fail closed.
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
    if not found or target_attempt.expires_at > clock_timestamp() or not (
      target_attempt.state in ('issued', 'cleanup_failed') or
      (target_attempt.state = 'cleaning' and target_attempt.cleanup_claimed_at <= clock_timestamp() - interval '10 minutes')
    ) then
      continue;
    end if;

    if exists (
      select 1 from public.amuhon_order_validation_jobs as jobs
      where jobs.attempt_id = candidate_id and jobs.state in ('queued', 'validating', 'succeeded')
    ) then
      continue;
    end if;

    update public.amuhon_order_temp_upload_attempts as attempts
    set state = 'cleaning', cleanup_lease_id = p_cleanup_lease_id,
        cleanup_claimed_at = clock_timestamp()
    where attempts.id = candidate_id;
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
revoke all on function public.claim_expired_amuhon_order_temp_upload_attempts(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_expired_amuhon_order_temp_upload_attempts(uuid, integer) to service_role;
