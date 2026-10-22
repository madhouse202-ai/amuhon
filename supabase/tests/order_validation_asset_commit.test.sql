-- Run manually only in an isolated staging maintenance window after reviewing
-- 20261022000100_order_validation_asset_commit.sql. This test uses synthetic
-- UUIDs, performs no Storage I/O, calls no global claim/rate-limit cleanup RPC,
-- and rolls back all database changes.
-- SQL Editor does not reliably expose a project-ref setting. Confirm the
-- Dashboard project is amuhon-staging, then replace the sentinel below with
-- exactly 'amuhon-staging' before execution. The sentinel intentionally stops.
begin isolation level read committed;
do $asset_commit_tests$
<<test_block>>
declare
  confirmed_project constant text := 'CHANGE_THIS_TO_CONFIRM_amuhon-staging';
  order_id uuid := gen_random_uuid();
  idem_key uuid := gen_random_uuid();
  upload_lease_id uuid := gen_random_uuid();
  attempt_id uuid := gen_random_uuid();
  validation_lease_id uuid := gen_random_uuid();
  stale_order_id uuid := gen_random_uuid();
  stale_idem_key uuid := gen_random_uuid();
  stale_upload_lease uuid := gen_random_uuid();
  stale_attempt_id uuid := gen_random_uuid();
  stale_worker_lease uuid := gen_random_uuid();
  current_worker_lease uuid := gen_random_uuid();
  missing_job_attempt_id uuid := gen_random_uuid();
  other_order_id uuid := gen_random_uuid();
  other_idem_key uuid := gen_random_uuid();
  other_upload_lease uuid := gen_random_uuid();
  other_attempt_id uuid := gen_random_uuid();
  other_validation_lease uuid := gen_random_uuid();
  cleanup_lease_id uuid := gen_random_uuid();
  token_hash text := repeat('a', 64);
  body_hash text := repeat('b', 64);
  cover_hash text := repeat('c', 64);
  body_path text;
  cover_path text;
  result jsonb;
  rejected boolean;
  proc regprocedure;
  target_table regclass;
