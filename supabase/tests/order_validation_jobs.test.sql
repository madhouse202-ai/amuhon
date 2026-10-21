-- Run manually only in amuhon-staging SQL Editor after applying
-- 20261021000100_order_validation_jobs.sql. Uses synthetic rows and rolls back.
-- This staging-safe test deliberately does not call the global temp-file cleaner.
-- READ COMMITTED remains the expected isolation level for related RPC behavior.
begin isolation level read committed;
do $validation_job_tests$
<<test_block>>
declare
  confirmed_project constant text := 'amuhon-staging';
  order_id uuid := gen_random_uuid();
  idem_key uuid := gen_random_uuid();
  upload_lease_id uuid := gen_random_uuid();
  attempt_expired_id uuid := gen_random_uuid();
  attempt_success_id uuid := gen_random_uuid();
  attempt_retry_id uuid := gen_random_uuid();
  first_claim_lease uuid;
  reclaimed_lease uuid;
  first_retry_lease uuid;
  retry_claim_lease uuid;
  token_hash text := repeat('c', 64);
  job_result jsonb;
  rejected boolean;
  proc regprocedure;
begin
  if confirmed_project <> 'amuhon-staging' then raise exception 'STOP: wrong Supabase project'; end if;
  if to_regclass('public.amuhon_order_validation_jobs') is null or
     to_regprocedure('public.enqueue_amuhon_order_validation_job(uuid,text,uuid)') is null or
     to_regprocedure('public.claim_amuhon_order_validation_job(integer)') is null or
     to_regprocedure('public.complete_amuhon_order_validation_job(uuid,uuid)') is null or
     to_regprocedure('public.fail_amuhon_order_validation_job(uuid,uuid,text)') is null or
     to_regprocedure('public.retry_amuhon_order_validation_job(uuid)') is null then
    raise exception '[SCHEMA] apply validation job migration first';
  end if;
  if to_regprocedure('public.claim_amuhon_order_validation_job(uuid,integer)') is not null then
    raise exception '[LEASE API] caller-controlled lease-ID overload must not exist';
  end if;

  -- claim_amuhon_order_validation_job is global too. Refuse to run when any
  -- pre-existing queued or expired lease could be claimed. This check has a
  -- race with concurrent enqueue/worker activity; pause those processes while
  -- running this script. The expired issued attempt described in the staging
  -- setup is not touched because this script never calls the cleanup RPC.
  if exists (
    select 1 from public.amuhon_order_validation_jobs as jobs
    where jobs.state = 'queued' or
      (jobs.state = 'validating' and jobs.lease_expires_at <= clock_timestamp())
  ) then
    raise exception 'STOP: existing validation jobs could be claimed by the global worker RPC';
  end if;
  if exists (select 1 from public.amuhon_orders where id = order_id or idempotency_key = idem_key) or
     exists (
       select 1 from public.amuhon_order_temp_upload_attempts
       where id in (attempt_expired_id, attempt_success_id, attempt_retry_id)
     ) or
     exists (
       select 1 from public.amuhon_order_validation_jobs
       where attempt_id in (attempt_expired_id, attempt_success_id, attempt_retry_id)
     ) then
    raise exception 'STOP: generated test identifier collision';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.amuhon_order_validation_jobs'::regclass) or
     has_table_privilege('anon', 'public.amuhon_order_validation_jobs', 'SELECT') or
     has_table_privilege('authenticated', 'public.amuhon_order_validation_jobs', 'SELECT') or
     has_table_privilege('service_role', 'public.amuhon_order_validation_jobs', 'SELECT') then
    raise exception '[TABLE SECURITY] validation job table grants or RLS are incorrect';
  end if;

  for proc in select unnest(array[
    'public.enqueue_amuhon_order_validation_job(uuid,text,uuid)'::regprocedure,
    'public.claim_amuhon_order_validation_job(integer)'::regprocedure,
    'public.complete_amuhon_order_validation_job(uuid,uuid)'::regprocedure,
    'public.fail_amuhon_order_validation_job(uuid,uuid,text)'::regprocedure,
    'public.retry_amuhon_order_validation_job(uuid)'::regprocedure
  ]) loop
    if exists (
      select 1 from pg_proc as p
      where p.oid = proc and (
        not p.prosecdef or pg_get_userbyid(p.proowner) <> 'postgres' or
        not (coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, pg_temp']) or
        has_function_privilege('anon', p.oid, 'EXECUTE') or
        has_function_privilege('authenticated', p.oid, 'EXECUTE') or
        not has_function_privilege('service_role', p.oid, 'EXECUTE') or
        exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        )
      )
    ) then raise exception '[RPC SECURITY] owner, search_path, SECURITY DEFINER, or grants incorrect for %', proc; end if;
  end loop;

  -- Seed only this transaction's synthetic order directly. Calling the draft
  -- creation or upload-start RPCs here would globally prune stale rate-limit
  -- rows, so the test intentionally avoids both RPCs.
  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, upload_token_hash,
    upload_lease_id, upload_lease_expires_at
  ) values (
    order_id, idem_key, 'preparing', '{"name":"synthetic"}'::jsonb,
    '{"title":"synthetic","works":[]}'::jsonb, 24, token_hash,
    upload_lease_id, clock_timestamp() + interval '1 hour'
  );

  -- An expired synthetic upload with a queued job is failed by the worker
  -- claim path. This checks validation behavior only; no cleanup RPC is called.
  perform public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, upload_lease_id, attempt_expired_id);
  job_result := public.enqueue_amuhon_order_validation_job(order_id, token_hash, attempt_expired_id);
  if job_result->>'state' <> 'queued' then raise exception '[ENQUEUE] initial job was not queued'; end if;
  if (public.enqueue_amuhon_order_validation_job(order_id, token_hash, attempt_expired_id)->>'state') <> 'queued' then
    raise exception '[IDEMPOTENCY] repeated enqueue changed job state';
  end if;
  update public.amuhon_order_temp_upload_attempts
  set expires_at = clock_timestamp() - interval '1 second'
  where id = attempt_expired_id;
  if public.claim_amuhon_order_validation_job(300) is not null then
    raise exception '[EXPIRED ATTEMPT] worker claimed an expired temp attempt';
  end if;
  if (select state from public.amuhon_order_validation_jobs where attempt_id = attempt_expired_id) <> 'failed' or
     (select error_code from public.amuhon_order_validation_jobs where attempt_id = attempt_expired_id) <> 'attempt_expired' then
    raise exception '[EXPIRED ATTEMPT] expired queued job did not fail safely';
  end if;
  -- Lease expiration permits a fresh exclusive claim. The stale worker lease
  -- cannot complete, and the active one can complete only once.
  perform public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, upload_lease_id, attempt_success_id);
  perform public.enqueue_amuhon_order_validation_job(order_id, token_hash, attempt_success_id);
  job_result := public.claim_amuhon_order_validation_job(300);
  if job_result->>'attemptId' <> attempt_success_id::text or job_result->>'state' <> 'validating' or
     (job_result->>'attemptCount')::integer <> 1 or job_result->>'leaseId' is null then
    raise exception '[CLAIM] first exclusive job claim failed';
  end if;
  first_claim_lease := (job_result->>'leaseId')::uuid;
  if public.claim_amuhon_order_validation_job(300) is not null then
    raise exception '[EXCLUSIVE CLAIM] an active job was claimed twice';
  end if;
  update public.amuhon_order_validation_jobs
  set lease_expires_at = clock_timestamp() - interval '1 second'
  where attempt_id = attempt_success_id;
  job_result := public.claim_amuhon_order_validation_job(300);
  if job_result->>'attemptId' <> attempt_success_id::text or
     job_result->>'leaseId' is null or
     (job_result->>'attemptCount')::integer <> 2 then
    raise exception '[LEASE RECLAIM] expired validation lease was not reclaimed';
  end if;
  reclaimed_lease := (job_result->>'leaseId')::uuid;
  if reclaimed_lease = first_claim_lease then
    raise exception '[LEASE REUSE] database reused a previous lease identifier';
  end if;
  rejected := false;
  begin
    perform public.complete_amuhon_order_validation_job(attempt_success_id, first_claim_lease);
  exception when others then rejected := sqlerrm = 'VALIDATION_LEASE_STALE';
  end;
  if not rejected then raise exception '[STALE LEASE] old lease completed a reclaimed job'; end if;
  if not public.complete_amuhon_order_validation_job(attempt_success_id, reclaimed_lease) then
    raise exception '[COMPLETE] current lease did not complete';
  end if;
  rejected := false;
  begin
    perform public.complete_amuhon_order_validation_job(attempt_success_id, reclaimed_lease);
  exception when others then rejected := sqlerrm = 'VALIDATION_LEASE_STALE';
  end;
  if not rejected then raise exception '[DOUBLE COMPLETE] terminal job accepted a duplicate completion'; end if;
  if (public.enqueue_amuhon_order_validation_job(order_id, token_hash, attempt_success_id)->>'state') <> 'succeeded' then
    raise exception '[IDEMPOTENCY] enqueue did not preserve terminal success';
  end if;
  update public.amuhon_order_temp_upload_attempts set expires_at = clock_timestamp() - interval '1 second'
  where id = attempt_success_id;
  -- Transient failures may be retried while the immutable attempt remains
  -- active. Deterministic invalid-file failures are terminal.
  perform public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, upload_lease_id, attempt_retry_id);
  perform public.enqueue_amuhon_order_validation_job(order_id, token_hash, attempt_retry_id);
  job_result := public.claim_amuhon_order_validation_job(300);
  if job_result->>'attemptId' <> attempt_retry_id::text then raise exception '[CLAIM] retry fixture was not claimed'; end if;
  first_retry_lease := (job_result->>'leaseId')::uuid;
  if first_retry_lease is null then raise exception '[CLAIM] retry fixture did not receive a generated lease'; end if;
  if not public.fail_amuhon_order_validation_job(attempt_retry_id, first_retry_lease, 'worker_unavailable') then
    raise exception '[FAILURE] current lease did not record safe failure';
  end if;
  if not public.retry_amuhon_order_validation_job(attempt_retry_id) then raise exception '[RETRY] transient job retry failed'; end if;
  job_result := public.claim_amuhon_order_validation_job(300);
  if job_result->>'attemptId' <> attempt_retry_id::text or (job_result->>'attemptCount')::integer <> 2 then
    raise exception '[RETRY] retried job was not reclaimed';
  end if;
  retry_claim_lease := (job_result->>'leaseId')::uuid;
  if retry_claim_lease is null or retry_claim_lease = first_retry_lease then
    raise exception '[LEASE REUSE] retry claim reused a prior lease identifier';
  end if;
  if not public.fail_amuhon_order_validation_job(attempt_retry_id, retry_claim_lease, 'invalid_pdf') then
    raise exception '[FAILURE] deterministic failure was not recorded';
  end if;
  rejected := false;
  begin
    perform public.retry_amuhon_order_validation_job(attempt_retry_id);
  exception when others then rejected := sqlerrm = 'VALIDATION_JOB_NOT_RETRYABLE';
  end;
  if not rejected then raise exception '[RETRY POLICY] invalid PDF was incorrectly retryable'; end if;

  if (select status from public.amuhon_orders where id = order_id) <> 'preparing' or
     (select files_validated_at from public.amuhon_orders where id = order_id) is not null or
     (select body_pdf_storage_path from public.amuhon_orders where id = order_id) is not null or
     (select cover_png_storage_path from public.amuhon_orders where id = order_id) is not null then
    raise exception '[ORDER ISOLATION] job management changed order payment/final-file state';
  end if;
end
$validation_job_tests$;
select 'ALL TESTS PASSED' as result;
rollback;
