-- Add declared-page metadata to the existing global claim and an exact-attempt
-- claim RPC. This migration does not touch existing rows or Storage objects.

create or replace function public.claim_amuhon_order_validation_job(
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  candidate record;
  target_order public.amuhon_orders%rowtype;
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  target_job public.amuhon_order_validation_jobs%rowtype;
  claim_started_at timestamptz := clock_timestamp();
  claim_checked_at timestamptz;
  next_lease_expiry timestamptz;
  new_lease_id uuid;
  declared_page_count integer;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'INVALID_VALIDATION_LEASE';
  end if;

  -- Candidate discovery is non-locking. Lock order -> attempt -> job, matching
  -- enqueue, upload registration, and atomic commit. SKIP LOCKED avoids waiting
  -- on rows held by those paths or by the attempt-first fail/retry/cleaner paths.
  for candidate in
    select jobs.attempt_id, attempts.order_id
    from public.amuhon_order_validation_jobs as jobs
    join public.amuhon_order_temp_upload_attempts as attempts on attempts.id = jobs.attempt_id
    where jobs.state = 'queued' or
      (jobs.state = 'validating' and jobs.lease_expires_at <= claim_started_at)
    order by jobs.created_at, jobs.attempt_id
    limit 100
  loop
    select * into target_order
    from public.amuhon_orders
    where id = candidate.order_id
    for update skip locked;
    if not found then continue; end if;

    select * into target_attempt
    from public.amuhon_order_temp_upload_attempts
    where id = candidate.attempt_id and order_id = candidate.order_id
    for update skip locked;
    if not found then continue; end if;

    select * into target_job
    from public.amuhon_order_validation_jobs
    where attempt_id = candidate.attempt_id
    for update skip locked;
    if not found or not (
      target_job.state = 'queued' or
      (target_job.state = 'validating' and target_job.lease_expires_at <= clock_timestamp())
    ) then
      continue;
    end if;

    claim_checked_at := clock_timestamp();

    if target_attempt.state <> 'issued' or target_attempt.expires_at <= claim_checked_at + interval '30 seconds' then
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

    -- Recheck the order lease and finalization fields only after locking the
    -- order row. A stale/rotated upload lease must never reach asset promotion.
    if target_order.status <> 'preparing' or
       target_order.upload_lease_id is distinct from target_attempt.lease_id or
       target_order.upload_lease_expires_at is null or
       target_order.upload_lease_expires_at <= claim_checked_at + interval '30 seconds' or
       target_order.files_validated_at is not null or
       target_order.body_pdf_page_count is not null or
       target_order.body_pdf_storage_path is not null or
       target_order.cover_png_storage_path is not null or
       target_order.body_pdf_sha256 is not null or
       target_order.cover_png_sha256 is not null or
       target_order.body_pdf_size_bytes is not null or
       target_order.cover_png_size_bytes is not null then
      update public.amuhon_order_validation_jobs set
        state = 'failed', lease_id = null, lease_expires_at = null,
        error_code = 'attempt_expired', updated_at = clock_timestamp()
      where attempt_id = candidate.attempt_id;
      continue;
    end if;

    declared_page_count := target_order.declared_body_pdf_page_count;

    next_lease_expiry := least(
      claim_checked_at + make_interval(secs => p_lease_seconds),
      target_attempt.expires_at,
      target_order.upload_lease_expires_at
    );
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
      'coverObjectKey', target_attempt.cover_object_key,
      'declaredPageCount', declared_page_count
    );
  end loop;
  return null;
end;
$$;
revoke all on function public.claim_amuhon_order_validation_job(integer) from public, anon, authenticated;
grant execute on function public.claim_amuhon_order_validation_job(integer) to service_role;

