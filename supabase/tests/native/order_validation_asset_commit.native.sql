-- Native PostgreSQL-only asset-commit test. Synthetic rows only.
-- No Storage I/O, cleanup RPC, global claim, or deletion is permitted.
\set ON_ERROR_STOP on
begin isolation level read committed;
do $native_asset_commit_tests$
declare
  v_order_id uuid := pg_catalog.gen_random_uuid();
  idem_key uuid := pg_catalog.gen_random_uuid();
  upload_lease uuid := pg_catalog.gen_random_uuid();
  v_attempt_id uuid := pg_catalog.gen_random_uuid();
  v_validation_lease uuid := pg_catalog.gen_random_uuid();
  mismatch_order uuid := pg_catalog.gen_random_uuid();
  mismatch_attempt uuid := pg_catalog.gen_random_uuid();
  mismatch_lease uuid := pg_catalog.gen_random_uuid();
  expired_order uuid := pg_catalog.gen_random_uuid();
  expired_attempt uuid := pg_catalog.gen_random_uuid();
  expired_upload_lease uuid := pg_catalog.gen_random_uuid();
  expired_worker_lease uuid := pg_catalog.gen_random_uuid();
  v_token_hash text := repeat('a', 64);
  v_body_hash text := repeat('b', 64);
  v_cover_hash text := repeat('c', 64);
  v_body_path text;
  v_cover_path text;
  v_result jsonb;
  v_rejected boolean;
  v_proc regprocedure;
