-- ISOLATED DATABASE ONLY. Never run against shared staging or production.
-- This invokes the global cleanup-claim RPC. It uses synthetic rows, performs
-- no Storage calls, and rolls back all database writes at the end.
-- Requires the order-draft, temp-upload, and validation-job migrations.
begin isolation level read committed;
do $validation_job_cleanup_tests$
declare
  order_id uuid := gen_random_uuid();
  idem_key uuid := gen_random_uuid();
  upload_lease_id uuid := gen_random_uuid();
  cleanup_lease_id uuid := gen_random_uuid();
  retry_cleanup_lease_id uuid := gen_random_uuid();
  protected_attempt_id uuid := gen_random_uuid();
  eligible_attempt_id uuid := gen_random_uuid();
  rate_key text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  asset_rate_key text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  token_hash text := repeat('d', 64);
  order_result jsonb;
  upload_result jsonb;
  cleanup_ids uuid[];
  cleanup_count bigint;
begin
  if to_regprocedure('public.claim_expired_amuhon_order_temp_upload_attempts(uuid,integer)') is null or
     to_regprocedure('public.finish_amuhon_order_temp_upload_cleanup(uuid,uuid,boolean)') is null then
    raise exception '[SCHEMA] apply the temp-upload migration first';
  end if;
  -- Fail closed unless this is an empty, dedicated test database. These reads
  -- do not lock rows. This guard also prevents the script from running in the
  -- stated staging environment where an expired issued attempt exists.
  if exists (select 1 from public.amuhon_orders) or
     exists (select 1 from public.amuhon_order_rate_limits) or
     exists (select 1 from public.amuhon_order_asset_rate_limits) or
     exists (select 1 from public.amuhon_order_temp_upload_attempts) or
     exists (select 1 from public.amuhon_order_validation_jobs) then
    raise exception 'STOP: cleanup RPC test requires an empty isolated database';
  end if;

  order_result := public.create_amuhon_order_draft_with_upload_token(
    order_id, idem_key, '{"name":"synthetic"}'::jsonb,
    '{"title":"synthetic","works":[]}'::jsonb, 24, rate_key, token_hash, 1
  );
  if order_result->>'id' <> order_id::text then raise exception '[DRAFT] synthetic order creation failed'; end if;
  upload_result := public.begin_amuhon_order_asset_upload(order_id, token_hash, asset_rate_key, upload_lease_id);
  if upload_result->>'state' <> 'claimed' then raise exception '[UPLOAD] synthetic lease acquisition failed'; end if;

  -- The queued job must protect its expired attempt. The unqueued synthetic
  -- attempt is the only eligible cleanup target in this empty database.
  perform public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, upload_lease_id, protected_attempt_id);
  perform public.enqueue_amuhon_order_validation_job(order_id, token_hash, protected_attempt_id);
  perform public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, upload_lease_id, eligible_attempt_id);
  update public.amuhon_order_temp_upload_attempts
  set expires_at = clock_timestamp() - interval '1 second'
  where id in (protected_attempt_id, eligible_attempt_id);

  select count(*), array_agg(attempts.attempt_id) into cleanup_count, cleanup_ids
  from public.claim_expired_amuhon_order_temp_upload_attempts(cleanup_lease_id, 1) as attempts;
  if cleanup_count <> 1 or cleanup_ids[1] is distinct from eligible_attempt_id then
    raise exception '[CLEANUP SCOPE] global cleaner did not skip the queued attempt and claim only the eligible synthetic attempt';
  end if;
  if (select state from public.amuhon_order_temp_upload_attempts where id = protected_attempt_id) <> 'issued' then
    raise exception '[CLEANUP PROTECTION] queued attempt changed state';
  end if;
  if not public.finish_amuhon_order_temp_upload_cleanup(cleanup_lease_id, eligible_attempt_id, false) then
    raise exception '[CLEANUP FAILURE] synthetic cleanup failure was not recorded';
  end if;
  if (select state from public.amuhon_order_temp_upload_attempts where id = eligible_attempt_id) <> 'cleanup_failed' then
    raise exception '[CLEANUP FAILURE] expected cleanup_failed state';
  end if;

  select count(*), array_agg(attempts.attempt_id) into cleanup_count, cleanup_ids
  from public.claim_expired_amuhon_order_temp_upload_attempts(retry_cleanup_lease_id, 1) as attempts;
  if cleanup_count <> 1 or cleanup_ids[1] is distinct from eligible_attempt_id then
    raise exception '[CLEANUP RETRY] cleanup_failed synthetic attempt was not re-claimed';
  end if;
  if not public.finish_amuhon_order_temp_upload_cleanup(retry_cleanup_lease_id, eligible_attempt_id, true) then
    raise exception '[CLEANUP COMPLETE] synthetic cleanup completion was not recorded';
  end if;
  if (select state from public.amuhon_order_temp_upload_attempts where id = eligible_attempt_id) <> 'cleaned' then
    raise exception '[CLEANUP COMPLETE] expected cleaned state';
  end if;
end
$validation_job_cleanup_tests$;
select 'ALL ISOLATED CLEANUP TESTS PASSED' as result;
rollback;
