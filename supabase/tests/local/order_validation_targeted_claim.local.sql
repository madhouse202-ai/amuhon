-- Local-only targeted-claim integration test. Synthetic rows only; no global claim, Storage, or cleanup RPC.
-- Independent of the staging test and always ends with ROLLBACK.
begin isolation level read committed;
do $targeted_claim_tests$
<<test_block>>
declare
  confirmed_project constant text := 'amuhon-local-isolated-v1';
  order_primary uuid := gen_random_uuid();
  order_null_declared uuid := gen_random_uuid();
  order_expired uuid := gen_random_uuid();
  order_max_attempts uuid := gen_random_uuid();
  order_expired_upload_lease uuid := gen_random_uuid();
  order_mismatched_upload_lease uuid := gen_random_uuid();
  order_wrong_state uuid := gen_random_uuid();
  order_finalized uuid := gen_random_uuid();
  order_ids uuid[];
  attempt_primary uuid := gen_random_uuid();
  attempt_null_declared uuid := gen_random_uuid();
  attempt_expired uuid := gen_random_uuid();
  attempt_max_attempts uuid := gen_random_uuid();
  attempt_expired_upload_lease uuid := gen_random_uuid();
  attempt_mismatched_upload_lease uuid := gen_random_uuid();
  attempt_wrong_state uuid := gen_random_uuid();
  attempt_finalized uuid := gen_random_uuid();
  attempt_ids uuid[];
  lease_upload uuid := gen_random_uuid();
  lease_mismatch uuid := gen_random_uuid();
  job_result jsonb;
  initial_lease uuid;
  reissued_lease uuid;
  proc regprocedure;