begin
  if current_database() is distinct from 'amuhon_validation_native' or
     current_user is distinct from 'postgres' or
     inet_server_addr() is distinct from inet '127.0.0.1' or
     inet_client_addr() is distinct from inet '127.0.0.1' or
     inet_server_port() is distinct from 55432 or
     current_setting('cluster_name') is distinct from 'amuhon-native-order-validation-v1' or
     current_setting('application_name') is distinct from 'amuhon-native-order-validation' or
     current_setting('app.amuhon_native_test_environment', true) is distinct from 'amuhon-native-pg-isolated-v1' or
     current_setting('app.amuhon_native_system_identifier', true) is distinct from
       (select system_identifier::text from pg_catalog.pg_control_system()) then
    raise exception 'STOP: native asset-commit identity guard failed';
  end if;
  if pg_catalog.to_regprocedure('public.commit_amuhon_order_validation_assets(uuid,uuid,uuid,integer,text,text,text,text,integer,integer)') is null or
     pg_catalog.to_regprocedure('public.get_amuhon_order_validation_asset_commit_status(uuid)') is null then
    raise exception '[SCHEMA] asset-commit migration is missing';
  end if;

  for v_proc in select unnest(array[
    'public.commit_amuhon_order_validation_assets(uuid,uuid,uuid,integer,text,text,text,text,integer,integer)'::regprocedure,
    'public.get_amuhon_order_validation_asset_commit_status(uuid)'::regprocedure,
    'public.complete_amuhon_order_validation_job(uuid,uuid)'::regprocedure
  ]) loop
    if exists (
      select 1 from pg_catalog.pg_proc p
      where p.oid = v_proc and (
        not p.prosecdef or pg_catalog.pg_get_userbyid(p.proowner) <> 'postgres' or
        not (coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, pg_temp']) or
        has_function_privilege('anon', p.oid, 'EXECUTE') or
        has_function_privilege('authenticated', p.oid, 'EXECUTE') or
        not has_function_privilege('service_role', p.oid, 'EXECUTE') or
        exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
                where acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
      )
    ) then raise exception '[RPC SECURITY] owner, SECURITY DEFINER, search_path, or grants incorrect for %', v_proc; end if;
  end loop;

  v_body_path := v_order_id::text || '/' || v_attempt_id::text || '/body.pdf';
  v_cover_path := v_order_id::text || '/' || v_attempt_id::text || '/cover.png';
  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot, declared_body_pdf_page_count,
    upload_token_hash, upload_lease_id, upload_lease_expires_at
  ) values (
    v_order_id, idem_key, 'preparing', '{}'::jsonb, '{}'::jsonb, 24, v_token_hash,
    upload_lease, clock_timestamp() + interval '2 hours'
  );
  insert into public.amuhon_order_temp_upload_attempts
    (id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at)
  values (
    v_attempt_id, v_order_id, upload_lease, v_body_path, v_cover_path, 'issued', clock_timestamp() + interval '1 hour'
  );
  insert into public.amuhon_order_validation_jobs (attempt_id, state, lease_id, lease_expires_at, attempt_count)
  values (v_attempt_id, 'validating', v_validation_lease, clock_timestamp() + interval '30 minutes', 1);

  v_rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(v_order_id, v_attempt_id, pg_catalog.gen_random_uuid(),
      24, v_body_path, v_cover_path, v_body_hash, v_cover_hash, 3000000, 1000000);
  exception when others then v_rejected := sqlerrm = 'VALIDATION_LEASE_STALE'; end;
  if not v_rejected then raise exception '[LEASE] non-current validation lease was accepted'; end if;
  v_rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(v_order_id, v_attempt_id, v_validation_lease,
      23, v_body_path, v_cover_path, v_body_hash, v_cover_hash, 3000000, 1000000);
  exception when others then v_rejected := sqlerrm = 'VALIDATED_PAGE_COUNT_INVALID'; end;
  if not v_rejected then raise exception '[PAGE COUNT] invalid page count was accepted'; end if;
  v_rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(v_order_id, v_attempt_id, v_validation_lease,
      24, v_body_path, v_cover_path, upper(v_body_hash), v_cover_hash, 3000000, 1000000);
  exception when others then v_rejected := sqlerrm = 'VALIDATED_ASSET_HASH_INVALID'; end;
  if not v_rejected then raise exception '[HASH] non-lowercase SHA-256 was accepted'; end if;
  v_rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(v_order_id, v_attempt_id, v_validation_lease,
      24, v_body_path, v_cover_path, v_body_hash, v_cover_hash, 40000001, 1000000);
  exception when others then v_rejected := sqlerrm = 'VALIDATED_ASSET_SIZE_INVALID'; end;
  if not v_rejected then raise exception '[SIZE] oversized asset was accepted'; end if;

  v_result := public.commit_amuhon_order_validation_assets(v_order_id, v_attempt_id, v_validation_lease,
    24, v_body_path, v_cover_path, v_body_hash, v_cover_hash, 3000000, 1000000);
  if v_result is null or jsonb_typeof(v_result) is distinct from 'object' or
     v_result->>'state' is distinct from 'committed' or
     v_result->>'bodyPdfPageCount' is distinct from '24' then
    raise exception '[COMMIT] successful atomic commit response is incorrect';
  end if;
  if (select j.state from public.amuhon_order_validation_jobs as j where j.attempt_id = v_attempt_id) is distinct from 'succeeded' then
    raise exception '[ATOMIC STATE] job did not become succeeded';
  end if;
  if not exists (select 1 from public.amuhon_orders as o where o.id = v_order_id and o.files_validated_at is not null and o.body_pdf_page_count = 24) or
     not exists (select 1 from public.amuhon_order_temp_upload_attempts as a where a.id = v_attempt_id and a.order_id = v_order_id) or
     not exists (select 1 from public.amuhon_order_validation_jobs as j where j.attempt_id = v_attempt_id and j.state = 'succeeded') then
    raise exception '[COMMIT ROWS] committed order, attempt, or succeeded job row is missing or inconsistent';
  end if;
  if (select o.status from public.amuhon_orders as o where o.id = v_order_id) is distinct from 'preparing' or
     (select o.amount_minor from public.amuhon_orders as o where o.id = v_order_id) is not null or
     (select o.shipping_minor from public.amuhon_orders as o where o.id = v_order_id) is not null or
     (select o.currency from public.amuhon_orders as o where o.id = v_order_id) is not null or
     (select o.stripe_payment_id from public.amuhon_orders as o where o.id = v_order_id) is not null then
    raise exception '[ORDER STATE] commit changed order status or payment fields';
  end if;
  v_result := public.get_amuhon_order_validation_asset_commit_status(v_attempt_id);
  if v_result is null or jsonb_typeof(v_result) is distinct from 'object' or
     v_result->>'state' is distinct from 'committed' or
     v_result->>'bodyPdfPageCount' is distinct from '24' or
     v_result->>'bodyPdfSha256' is distinct from v_body_hash or
     v_result->>'coverPngSha256' is distinct from v_cover_hash then
    raise exception '[STATUS] committed metadata is not returned';
  end if;
  v_rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(v_order_id, v_attempt_id, v_validation_lease,
      24, v_body_path, v_cover_path, repeat('d', 64), v_cover_hash, 3000000, 1000000);
  exception when others then v_rejected := sqlerrm = 'ORDER_FILES_ALREADY_FINALIZED'; end;
  if not v_rejected or (select o.body_pdf_sha256 from public.amuhon_orders as o where o.id = v_order_id) is distinct from v_body_hash then
    raise exception '[IDEMPOTENCY] duplicate commit overwrote verified metadata';
  end if;
  v_rejected := false;
  begin
    perform public.complete_amuhon_order_validation_job(v_attempt_id, v_validation_lease);
  exception when others then v_rejected := sqlerrm = 'ATOMIC_ASSET_FINALIZATION_REQUIRED'; end;
  if not v_rejected then raise exception '[COMPLETE GUARD] standalone completion bypassed atomic commit'; end if;

  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot, declared_body_pdf_page_count,
    upload_token_hash, upload_lease_id, upload_lease_expires_at
  ) values (
    mismatch_order, pg_catalog.gen_random_uuid(), 'preparing', '{}'::jsonb, '{}'::jsonb, 32,
    v_token_hash, mismatch_lease, clock_timestamp() + interval '2 hours'
  );
  insert into public.amuhon_order_temp_upload_attempts
    (id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at)
  values (
    mismatch_attempt, mismatch_order, mismatch_lease,
    mismatch_order::text || '/' || mismatch_attempt::text || '/body.pdf',
    mismatch_order::text || '/' || mismatch_attempt::text || '/cover.png',
    'issued', clock_timestamp() + interval '1 hour'
  );
  insert into public.amuhon_order_validation_jobs (attempt_id, state, lease_id, lease_expires_at, attempt_count)
  values (mismatch_attempt, 'validating', pg_catalog.gen_random_uuid(), clock_timestamp() + interval '30 minutes', 1);
  v_rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(mismatch_order, mismatch_attempt,
      (select lease_id from public.amuhon_order_validation_jobs where attempt_id = mismatch_attempt),
      24, mismatch_order::text || '/' || mismatch_attempt::text || '/body.pdf',
      mismatch_order::text || '/' || mismatch_attempt::text || '/cover.png', v_body_hash, v_cover_hash, 1000, 1000);
  exception when others then v_rejected := sqlerrm = 'DECLARED_PAGE_COUNT_MISMATCH'; end;
  if not v_rejected then raise exception '[DECLARED COUNT] mismatched declared page count was accepted'; end if;
  if not exists (select 1 from public.amuhon_orders as o where o.id = mismatch_order and o.files_validated_at is null) or
     not exists (select 1 from public.amuhon_order_temp_upload_attempts as a where a.id = mismatch_attempt and a.order_id = mismatch_order) or
     not exists (select 1 from public.amuhon_order_validation_jobs as j where j.attempt_id = mismatch_attempt and j.state = 'validating') then
    raise exception '[DECLARED COUNT ROWS] rejection changed or lost synthetic rows';
  end if;

  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot, declared_body_pdf_page_count,
    upload_token_hash, upload_lease_id, upload_lease_expires_at
  ) values (
    expired_order, pg_catalog.gen_random_uuid(), 'preparing', '{}'::jsonb, '{}'::jsonb, 24,
    v_token_hash, expired_upload_lease, clock_timestamp() + interval '2 hours'
  );
  insert into public.amuhon_order_temp_upload_attempts
    (id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at)
  values (
    expired_attempt, expired_order, expired_upload_lease,
    expired_order::text || '/' || expired_attempt::text || '/body.pdf',
    expired_order::text || '/' || expired_attempt::text || '/cover.png',
    'issued', clock_timestamp() + interval '1 hour'
  );
  insert into public.amuhon_order_validation_jobs (attempt_id, state, lease_id, lease_expires_at, attempt_count)
  values (expired_attempt, 'validating', expired_worker_lease, clock_timestamp() - interval '1 second', 1);
  v_rejected := false;
  begin
    perform public.commit_amuhon_order_validation_assets(expired_order, expired_attempt, expired_worker_lease,
      24, expired_order::text || '/' || expired_attempt::text || '/body.pdf',
      expired_order::text || '/' || expired_attempt::text || '/cover.png', v_body_hash, v_cover_hash, 1000, 1000);
  exception when others then v_rejected := sqlerrm = 'VALIDATION_LEASE_STALE'; end;
  if not v_rejected or
     not exists (select 1 from public.amuhon_orders as o where o.id = expired_order) or
     not exists (select 1 from public.amuhon_order_temp_upload_attempts as a where a.id = expired_attempt and a.order_id = expired_order) or
     not exists (select 1 from public.amuhon_order_validation_jobs as j where j.attempt_id = expired_attempt and j.state = 'validating') or
     (select o.files_validated_at from public.amuhon_orders as o where o.id = expired_order) is not null then
    raise exception '[EXPIRED LEASE] expired lease committed synthetic asset metadata';
  end if;
end;
$native_asset_commit_tests$;
select 'ALL NATIVE ASSET COMMIT TESTS PASSED' as result;
rollback;