create or replace function public.claim_amuhon_order_validation_job_for_attempt(
  p_order_id uuid,
  p_attempt_id uuid,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_order public.amuhon_orders%rowtype;
  target_attempt public.amuhon_order_temp_upload_attempts%rowtype;
  target_job public.amuhon_order_validation_jobs%rowtype;
  declared_page_count integer;
  claim_checked_at timestamptz;
  next_lease_expiry timestamptz;
  new_lease_id uuid;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'INVALID_VALIDATION_LEASE';
  end if;
  if p_order_id is null or p_attempt_id is null then
    return null;
  end if;

  -- Exact identifiers only. Lock order -> attempt -> job; this matches enqueue,
  -- upload registration, and commit, while SKIP LOCKED avoids lock cycles with
  -- attempt-first fail/retry/cleanup paths.
  select * into target_order
  from public.amuhon_orders
  where id = p_order_id
  for update skip locked;
  if not found then return null; end if;

  select * into target_attempt
  from public.amuhon_order_temp_upload_attempts
  where id = p_attempt_id and order_id = p_order_id
  for update skip locked;
  if not found then return null; end if;

  select * into target_job
  from public.amuhon_order_validation_jobs
  where attempt_id = p_attempt_id
  for update skip locked;
  if not found or not (
    target_job.state = 'queued' or
    (target_job.state = 'validating' and target_job.lease_expires_at <= clock_timestamp())
  ) then
    return null;
  end if;

  claim_checked_at := clock_timestamp();

  -- Preserve the global claim's expiry, attempt-state, and retry-limit rules.
  if target_attempt.state <> 'issued' or target_attempt.expires_at <= claim_checked_at + interval '30 seconds' then
    update public.amuhon_order_validation_jobs set
      state = 'failed', lease_id = null, lease_expires_at = null,
      error_code = 'attempt_expired', updated_at = clock_timestamp()
    where attempt_id = p_attempt_id;
    return null;
  end if;
  if target_job.attempt_count >= 5 then
    update public.amuhon_order_validation_jobs set
      state = 'failed', lease_id = null, lease_expires_at = null,
      error_code = 'processing_timeout', updated_at = clock_timestamp()
    where attempt_id = p_attempt_id;
    return null;
  end if;

  if target_order.status <> 'preparing' or
     target_order.upload_lease_id is distinct from target_attempt.lease_id or
     target_order.upload_lease_expires_at is null or
     target_order.upload_lease_expires_at <= claim_checked_at + interval '30 seconds' or
     target_order.files_validated_at is not null or
     target_order.body_pdf_page_count is not null or
     target_order.body_pdf_storage_path is not null or
     target_order.cover_png_storage_path is not null or
     target_order.body_pdf_sha256 is not null or
     target_order.cover_png_sha256 is not null or
     target_order.body_pdf_size_bytes is not null or
     target_order.cover_png_size_bytes is not null then
    update public.amuhon_order_validation_jobs set
      state = 'failed', lease_id = null, lease_expires_at = null,
      error_code = 'attempt_expired', updated_at = clock_timestamp()
    where attempt_id = p_attempt_id;
    return null;
  end if;
  declared_page_count := target_order.declared_body_pdf_page_count;

  next_lease_expiry := least(
    claim_checked_at + make_interval(secs => p_lease_seconds),
    target_attempt.expires_at,
    target_order.upload_lease_expires_at
  );
  new_lease_id := pg_catalog.gen_random_uuid();
  update public.amuhon_order_validation_jobs set
    state = 'validating', lease_id = new_lease_id,
    lease_expires_at = next_lease_expiry,
    attempt_count = attempt_count + 1,
    error_code = null,
    updated_at = clock_timestamp()
  where attempt_id = p_attempt_id
  returning * into target_job;

  return jsonb_build_object(
    'attemptId', target_job.attempt_id,
    'state', target_job.state,
    'leaseId', target_job.lease_id,
    'leaseExpiresAt', target_job.lease_expires_at,
    'attemptCount', target_job.attempt_count,
    'orderId', target_attempt.order_id,
    'bodyObjectKey', target_attempt.body_object_key,
    'coverObjectKey', target_attempt.cover_object_key,
    'declaredPageCount', declared_page_count
  );
end;
$$;
revoke all on function public.claim_amuhon_order_validation_job_for_attempt(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_amuhon_order_validation_job_for_attempt(uuid, uuid, integer)
  to service_role;