begin
  if confirmed_project <> 'amuhon-local-isolated-v1' then raise exception 'STOP: local sentinel mismatch'; end if;
  if current_database() is distinct from 'postgres' then raise exception 'STOP: unexpected database'; end if;
  if current_user is distinct from 'postgres' then raise exception 'STOP: unexpected execution role'; end if;
  if inet_server_addr() is null or inet_client_addr() is null or inet_server_port() is distinct from 5432 then
    raise exception 'STOP: TCP connection does not match local Supabase database service';
  end if;
  if current_setting('application_name') is distinct from 'amuhon-local-order-validation' or
     current_setting('app.amuhon_test_environment', true) is distinct from 'amuhon-local-isolated-v1' then
    raise exception 'STOP: local runner identity is missing';
  end if;
  if to_regprocedure('public.claim_amuhon_order_validation_job_for_attempt(uuid,uuid,integer)') is null then
    raise exception '[SCHEMA] apply targeted-claim migration first';
  end if;

  order_ids := array[order_primary, order_null_declared, order_expired, order_max_attempts, order_expired_upload_lease,
    order_mismatched_upload_lease, order_wrong_state, order_finalized];
  attempt_ids := array[attempt_primary, attempt_null_declared, attempt_expired, attempt_max_attempts, attempt_expired_upload_lease,
    attempt_mismatched_upload_lease, attempt_wrong_state, attempt_finalized];
  if exists (select 1 from public.amuhon_orders where id = any(order_ids)) or
     exists (select 1 from public.amuhon_order_temp_upload_attempts where id = any(attempt_ids)) or
     exists (select 1 from public.amuhon_order_validation_jobs where attempt_id = any(attempt_ids)) then
    raise exception '[FIXTURE COLLISION] generated synthetic identifiers already exist';
  end if;

  for proc in select unnest(array[
    'public.claim_amuhon_order_validation_job_for_attempt(uuid,uuid,integer)'::regprocedure
  ]) loop
    if exists (
      select 1 from pg_proc as p
      where p.oid = proc and (
        not p.prosecdef or pg_get_userbyid(p.proowner) <> 'postgres' or
        not (coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, pg_temp']) or
        has_function_privilege('anon', p.oid, 'EXECUTE') or
        has_function_privilege('authenticated', p.oid, 'EXECUTE') or
        not has_function_privilege('service_role', p.oid, 'EXECUTE') or
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                where acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
      )
    ) then raise exception '[RPC SECURITY] owner, search_path, SECURITY DEFINER, or grants incorrect for %', proc; end if;
  end loop;

  -- Direct synthetic fixtures avoid enqueue/register RPCs and their global rate-limit pruning.
  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, upload_token_hash, upload_lease_id, upload_lease_expires_at
  ) values
    (order_primary, gen_random_uuid(), 'preparing', '{"name":"synthetic"}', '{"title":"synthetic","works":[]}', 24, repeat('a',64), lease_upload, clock_timestamp() + interval '1 hour'),
    (order_null_declared, gen_random_uuid(), 'preparing', '{"name":"synthetic"}', '{"title":"synthetic","works":[]}', null, repeat('b',64), lease_upload, clock_timestamp() + interval '1 hour'),
    (order_expired, gen_random_uuid(), 'preparing', '{"name":"synthetic"}', '{"title":"synthetic","works":[]}', 32, repeat('c',64), lease_upload, clock_timestamp() + interval '1 hour'),
    (order_max_attempts, gen_random_uuid(), 'preparing', '{"name":"synthetic"}', '{"title":"synthetic","works":[]}', 40, repeat('d',64), lease_upload, clock_timestamp() + interval '1 hour'),
    (order_expired_upload_lease, gen_random_uuid(), 'preparing', '{"name":"synthetic"}', '{"title":"synthetic","works":[]}', 48, repeat('e',64), lease_upload, clock_timestamp() - interval '1 second');

  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, upload_token_hash, upload_lease_id, upload_lease_expires_at
  ) values
    (order_mismatched_upload_lease, gen_random_uuid(), 'preparing', '{"name":"synthetic"}', '{"title":"synthetic","works":[]}', 56, repeat('f',64), lease_mismatch, clock_timestamp() + interval '1 hour'),
    (order_wrong_state, gen_random_uuid(), 'failed', '{"name":"synthetic"}', '{"title":"synthetic","works":[]}', 64, repeat('1',64), lease_upload, clock_timestamp() + interval '1 hour');

  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, upload_token_hash, upload_lease_id, upload_lease_expires_at,
    body_pdf_page_count, body_pdf_storage_path, cover_png_storage_path, files_validated_at
  ) values (
    order_finalized, gen_random_uuid(), 'preparing', '{"name":"synthetic"}', '{"title":"synthetic","works":[]}',
    72, repeat('2',64), lease_upload, clock_timestamp() + interval '1 hour', 72,
    order_finalized::text || '/legacy/body.pdf', order_finalized::text || '/legacy/cover.png', clock_timestamp()
  );

  insert into public.amuhon_order_temp_upload_attempts (
    id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at
  ) values
    (attempt_primary, order_primary, lease_upload, order_primary::text || '/' || attempt_primary::text || '/body.pdf', order_primary::text || '/' || attempt_primary::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_null_declared, order_null_declared, lease_upload, order_null_declared::text || '/' || attempt_null_declared::text || '/body.pdf', order_null_declared::text || '/' || attempt_null_declared::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_expired, order_expired, lease_upload, order_expired::text || '/' || attempt_expired::text || '/body.pdf', order_expired::text || '/' || attempt_expired::text || '/cover.png', 'issued', clock_timestamp() - interval '1 second'),
    (attempt_max_attempts, order_max_attempts, lease_upload, order_max_attempts::text || '/' || attempt_max_attempts::text || '/body.pdf', order_max_attempts::text || '/' || attempt_max_attempts::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_expired_upload_lease, order_expired_upload_lease, lease_upload, order_expired_upload_lease::text || '/' || attempt_expired_upload_lease::text || '/body.pdf', order_expired_upload_lease::text || '/' || attempt_expired_upload_lease::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_mismatched_upload_lease, order_mismatched_upload_lease, lease_upload, order_mismatched_upload_lease::text || '/' || attempt_mismatched_upload_lease::text || '/body.pdf', order_mismatched_upload_lease::text || '/' || attempt_mismatched_upload_lease::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_wrong_state, order_wrong_state, lease_upload, order_wrong_state::text || '/' || attempt_wrong_state::text || '/body.pdf', order_wrong_state::text || '/' || attempt_wrong_state::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_finalized, order_finalized, lease_upload, order_finalized::text || '/' || attempt_finalized::text || '/body.pdf', order_finalized::text || '/' || attempt_finalized::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour');

  insert into public.amuhon_order_validation_jobs (attempt_id, state, attempt_count)
  values
    (attempt_primary, 'queued', 0),
    (attempt_null_declared, 'queued', 0),
    (attempt_expired, 'queued', 0),
    (attempt_max_attempts, 'queued', 5),
    (attempt_expired_upload_lease, 'queued', 0),
    (attempt_mismatched_upload_lease, 'queued', 0),
    (attempt_wrong_state, 'queued', 0),
    (attempt_finalized, 'queued', 0);

  -- Exact target claim returns only the requested job and the declared page count.
  job_result := public.claim_amuhon_order_validation_job_for_attempt(order_primary, attempt_primary, 300);
  if job_result is null or job_result->>'attemptId' <> attempt_primary::text or
     job_result->>'orderId' <> order_primary::text or job_result->>'state' <> 'validating' or
     (job_result->>'attemptCount')::integer <> 1 or (job_result->>'declaredPageCount')::integer <> 24 or
     job_result->>'leaseId' is null then
    raise exception '[TARGET CLAIM] requested synthetic job or declared count was not returned';
  end if;
  initial_lease := (job_result->>'leaseId')::uuid;

  -- Same target cannot be claimed twice; an unrelated queued job is not a fallback.
  if public.claim_amuhon_order_validation_job_for_attempt(order_primary, attempt_primary, 300) is not null then
    raise exception '[DOUBLE CLAIM] active lease was claimed twice';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(gen_random_uuid(), attempt_null_declared, 300) is not null then
    raise exception '[TARGET SCOPE] mismatched order unexpectedly claimed an attempt';
  end if;
  if (select state from public.amuhon_order_validation_jobs where attempt_id = attempt_null_declared) <> 'queued' then
    raise exception '[NO FALLBACK] unrelated queued job was changed';
  end if;

  -- The target's declared NULL is returned as explicit JSON null, not omitted.
  job_result := public.claim_amuhon_order_validation_job_for_attempt(order_null_declared, attempt_null_declared, 300);
  if job_result is null or not (job_result ? 'declaredPageCount') or
     jsonb_typeof(job_result->'declaredPageCount') <> 'null' then
    raise exception '[JSON NULL] nullable declaration was not returned as explicit JSON null';
  end if;

  -- Expired attempt and exhausted attempt count are not claimed and become terminal failures.
  if public.claim_amuhon_order_validation_job_for_attempt(order_expired, attempt_expired, 300) is not null or
     (select state from public.amuhon_order_validation_jobs where attempt_id = attempt_expired) <> 'failed' or
     (select error_code from public.amuhon_order_validation_jobs where attempt_id = attempt_expired) <> 'attempt_expired' then
    raise exception '[ATTEMPT EXPIRY] expired attempt was not rejected safely';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(order_max_attempts, attempt_max_attempts, 300) is not null or
     (select state from public.amuhon_order_validation_jobs where attempt_id = attempt_max_attempts) <> 'failed' or
     (select error_code from public.amuhon_order_validation_jobs where attempt_id = attempt_max_attempts) <> 'processing_timeout' then
    raise exception '[ATTEMPT LIMIT] exhausted job was not rejected safely';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(order_expired_upload_lease, attempt_expired_upload_lease, 300) is not null or
     (select state from public.amuhon_order_validation_jobs where attempt_id = attempt_expired_upload_lease) <> 'failed' or
     (select error_code from public.amuhon_order_validation_jobs where attempt_id = attempt_expired_upload_lease) <> 'attempt_expired' then
    raise exception '[UPLOAD LEASE] inactive order upload lease was not rejected safely';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(order_mismatched_upload_lease, attempt_mismatched_upload_lease, 300) is not null or
     (select state from public.amuhon_order_validation_jobs where attempt_id = attempt_mismatched_upload_lease) <> 'failed' or
     (select error_code from public.amuhon_order_validation_jobs where attempt_id = attempt_mismatched_upload_lease) <> 'attempt_expired' then
    raise exception '[UPLOAD LEASE MISMATCH] mismatched order/attempt lease was not rejected safely';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(order_wrong_state, attempt_wrong_state, 300) is not null or
     (select state from public.amuhon_order_validation_jobs where attempt_id = attempt_wrong_state) <> 'failed' or
     (select error_code from public.amuhon_order_validation_jobs where attempt_id = attempt_wrong_state) <> 'attempt_expired' then
    raise exception '[ORDER STATE] non-preparing order was not rejected safely';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(order_finalized, attempt_finalized, 300) is not null or
     (select state from public.amuhon_order_validation_jobs where attempt_id = attempt_finalized) <> 'failed' or
     (select error_code from public.amuhon_order_validation_jobs where attempt_id = attempt_finalized) <> 'attempt_expired' then
    raise exception '[ORDER FINALIZED] already-finalized order was not rejected safely';
  end if;

  -- Expired validation lease can be reclaimed with a new database-generated lease ID.
  update public.amuhon_order_validation_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
  where attempt_id = attempt_primary;
  job_result := public.claim_amuhon_order_validation_job_for_attempt(order_primary, attempt_primary, 300);
  if job_result is null or (job_result->>'attemptCount')::integer <> 2 or job_result->>'leaseId' is null then
    raise exception '[LEASE RECLAIM] expired target job was not reclaimed';
  end if;
  reissued_lease := (job_result->>'leaseId')::uuid;
  if reissued_lease = initial_lease then raise exception '[LEASE REUSE] claim reused a prior lease'; end if;

  raise notice 'ALL TARGETED CLAIM TESTS PASSED';
end;
$targeted_claim_tests$;
rollback;
