-- Native PostgreSQL-only integration test. Synthetic rows only.
-- No global claim, cleanup RPC, Storage access, or deletion is permitted.
\set ON_ERROR_STOP on
begin isolation level read committed;
do $native_targeted_claim_tests$
declare
  order_primary uuid := pg_catalog.gen_random_uuid();
  order_null_declared uuid := pg_catalog.gen_random_uuid();
  order_wrong_target uuid := pg_catalog.gen_random_uuid();
  order_expired_attempt uuid := pg_catalog.gen_random_uuid();
  order_expired_upload_lease uuid := pg_catalog.gen_random_uuid();
  order_max_attempts uuid := pg_catalog.gen_random_uuid();
  order_expired_job_lease uuid := pg_catalog.gen_random_uuid();
  attempt_primary uuid := pg_catalog.gen_random_uuid();
  attempt_null_declared uuid := pg_catalog.gen_random_uuid();
  attempt_wrong_target uuid := pg_catalog.gen_random_uuid();
  attempt_expired uuid := pg_catalog.gen_random_uuid();
  attempt_expired_upload uuid := pg_catalog.gen_random_uuid();
  attempt_max_attempts uuid := pg_catalog.gen_random_uuid();
  attempt_expired_job uuid := pg_catalog.gen_random_uuid();
  upload_lease uuid := pg_catalog.gen_random_uuid();
  validation_lease uuid := pg_catalog.gen_random_uuid();
  old_validation_lease uuid := pg_catalog.gen_random_uuid();
  token_hash text := repeat('a', 64);
  result jsonb;
  claimed_lease uuid;
  first_lease uuid;
  rejected boolean;
  target_proc regprocedure;
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
    raise exception 'STOP: native targeted-claim identity guard failed';
  end if;
  target_proc := pg_catalog.to_regprocedure('public.claim_amuhon_order_validation_job_for_attempt(uuid,uuid,integer)');
  if target_proc is null then raise exception '[SCHEMA] targeted claim migration is missing'; end if;
  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'public.amuhon_order_validation_jobs'::regclass) then
    raise exception '[RLS] validation jobs table RLS is disabled';
  end if;
  if has_table_privilege('anon', 'public.amuhon_order_validation_jobs', 'SELECT') or
     has_table_privilege('authenticated', 'public.amuhon_order_validation_jobs', 'SELECT') or
     has_table_privilege('service_role', 'public.amuhon_order_validation_jobs', 'SELECT') then
    raise exception '[ACL] a browser or service role has direct job-table SELECT';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = target_proc and (
      not p.prosecdef or pg_catalog.pg_get_userbyid(p.proowner) <> 'postgres' or
      not (coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, pg_temp']) or
      has_function_privilege('anon', p.oid, 'EXECUTE') or
      has_function_privilege('authenticated', p.oid, 'EXECUTE') or
      not has_function_privilege('service_role', p.oid, 'EXECUTE') or
      exists (
        select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
    )
  ) then raise exception '[RPC SECURITY] targeted claim owner, definer, search_path, or grants are incorrect'; end if;

  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, upload_token_hash, upload_lease_id, upload_lease_expires_at
  ) values
    (order_primary, pg_catalog.gen_random_uuid(), 'preparing', '{}'::jsonb, '{}'::jsonb, 24, token_hash, upload_lease, clock_timestamp() + interval '2 hours'),
    (order_null_declared, pg_catalog.gen_random_uuid(), 'preparing', '{}'::jsonb, '{}'::jsonb, null, token_hash, upload_lease, clock_timestamp() + interval '2 hours'),
    (order_wrong_target, pg_catalog.gen_random_uuid(), 'preparing', '{}'::jsonb, '{}'::jsonb, 32, token_hash, upload_lease, clock_timestamp() + interval '2 hours'),
    (order_expired_attempt, pg_catalog.gen_random_uuid(), 'preparing', '{}'::jsonb, '{}'::jsonb, 40, token_hash, upload_lease, clock_timestamp() + interval '2 hours'),
    (order_expired_upload_lease, pg_catalog.gen_random_uuid(), 'preparing', '{}'::jsonb, '{}'::jsonb, 48, token_hash, upload_lease, clock_timestamp() - interval '1 minute'),
    (order_max_attempts, pg_catalog.gen_random_uuid(), 'preparing', '{}'::jsonb, '{}'::jsonb, 56, token_hash, upload_lease, clock_timestamp() + interval '2 hours'),
    (order_expired_job_lease, pg_catalog.gen_random_uuid(), 'preparing', '{}'::jsonb, '{}'::jsonb, 64, token_hash, upload_lease, clock_timestamp() + interval '2 hours');

  insert into public.amuhon_order_temp_upload_attempts
    (id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at)
  values
    (attempt_primary, order_primary, upload_lease, order_primary::text || '/' || attempt_primary::text || '/body.pdf', order_primary::text || '/' || attempt_primary::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_null_declared, order_null_declared, upload_lease, order_null_declared::text || '/' || attempt_null_declared::text || '/body.pdf', order_null_declared::text || '/' || attempt_null_declared::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_wrong_target, order_wrong_target, upload_lease, order_wrong_target::text || '/' || attempt_wrong_target::text || '/body.pdf', order_wrong_target::text || '/' || attempt_wrong_target::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_expired, order_expired_attempt, upload_lease, order_expired_attempt::text || '/' || attempt_expired::text || '/body.pdf', order_expired_attempt::text || '/' || attempt_expired::text || '/cover.png', 'issued', clock_timestamp() - interval '1 minute'),
    (attempt_expired_upload, order_expired_upload_lease, upload_lease, order_expired_upload_lease::text || '/' || attempt_expired_upload::text || '/body.pdf', order_expired_upload_lease::text || '/' || attempt_expired_upload::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_max_attempts, order_max_attempts, upload_lease, order_max_attempts::text || '/' || attempt_max_attempts::text || '/body.pdf', order_max_attempts::text || '/' || attempt_max_attempts::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
    (attempt_expired_job, order_expired_job_lease, upload_lease, order_expired_job_lease::text || '/' || attempt_expired_job::text || '/body.pdf', order_expired_job_lease::text || '/' || attempt_expired_job::text || '/cover.png', 'issued', clock_timestamp() + interval '1 hour');

  insert into public.amuhon_order_validation_jobs (attempt_id, state, attempt_count, lease_id, lease_expires_at)
  values
    (attempt_primary, 'queued', 0, null, null),
    (attempt_null_declared, 'queued', 0, null, null),
    (attempt_wrong_target, 'queued', 0, null, null),
    (attempt_expired, 'queued', 0, null, null),
    (attempt_expired_upload, 'queued', 0, null, null),
    (attempt_max_attempts, 'queued', 5, null, null),
    (attempt_expired_job, 'validating', 1, old_validation_lease, clock_timestamp() - interval '1 second');

  result := public.claim_amuhon_order_validation_job_for_attempt(order_primary, attempt_primary, 300);
  if result is null or jsonb_typeof(result) is distinct from 'object' or
     result->>'orderId' is distinct from order_primary::text or
     result->>'attemptId' is distinct from attempt_primary::text or
     result->>'state' is distinct from 'validating' or
     result->>'declaredPageCount' is distinct from '24' or
     result->>'attemptCount' is distinct from '1' then
    raise exception '[TARGET CLAIM] requested synthetic target or declared count was not returned';
  end if;
  first_lease := (result->>'leaseId')::uuid;
  if first_lease is null then raise exception '[TARGET CLAIM] generated lease is missing'; end if;
  if not exists (select 1 from public.amuhon_orders as o where o.id = order_primary) or
     not exists (select 1 from public.amuhon_order_temp_upload_attempts as a where a.id = attempt_primary and a.order_id = order_primary) or
     not exists (select 1 from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_primary and j.state = 'validating' and j.lease_id = first_lease) then
    raise exception '[TARGET CLAIM ROWS] claimed order, attempt, or job row is missing or inconsistent';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(order_primary, attempt_primary, 300) is not null then
    raise exception '[DOUBLE CLAIM] active target was claimed twice';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(pg_catalog.gen_random_uuid(), attempt_wrong_target, 300) is not null or
     not exists (select 1 from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_wrong_target) or
     (select j.state from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_wrong_target) is distinct from 'queued' then
    raise exception '[NO FALLBACK] mismatched order changed or claimed another job';
  end if;

  result := public.claim_amuhon_order_validation_job_for_attempt(order_null_declared, attempt_null_declared, 300);
  if result is null or not (result ? 'declaredPageCount') or jsonb_typeof(result->'declaredPageCount') <> 'null' then
    raise exception '[NULL DECLARATION] declaredPageCount was not explicit JSON null';
  end if;

  if public.claim_amuhon_order_validation_job_for_attempt(order_expired_attempt, attempt_expired, 300) is not null or
     not exists (select 1 from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_expired) or
     (select j.error_code from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_expired) is distinct from 'attempt_expired' then
    raise exception '[ATTEMPT EXPIRY] expired synthetic attempt was not rejected';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(order_expired_upload_lease, attempt_expired_upload, 300) is not null or
     not exists (select 1 from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_expired_upload) or
     (select j.error_code from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_expired_upload) is distinct from 'attempt_expired' then
    raise exception '[UPLOAD LEASE] expired synthetic order lease was not rejected';
  end if;
  if public.claim_amuhon_order_validation_job_for_attempt(order_max_attempts, attempt_max_attempts, 300) is not null or
     not exists (select 1 from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_max_attempts) or
     (select j.error_code from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_max_attempts) is distinct from 'processing_timeout' then
    raise exception '[ATTEMPT LIMIT] exhausted synthetic job was not rejected';
  end if;
  result := public.claim_amuhon_order_validation_job_for_attempt(order_expired_job_lease, attempt_expired_job, 300);
  if result is null or jsonb_typeof(result) is distinct from 'object' or
     result->>'leaseId' is null or result->>'attemptCount' is distinct from '2' then
    raise exception '[LEASE RECLAIM] expired synthetic validation lease was not reclaimed';
  end if;
  claimed_lease := (result->>'leaseId')::uuid;
  if claimed_lease = old_validation_lease then raise exception '[LEASE REUSE] old lease identifier was reused'; end if;
  if not exists (select 1 from public.amuhon_order_validation_jobs as j where j.attempt_id = attempt_expired_job and j.state = 'validating' and j.lease_id = claimed_lease) then
    raise exception '[LEASE RECLAIM ROW] expired job row was not updated with the returned lease';
  end if;

  rejected := false;
  begin
    perform public.claim_amuhon_order_validation_job_for_attempt(order_wrong_target, attempt_null_declared, 29);
  exception when others then rejected := sqlerrm = 'INVALID_VALIDATION_LEASE'; end;
  if not rejected then raise exception '[LEASE INPUT] invalid lease duration was accepted'; end if;
end;
$native_targeted_claim_tests$;
select 'ALL NATIVE TARGETED CLAIM TESTS PASSED' as result;
rollback;
