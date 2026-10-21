-- Run manually only in the amuhon-staging SQL Editor after applying migrations
-- through 20261020000300_order_temp_uploads.sql. All writes are rolled back.
begin isolation level read committed;
do $temp_upload_tests$
<<test_block>>
declare
  confirmed_project constant text := 'amuhon-staging';
  order_id uuid := gen_random_uuid();
  idem_key uuid := gen_random_uuid();
  lease_id uuid := gen_random_uuid();
  attempt_id uuid := gen_random_uuid();
  cleanup_lease_id uuid := gen_random_uuid();
  fresh_attempt_id uuid := gen_random_uuid();
  claimed_attempt_ids uuid[];
  claimed_count bigint;
  rate_key text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  asset_rate_key text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  token_hash text := repeat('a', 64);
  wrong_hash text := repeat('b', 64);
  created jsonb;
  begun jsonb;
  registered jsonb;
  recovered jsonb;
  rejected boolean;
begin
  if confirmed_project <> 'amuhon-staging' then raise exception 'STOP: wrong Supabase project'; end if;
  if to_regclass('public.amuhon_order_temp_upload_attempts') is null or
     to_regprocedure('public.register_amuhon_order_temp_upload_attempt(uuid,text,uuid,uuid)') is null or
     to_regprocedure('public.get_amuhon_order_temp_upload_attempt(uuid,text,uuid)') is null or
     to_regprocedure('public.claim_expired_amuhon_order_temp_upload_attempts(uuid,integer)') is null or
     to_regprocedure('public.finish_amuhon_order_temp_upload_cleanup(uuid,uuid,boolean)') is null then
    raise exception '[SCHEMA] apply the temporary upload migration first';
  end if;

  -- The existing order-creation and upload-start RPCs prune old global rate
  -- rows. Stop rather than let this synthetic test touch existing records.
  if exists (select 1 from public.amuhon_order_rate_limits where updated_at < now() - interval '24 hours') or
     exists (select 1 from public.amuhon_order_asset_rate_limits where updated_at < now() - interval '24 hours') then
    raise exception 'STOP: existing stale rate-limit rows could be pruned by an RPC';
  end if;
  -- The cleanup RPC claims globally, not by order or test ID. Refuse to run
  -- its integration cases if any pre-existing attempt is currently eligible;
  -- otherwise the first claim could lease unrelated staging data. The check
  -- mirrors the RPC predicate and runs before this test creates any rows.
  if exists (
    select 1
    from public.amuhon_order_temp_upload_attempts as attempts
    where attempts.expires_at <= clock_timestamp() and (
      attempts.state in ('issued', 'cleanup_failed') or
      (attempts.state = 'cleaning' and attempts.cleanup_claimed_at <= clock_timestamp() - interval '10 minutes')
    )
  ) then
    raise exception 'STOP: existing expired temporary-upload attempts could be claimed by the global cleanup RPC';
  end if;
  if exists (select 1 from public.amuhon_orders where id = order_id or idempotency_key = idem_key) or
     exists (select 1 from public.amuhon_order_rate_limits where key_hash = rate_key) or
     exists (select 1 from public.amuhon_order_asset_rate_limits where key_hash = asset_rate_key) or
     exists (select 1 from public.amuhon_order_temp_upload_attempts where id = attempt_id) then
    raise exception 'STOP: generated test identifier collision';
  end if;

  if (select "public" from storage.buckets where id = 'amuhon-order-temp-files') is distinct from false or
     (select file_size_limit from storage.buckets where id = 'amuhon-order-temp-files') is distinct from 40000000 or
     (select allowed_mime_types from storage.buckets where id = 'amuhon-order-temp-files') is distinct from array['application/pdf','image/png']::text[] then
    raise exception '[BUCKET] temporary bucket is not private with the expected limits';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.amuhon_order_temp_upload_attempts'::regclass) or
     has_table_privilege('anon', 'public.amuhon_order_temp_upload_attempts', 'SELECT') or
     has_table_privilege('authenticated', 'public.amuhon_order_temp_upload_attempts', 'SELECT') or
     has_table_privilege('service_role', 'public.amuhon_order_temp_upload_attempts', 'SELECT') then
    raise exception '[TABLE SECURITY] temp attempt table grants or RLS are incorrect';
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'amuhon_order_temp_files_deny_public_access'
      and permissive = 'RESTRICTIVE' and cmd = 'ALL'
      and roles @> array['public']::name[] and qual like '%amuhon-order-temp-files%'
      and with_check like '%amuhon-order-temp-files%'
  ) or coalesce((select rolbypassrls from pg_roles where rolname = 'service_role'), false) is not true then
    raise exception '[STORAGE RLS] temporary bucket deny policy or service_role bypass is incorrect';
  end if;

  if exists (
    select 1 from pg_proc p where p.oid in (
      'public.register_amuhon_order_temp_upload_attempt(uuid,text,uuid,uuid)'::regprocedure,
      'public.get_amuhon_order_temp_upload_attempt(uuid,text,uuid)'::regprocedure,
      'public.claim_expired_amuhon_order_temp_upload_attempts(uuid,integer)'::regprocedure,
      'public.finish_amuhon_order_temp_upload_cleanup(uuid,uuid,boolean)'::regprocedure
    ) and (
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
  ) then raise exception '[RPC SECURITY] owner, search_path, SECURITY DEFINER, or grants are incorrect'; end if;

  created := public.create_amuhon_order_draft_with_upload_token(
    order_id, idem_key, '{"name":"synthetic"}'::jsonb,
    '{"title":"synthetic","works":[]}'::jsonb, 24, rate_key, token_hash, 1
  );
  if created->>'id' <> order_id::text or created->>'uploadTokenAccepted' <> 'true' then
    raise exception '[DRAFT] synthetic draft was not created';
  end if;
  begun := public.begin_amuhon_order_asset_upload(order_id, token_hash, asset_rate_key, lease_id);
  if begun->>'state' <> 'claimed' then raise exception '[LEASE] upload lease was not claimed'; end if;

  rejected := false;
  begin
    perform public.register_amuhon_order_temp_upload_attempt(order_id, wrong_hash, lease_id, attempt_id);
  exception when others then rejected := sqlerrm = 'UPLOAD_NOT_AUTHORIZED';
  end;
  if not rejected then raise exception '[AUTH] wrong token registered a temp upload'; end if;

  registered := public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, lease_id, attempt_id);
  if registered->>'attemptId' <> attempt_id::text or
     registered->>'bodyObjectKey' <> order_id::text || '/' || attempt_id::text || '/body.pdf' or
     registered->>'coverObjectKey' <> order_id::text || '/' || attempt_id::text || '/cover.png' or
     (registered->>'expiresAt')::timestamptz < now() + interval '25 hours' then
    raise exception '[KEYS] temp keys were not unique and deterministic';
  end if;
  recovered := public.get_amuhon_order_temp_upload_attempt(order_id, token_hash, attempt_id);
  if recovered->>'bodyObjectKey' <> registered->>'bodyObjectKey' or recovered->>'coverObjectKey' <> registered->>'coverObjectKey' then
    raise exception '[RETRY] authorized recovery did not return the original keys';
  end if;

  -- Re-registering a still-live attempt must keep its original immutable keys.
  registered := public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, lease_id, attempt_id);
  if registered->>'attemptId' <> attempt_id::text or
     registered->>'bodyObjectKey' <> order_id::text || '/' || attempt_id::text || '/body.pdf' then
    raise exception '[RETRY] live attempt was not safely reused';
  end if;
  if exists (
    select 1 from public.amuhon_order_temp_upload_attempts as attempts
    where attempts.id <> test_block.attempt_id and attempts.expires_at <= clock_timestamp() and (
      attempts.state in ('issued', 'cleanup_failed') or
      (attempts.state = 'cleaning' and attempts.cleanup_claimed_at <= clock_timestamp() - interval '10 minutes')
    )
  ) then
    raise exception 'STOP: another expired temporary-upload attempt appeared before the cleanup RPC test';
  end if;
  claimed_attempt_ids := null;
  select count(*), array_agg(attempts.attempt_id) into claimed_count, claimed_attempt_ids
  from public.claim_expired_amuhon_order_temp_upload_attempts(cleanup_lease_id, 1) as attempts;
  if claimed_count <> 0 then
    raise exception '[CLEANUP RACE] cleanup claimed a refreshed, unexpired attempt';
  end if;

  -- Simulate expiry, then claim cleanup. The committed `cleaning` state must
  -- win over a concurrent/replayed registration; register takes the same row
  -- lock and must force a new attempt ID while cleanup owns this old key.
  update public.amuhon_order_temp_upload_attempts as attempts
  set expires_at = clock_timestamp() - interval '1 second'
  where attempts.id = test_block.attempt_id and attempts.order_id = test_block.order_id;
  if exists (
    select 1 from public.amuhon_order_temp_upload_attempts as attempts
    where attempts.id <> test_block.attempt_id and attempts.expires_at <= clock_timestamp() and (
      attempts.state in ('issued', 'cleanup_failed') or
      (attempts.state = 'cleaning' and attempts.cleanup_claimed_at <= clock_timestamp() - interval '10 minutes')
    )
  ) then
    raise exception 'STOP: another expired temporary-upload attempt appeared before the cleanup RPC test';
  end if;
  select count(*), array_agg(attempts.attempt_id) into claimed_count, claimed_attempt_ids
  from public.claim_expired_amuhon_order_temp_upload_attempts(cleanup_lease_id, 1) as attempts;
  if claimed_count <> 1 or claimed_attempt_ids[1] is distinct from attempt_id then
    raise exception '[CLEANUP CLAIM] expired attempt was not claimed';
  end if;

  recovered := public.get_amuhon_order_temp_upload_attempt(order_id, token_hash, attempt_id);
  if recovered->>'leaseId' <> lease_id::text then
    raise exception '[LEASE RECOVERY] expired attempt did not return its original lease for recovery';
  end if;
  rejected := false;
  begin
    perform public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, lease_id, attempt_id);
  exception when others then rejected := sqlerrm = 'UPLOAD_ATTEMPT_NOT_REUSABLE';
  end;
  if not rejected or (select state from public.amuhon_order_temp_upload_attempts where id = attempt_id) <> 'cleaning' then
    raise exception '[CLEANUP RACE] claimed cleanup attempt was reusable';
  end if;

  if not public.finish_amuhon_order_temp_upload_cleanup(cleanup_lease_id, attempt_id, false) then
    raise exception '[CLEANUP FAILURE] cleanup failure was not recorded';
  end if;
  rejected := false;
  begin
    perform public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, lease_id, attempt_id);
  exception when others then rejected := sqlerrm = 'UPLOAD_ATTEMPT_NOT_REUSABLE';
  end;
  if not rejected or (select state from public.amuhon_order_temp_upload_attempts where id = attempt_id) <> 'cleanup_failed' then
    raise exception '[CLEANUP FAILED REUSE] possibly remaining Storage object key was reused';
  end if;

  -- A fresh ID gives cleanup/retry disjoint object paths; the failed-cleanup
  -- record remains available for the cleaner and is never overwritten.
  registered := public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, lease_id, fresh_attempt_id);
  if registered->>'attemptId' <> fresh_attempt_id::text or
     registered->>'bodyObjectKey' <> order_id::text || '/' || fresh_attempt_id::text || '/body.pdf' or
     registered->>'coverObjectKey' <> order_id::text || '/' || fresh_attempt_id::text || '/cover.png' then
    raise exception '[FRESH ATTEMPT] retry did not receive isolated object keys';
  end if;

  -- Safe idempotent draft recovery can clear the current upload lease. An
  -- authorized historical lookup must still return the old attempt so the API
  -- can reacquire a lease and either reuse a live issued key or rotate it.
  update public.amuhon_orders
  set upload_lease_id = null, upload_lease_expires_at = null
  where id = order_id;
  recovered := public.get_amuhon_order_temp_upload_attempt(order_id, token_hash, fresh_attempt_id);
  if recovered->>'attemptId' <> fresh_attempt_id::text then
    raise exception '[LEASE RECOVERY] cleared lease hid the authorized historical attempt';
  end if;
  begun := public.begin_amuhon_order_asset_upload(order_id, token_hash, asset_rate_key, lease_id);
  if begun->>'state' <> 'claimed' then raise exception '[LEASE RECOVERY] cleared lease was not reacquired'; end if;
  registered := public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, lease_id, fresh_attempt_id);
  if registered->>'attemptId' <> fresh_attempt_id::text then
    raise exception '[LEASE RECOVERY] live attempt could not be re-registered after lease recovery';
  end if;

  -- Simulate recovery at the edge of the lease window: the still-valid order
  -- lease is re-entered with its existing lease ID, then the attempt refresh
  -- restores the 27h order / 26h temp relationship.
  update public.amuhon_orders
  set upload_lease_expires_at = clock_timestamp() - interval '1 second'
  where id = order_id;
  begun := public.begin_amuhon_order_asset_upload(order_id, token_hash, asset_rate_key, lease_id);
  if begun->>'state' <> 'claimed' then raise exception '[LEASE RECOVERY] expired lease was not reclaimed'; end if;
  registered := public.register_amuhon_order_temp_upload_attempt(order_id, token_hash, lease_id, fresh_attempt_id);
  if (registered->>'expiresAt')::timestamptz < clock_timestamp() + interval '25 hours' or
     (select upload_lease_expires_at from public.amuhon_orders where id = order_id) < clock_timestamp() + interval '26 hours' then
    raise exception '[LEASE WINDOW] refreshed attempt and order lease are not aligned';
  end if;

  rejected := false;
  begin
    perform public.get_amuhon_order_temp_upload_attempt(order_id, wrong_hash, attempt_id);
  exception when others then rejected := sqlerrm = 'UPLOAD_NOT_AUTHORIZED';
  end;
  if not rejected then raise exception '[AUTH] wrong token recovered an attempt'; end if;
  if (select status from public.amuhon_orders where id = order_id) <> 'preparing' or
     (select files_validated_at from public.amuhon_orders where id = order_id) is not null or
     (select body_pdf_storage_path from public.amuhon_orders where id = order_id) is not null or
     (select cover_png_storage_path from public.amuhon_orders where id = order_id) is not null then
    raise exception '[STATE] upload intent incorrectly validated or finalized the order';
  end if;
end
$temp_upload_tests$;
select 'ALL TESTS PASSED' as result;
rollback;