begin
  if confirmed_project <> 'amuhon-staging' then raise exception 'STOP: wrong Supabase project'; end if;
  if current_user <> 'postgres' then raise exception 'STOP: run as postgres in the intended staging SQL Editor'; end if;
  if to_regprocedure('public.commit_amuhon_order_validation_assets(uuid,uuid,uuid,integer,text,text,text,text,integer,integer)') is null or
     to_regprocedure('public.get_amuhon_order_validation_asset_commit_status(uuid)') is null or
     to_regprocedure('public.claim_amuhon_order_temp_upload_attempt_cleanup(uuid,uuid)') is null then
    raise exception '[SCHEMA] apply and review the asset commit migration first';
  end if;
  if exists (
    select 1 from public.amuhon_orders where id in (order_id, stale_order_id, other_order_id)
       or idempotency_key in (idem_key, stale_idem_key, other_idem_key)
  ) or exists (
    select 1 from public.amuhon_order_temp_upload_attempts where id in (attempt_id, stale_attempt_id, missing_job_attempt_id, other_attempt_id)
  ) or exists (
    select 1 from public.amuhon_order_validation_jobs as jobs
    where jobs.attempt_id in (test_block.attempt_id, test_block.stale_attempt_id, test_block.missing_job_attempt_id, test_block.other_attempt_id)
       or jobs.lease_id in (validation_lease_id, stale_worker_lease, current_worker_lease,
         other_validation_lease)
  ) then
    raise exception 'STOP: generated test identifier collision';
  end if;

  for target_table in select unnest(array[
    'public.amuhon_orders'::regclass,
    'public.amuhon_order_temp_upload_attempts'::regclass,
    'public.amuhon_order_validation_jobs'::regclass
  ]) loop
    if not (select relrowsecurity from pg_class where oid = target_table) or
       has_table_privilege('anon', target_table, 'SELECT') or
       has_table_privilege('anon', target_table, 'INSERT') or
       has_table_privilege('anon', target_table, 'UPDATE') or
       has_table_privilege('anon', target_table, 'DELETE') or
       has_table_privilege('authenticated', target_table, 'SELECT') or
       has_table_privilege('authenticated', target_table, 'INSERT') or
       has_table_privilege('authenticated', target_table, 'UPDATE') or
       has_table_privilege('authenticated', target_table, 'DELETE') or
       has_table_privilege('service_role', target_table, 'SELECT') or
       has_table_privilege('service_role', target_table, 'INSERT') or
       has_table_privilege('service_role', target_table, 'UPDATE') or
       has_table_privilege('service_role', target_table, 'DELETE') then
      raise exception '[TABLE SECURITY] grants or RLS are incorrect for %', target_table;
    end if;
  end loop;

  for proc in select unnest(array[
    'public.commit_amuhon_order_validation_assets(uuid,uuid,uuid,integer,text,text,text,text,integer,integer)'::regprocedure,
    'public.get_amuhon_order_validation_asset_commit_status(uuid)'::regprocedure,
    'public.complete_amuhon_order_validation_job(uuid,uuid)'::regprocedure,
    'public.claim_amuhon_order_temp_upload_attempt_cleanup(uuid,uuid)'::regprocedure
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
  proc := 'public.amuhon_order_temp_upload_attempt_cleanup_eligible(uuid)'::regprocedure;
  if has_function_privilege('anon', proc, 'EXECUTE') or
     has_function_privilege('authenticated', proc, 'EXECUTE') or
     has_function_privilege('service_role', proc, 'EXECUTE') or
     exists (
       select 1 from pg_proc as p
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
       where p.oid = proc and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
     ) then
    raise exception '[CLEANUP HELPER SECURITY] internal eligibility helper must not be directly executable';
  end if;

  body_path := order_id::text || '/' || attempt_id::text || '/body.pdf';
  cover_path := order_id::text || '/' || attempt_id::text || '/cover.png';
  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, upload_token_hash,
    upload_lease_id, upload_lease_expires_at
  ) values (
    order_id, idem_key, 'preparing', '{"name":"synthetic"}'::jsonb,
    '{"title":"synthetic","works":[]}'::jsonb, 24, token_hash,
    upload_lease_id, clock_timestamp() + interval '2 hours'
  );
  insert into public.amuhon_order_temp_upload_attempts (
    id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at
  ) values (
    attempt_id, order_id, upload_lease_id,
    order_id::text || '/' || attempt_id::text || '/body.pdf',
    order_id::text || '/' || attempt_id::text || '/cover.png',
    'issued', clock_timestamp() + interval '1 hour'
  );
  insert into public.amuhon_order_validation_jobs (attempt_id, state, lease_id, lease_expires_at, attempt_count)
  values (attempt_id, 'validating', validation_lease_id, clock_timestamp() + interval '30 minutes', 1);

  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(order_id, attempt_id, gen_random_uuid(),
      24, body_path, cover_path, body_hash, cover_hash, 1000, 1000);
  exception when others then rejected := sqlerrm = 'VALIDATION_LEASE_STALE'; end;
  if not rejected then raise exception '[LEASE ID] non-current validation lease was accepted'; end if;

  -- Reject malformed pages, keys, hashes, sizes, and declared-count mismatch.
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(order_id, attempt_id, validation_lease_id,
      23, body_path, cover_path, body_hash, cover_hash, 1000, 1000);
  exception when others then rejected := sqlerrm = 'VALIDATED_PAGE_COUNT_INVALID'; end;
  if not rejected then raise exception '[PAGE COUNT] invalid page count was accepted'; end if;
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(order_id, attempt_id, validation_lease_id,
      24, order_id::text || '/wrong/body.pdf', cover_path, body_hash, cover_hash, 1000, 1000);
  exception when others then rejected := sqlerrm = 'VALIDATED_ASSET_PATH_INVALID'; end;
  if not rejected then raise exception '[PATH] non-canonical final key was accepted'; end if;
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(order_id, attempt_id, validation_lease_id,
      24, body_path, cover_path, upper(body_hash), cover_hash, 1000, 1000);
  exception when others then rejected := sqlerrm = 'VALIDATED_ASSET_HASH_INVALID'; end;
  if not rejected then raise exception '[HASH] non-lowercase hash was accepted'; end if;
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(order_id, attempt_id, validation_lease_id,
      24, body_path, cover_path, body_hash, cover_hash, 40000001, 1000);
  exception when others then rejected := sqlerrm = 'VALIDATED_ASSET_SIZE_INVALID'; end;
  if not rejected then raise exception '[SIZE] oversized asset was accepted'; end if;

  -- Success atomically stores order metadata and terminal job state. No price,
  -- currency, Stripe, order status, or Storage object is changed by SQL.
  result := public.commit_amuhon_order_validation_assets(order_id, attempt_id, validation_lease_id,
    24, body_path, cover_path, body_hash, cover_hash, 3000000, 1000000);
  if result->>'state' <> 'committed' then raise exception '[COMMIT] successful commit result missing'; end if;
  if (select jobs.state from public.amuhon_order_validation_jobs as jobs where jobs.attempt_id = test_block.attempt_id) <> 'succeeded' or
     (select status from public.amuhon_orders where id = order_id) <> 'preparing' or
     (select amount_minor from public.amuhon_orders where id = order_id) is not null or
     (select currency from public.amuhon_orders where id = order_id) is not null or
     (select stripe_payment_id from public.amuhon_orders where id = order_id) is not null then
    raise exception '[ATOMIC COMMIT] job/order state or payment fields incorrect';
  end if;
  result := public.get_amuhon_order_validation_asset_commit_status(attempt_id);
  if result->>'state' <> 'committed' or result->>'bodyPdfPageCount' <> '24' then
    raise exception '[STATUS] committed outcome was not readable after commit';
  end if;

  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(order_id, attempt_id, validation_lease_id,
      24, body_path, cover_path, body_hash, cover_hash, 3000000, 1000000);
  exception when others then rejected := sqlerrm = 'ORDER_FILES_ALREADY_FINALIZED'; end;
  if not rejected then raise exception '[DOUBLE COMMIT] duplicate commit was not rejected'; end if;
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(order_id, attempt_id, validation_lease_id,
      24, body_path, cover_path, repeat('d', 64), cover_hash, 3000000, 1000000);
  exception when others then rejected := sqlerrm = 'ORDER_FILES_ALREADY_FINALIZED'; end;
  if not rejected or
     (select orders.body_pdf_sha256 from public.amuhon_orders as orders where orders.id = test_block.order_id) <> body_hash then
    raise exception '[HASH MISMATCH] a second commit overwrote the committed hash';
  end if;

  -- The legacy finalizer must not overwrite a committed attempt-specific key.
  rejected := false;
  begin
    perform public.finish_amuhon_order_asset_upload(order_id, token_hash, upload_lease_id,
      24, repeat('d', 64), cover_hash);
  exception when others then rejected := sqlerrm = 'ORDER_FILES_ALREADY_FINALIZED'; end;
  if not rejected or (select body_pdf_storage_path from public.amuhon_orders where id = order_id) <> body_path then
    raise exception '[LEGACY CONFLICT] old upload finalizer overwrote committed metadata';
  end if;

  -- Once the committed attempt expires, the scoped cleaner may claim it.
  update public.amuhon_order_temp_upload_attempts
    set expires_at = clock_timestamp() - interval '1 second' where id = attempt_id;
  result := public.claim_amuhon_order_temp_upload_attempt_cleanup(attempt_id, cleanup_lease_id);
  if result->>'attemptId' <> attempt_id::text then raise exception '[CLEANUP] committed expired attempt was not claimable'; end if;
  -- This only simulates a Storage deletion having succeeded. The SQL test does
  -- not access Storage; the synthetic DB state is rolled back below.
  if not public.finish_amuhon_order_temp_upload_cleanup(cleanup_lease_id, attempt_id, true) or
     (select attempts.state from public.amuhon_order_temp_upload_attempts as attempts
       where attempts.id = test_block.attempt_id) <> 'cleaned' then
    raise exception '[CLEANUP] successful post-commit cleanup state was not recorded';
  end if;

  -- In-flight validation never becomes cleanup eligible, including when the
  -- temporary attempt has expired. Construct this second fixture directly.
  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, upload_token_hash,
    upload_lease_id, upload_lease_expires_at
  ) values (
    stale_order_id, stale_idem_key, 'preparing', '{"name":"synthetic"}'::jsonb,
    '{"title":"synthetic","works":[]}'::jsonb, 24, token_hash,
    stale_upload_lease, clock_timestamp() + interval '2 hours'
  );
  insert into public.amuhon_order_temp_upload_attempts (
    id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at
  ) values (
    stale_attempt_id, stale_order_id, stale_upload_lease,
    stale_order_id::text || '/' || stale_attempt_id::text || '/body.pdf',
    stale_order_id::text || '/' || stale_attempt_id::text || '/cover.png',
    'issued', clock_timestamp() + interval '1 hour'
  );
  insert into public.amuhon_order_validation_jobs (attempt_id, state, lease_id, lease_expires_at, attempt_count)
  values (stale_attempt_id, 'validating', stale_worker_lease, clock_timestamp() - interval '1 second', 1);
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(stale_order_id, stale_attempt_id, stale_worker_lease,
      24, stale_order_id::text || '/' || stale_attempt_id::text || '/body.pdf',
      stale_order_id::text || '/' || stale_attempt_id::text || '/cover.png',
      body_hash, cover_hash, 1000, 1000);
  exception when others then rejected := sqlerrm = 'VALIDATION_LEASE_STALE'; end;
  if not rejected then raise exception '[EXPIRED LEASE] expired validation-worker lease was accepted'; end if;
  update public.amuhon_order_validation_jobs set
    lease_id = current_worker_lease,
    lease_expires_at = clock_timestamp() + interval '30 minutes'
  where attempt_id = stale_attempt_id;
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(stale_order_id, stale_attempt_id, stale_worker_lease,
      24, stale_order_id::text || '/' || stale_attempt_id::text || '/body.pdf',
      stale_order_id::text || '/' || stale_attempt_id::text || '/cover.png',
      body_hash, cover_hash, 1000, 1000);
  exception when others then rejected := sqlerrm = 'VALIDATION_LEASE_STALE'; end;
  if not rejected then raise exception '[STALE LEASE] old worker lease completed after synthetic reclaim'; end if;
  update public.amuhon_order_temp_upload_attempts
    set expires_at = clock_timestamp() - interval '1 second' where id = stale_attempt_id;
  if public.claim_amuhon_order_temp_upload_attempt_cleanup(stale_attempt_id, gen_random_uuid()) is not null then
    raise exception '[CLEANUP] uncommitted validating attempt was claimable';
  end if;
  insert into public.amuhon_order_temp_upload_attempts (
    id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at
  ) values (
    missing_job_attempt_id, stale_order_id, stale_upload_lease,
    stale_order_id::text || '/' || missing_job_attempt_id::text || '/body.pdf',
    stale_order_id::text || '/' || missing_job_attempt_id::text || '/cover.png',
    'issued', clock_timestamp() + interval '1 hour'
  );
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(stale_order_id, missing_job_attempt_id,
      gen_random_uuid(), 24,
      stale_order_id::text || '/' || missing_job_attempt_id::text || '/body.pdf',
      stale_order_id::text || '/' || missing_job_attempt_id::text || '/cover.png',
      body_hash, cover_hash, 1000, 1000);
  exception when others then rejected := sqlerrm = 'VALIDATION_JOB_NOT_FOUND'; end;
  if not rejected then raise exception '[JOB ASSOCIATION] attempt without a validation job was accepted'; end if;

  -- A mismatched order/attempt pair must be rejected before changing either.
  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, upload_token_hash,
    upload_lease_id, upload_lease_expires_at
  ) values (
    other_order_id, other_idem_key, 'preparing', '{"name":"synthetic"}'::jsonb,
    '{"title":"synthetic","works":[]}'::jsonb, 32, token_hash,
    other_upload_lease, clock_timestamp() + interval '2 hours'
  );
  insert into public.amuhon_order_temp_upload_attempts (
    id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at
  ) values (
    other_attempt_id, other_order_id, other_upload_lease,
    other_order_id::text || '/' || other_attempt_id::text || '/body.pdf',
    other_order_id::text || '/' || other_attempt_id::text || '/cover.png',
    'issued', clock_timestamp() + interval '1 hour'
  );
  insert into public.amuhon_order_validation_jobs (attempt_id, state, lease_id, lease_expires_at, attempt_count)
  values (other_attempt_id, 'validating', other_validation_lease, clock_timestamp() + interval '30 minutes', 1);
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(order_id, other_attempt_id, other_validation_lease,
      24, order_id::text || '/' || other_attempt_id::text || '/body.pdf',
      order_id::text || '/' || other_attempt_id::text || '/cover.png', body_hash, cover_hash, 1000, 1000);
  exception when others then rejected := sqlerrm = 'ORDER_ATTEMPT_MISMATCH'; end;
  if not rejected then raise exception '[ASSOCIATION] mismatched order and attempt were accepted'; end if;
  rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(other_order_id, other_attempt_id, other_validation_lease,
      24, other_order_id::text || '/' || other_attempt_id::text || '/body.pdf',
      other_order_id::text || '/' || other_attempt_id::text || '/cover.png', body_hash, cover_hash, 1000, 1000);
  exception when others then rejected := sqlerrm = 'DECLARED_PAGE_COUNT_MISMATCH'; end;
  if not rejected then raise exception '[DECLARED PAGES] mismatched declared page count was accepted'; end if;

  -- Standalone complete can no longer mark a job successful before asset commit.
  rejected := false;
  begin
    perform public.complete_amuhon_order_validation_job(other_attempt_id, other_validation_lease);
  exception when others then rejected := sqlerrm = 'ATOMIC_ASSET_FINALIZATION_REQUIRED'; end;
  if not rejected or (select jobs.state from public.amuhon_order_validation_jobs as jobs where jobs.attempt_id = other_attempt_id) <> 'validating' then
    raise exception '[COMPLETE GUARD] standalone completion changed a job';
  end if;
end
$asset_commit_tests$;
select 'ALL TESTS PASSED' as result;
rollback;
