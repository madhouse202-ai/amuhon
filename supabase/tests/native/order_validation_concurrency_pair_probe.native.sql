-- Pair-only probe. Polls for the exact holder, then proves its row lock with NOWAIT.
\set ON_ERROR_STOP on
\echo PAIR_PROBE_STAGE:SQL_FILE_STARTED
do $native_concurrency_pair_probe_identity$
begin
  if current_database() is distinct from 'amuhon_validation_native' or
     current_user is distinct from 'postgres' or host(inet_server_addr()) is distinct from '127.0.0.1' or
     host(inet_client_addr()) is distinct from '127.0.0.1' or inet_server_port() is distinct from 55432 or
     replace(current_setting('data_directory'), chr(92), '/') is distinct from '__DATA_DIRECTORY__' or
     (select system_identifier::text from pg_catalog.pg_control_system()) is distinct from '__SYSTEM_IDENTIFIER__' or
     current_setting('cluster_name') is distinct from 'amuhon-native-order-validation-v1' or
     current_setting('application_name') is distinct from '__APP_NAME__' or
     current_setting('app.amuhon_native_test_environment', true) is distinct from 'amuhon-native-pg-isolated-v1' or
     current_setting('app.amuhon_native_system_identifier', true) is distinct from '__SYSTEM_IDENTIFIER__' or
     current_setting('app.amuhon_native_concurrency_run', true) is distinct from '__RUN_ID__' then
    raise exception 'STOP: pair probe connection identity guard failed';
  end if;
  if (select count(*) from pg_catalog.pg_stat_activity
      where datname = current_database() and backend_type = 'client backend') is distinct from 2 or
     (select count(*) from pg_catalog.pg_stat_activity
      where datname = current_database() and backend_type = 'client backend'
        and application_name = '__APP_NAME__') is distinct from 1 or
     (select count(*) from pg_catalog.pg_stat_activity
      where datname = current_database() and backend_type = 'client backend'
        and application_name = '__HOLDER_APP_NAME__') is distinct from 1 then
    raise exception 'STOP: pair probe requires exactly its two identified local client sessions';
  end if;
  if (select count(*) from native_test.migration_history) is distinct from 7 or
     exists ((values
       ('20261017000100_order_drafts', '1942af227de4e7f823ef14e031c2501865980c79d4ea0679df2ea36c8f857f69'),
       ('20261020000100_order_asset_uploads', '6ebe44db71d00407116ccde9bd35a6ade0611751bcaf046d6ec56c02ad3aa538'),
       ('20261020000200_order_asset_size_limit', 'ca41c0aedcc83816588010bb7fc1d80767ac2543972c288a3194d8b03f6fdf33'),
       ('20261020000300_order_temp_uploads', '5d2a079326b1749a1bc40ec3f7de616d6575d0c4ac50c449d01d63d27448044e'),
       ('20261021000100_order_validation_jobs', '8f10bbe8cce4cb2d81a29ea6f02c66aadb38e8ad23be43c3b7d0c50938fcb995'),
       ('20261022000100_order_validation_asset_commit', '28e0b23873f02030da1162d7006478305b3843b8ca6122e44e7494dd2e58de0d'),
       ('20261025000100_order_validation_targeted_claim', '194b9d0b333556b8b2b31f3427866c0f826509267d4684b245eca2454fb789de')
     )
       except select migration_version, sha256 from native_test.migration_history) or
     exists (select migration_version, sha256 from native_test.migration_history except (values
       ('20261017000100_order_drafts', '1942af227de4e7f823ef14e031c2501865980c79d4ea0679df2ea36c8f857f69'),
       ('20261020000100_order_asset_uploads', '6ebe44db71d00407116ccde9bd35a6ade0611751bcaf046d6ec56c02ad3aa538'),
       ('20261020000200_order_asset_size_limit', 'ca41c0aedcc83816588010bb7fc1d80767ac2543972c288a3194d8b03f6fdf33'),
       ('20261020000300_order_temp_uploads', '5d2a079326b1749a1bc40ec3f7de616d6575d0c4ac50c449d01d63d27448044e'),
       ('20261021000100_order_validation_jobs', '8f10bbe8cce4cb2d81a29ea6f02c66aadb38e8ad23be43c3b7d0c50938fcb995'),
       ('20261022000100_order_validation_asset_commit', '28e0b23873f02030da1162d7006478305b3843b8ca6122e44e7494dd2e58de0d'),
       ('20261025000100_order_validation_targeted_claim', '194b9d0b333556b8b2b31f3427866c0f826509267d4684b245eca2454fb789de')
     )) then
    raise exception 'STOP: pair probe migration ledger does not match the seven approved files';
  end if;
end;
$native_concurrency_pair_probe_identity$;
\echo PAIR_PROBE_STAGE:IDENTITY_GUARD_PASSED
begin isolation level read committed;
\echo PAIR_PROBE_STAGE:TRANSACTION_STARTED
set local statement_timeout = '15000';
set local lock_timeout = '3000';
do $native_concurrency_pair_probe$
declare
  result jsonb;
  target_state text;
  decoy_state text;
  probe_id uuid;
  holder_pid integer;
  holder_count integer := 0;
  lock_confirmed boolean := false;
  updated_rows integer;
  wait_iteration integer;
begin
  for wait_iteration in 1..100 loop
    select count(*), min(pid) into holder_count, holder_pid
    from pg_catalog.pg_stat_activity
    where datname = current_database() and backend_type = 'client backend'
      and application_name = '__HOLDER_APP_NAME__' and state = 'active'
      and xact_start is not null and pid <> pg_backend_pid();
    exit when holder_count = 1 and exists (
      select 1 from pg_catalog.pg_locks l
      where l.pid = holder_pid and l.granted and l.mode = 'RowShareLock'
        and l.relation = case '__LOCK_KIND__'
          when 'order' then 'public.amuhon_orders'::regclass::oid
          when 'attempt' then 'public.amuhon_order_temp_upload_attempts'::regclass::oid
          when 'job' then 'public.amuhon_order_validation_jobs'::regclass::oid
          else null::oid
        end
    );
    perform pg_catalog.pg_sleep(0.1);
  end loop;
  if holder_count is distinct from 1 or holder_pid is null then
    raise exception 'STOP: pair holder session was not uniquely active; no RPC was called';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_locks l
    where l.pid = holder_pid and l.granted and l.mode = 'RowShareLock'
      and l.relation = case '__LOCK_KIND__'
        when 'order' then 'public.amuhon_orders'::regclass::oid
        when 'attempt' then 'public.amuhon_order_temp_upload_attempts'::regclass::oid
        when 'job' then 'public.amuhon_order_validation_jobs'::regclass::oid
        else null::oid
      end
  ) then raise exception 'STOP: pair holder lacks the expected relation lock prerequisite'; end if;
  raise notice 'PAIR_PROBE_STAGE:HOLDER_DETECTED';

  if not exists (select 1 from public.amuhon_orders o
                 join public.amuhon_order_temp_upload_attempts a on a.order_id = o.id
                 join public.amuhon_order_validation_jobs j on j.attempt_id = a.id
                 where o.id = '__TARGET_ORDER_ID__' and a.id = '__TARGET_ATTEMPT_ID__'
                   and o.customer->>'native_test_run' = '__RUN_ID__'
                   and o.book_snapshot->>'native_test_run' = '__RUN_ID__'
                   and o.status = 'preparing' and o.upload_lease_id = a.lease_id
                   and o.upload_lease_expires_at > clock_timestamp() and a.state = 'issued'
                   and a.expires_at > clock_timestamp() + interval '30 seconds'
                   and a.body_object_key = o.id::text || '/' || a.id::text || '/body.pdf'
                   and a.cover_object_key = o.id::text || '/' || a.id::text || '/cover.png'
                   and j.state = 'queued' and j.attempt_count = 0 and j.lease_id is null and j.lease_expires_at is null) or
     not exists (select 1 from public.amuhon_orders o
                 join public.amuhon_order_temp_upload_attempts a on a.order_id = o.id
                 join public.amuhon_order_validation_jobs j on j.attempt_id = a.id
                 where o.id = '__DECOY_ORDER_ID__' and a.id = '__DECOY_ATTEMPT_ID__'
                   and o.customer->>'native_test_run' = '__RUN_ID__'
                   and o.book_snapshot->>'native_test_run' = '__RUN_ID__'
                   and o.status = 'preparing' and a.state = 'issued' and j.state = 'queued') then
    raise exception 'STOP: pair target or decoy is not the exact marked synthetic fixture';
  end if;

  begin
    if '__LOCK_KIND__' = 'order' then
      select id into probe_id from public.amuhon_orders where id = '__TARGET_ORDER_ID__' for update nowait;
    elsif '__LOCK_KIND__' = 'attempt' then
      select id into probe_id from public.amuhon_order_temp_upload_attempts
      where id = '__TARGET_ATTEMPT_ID__' and order_id = '__TARGET_ORDER_ID__' for update nowait;
    elsif '__LOCK_KIND__' = 'job' then
      select attempt_id into probe_id from public.amuhon_order_validation_jobs
      where attempt_id = '__TARGET_ATTEMPT_ID__' for update nowait;
    else
      raise exception 'STOP: unknown pair lock kind';
    end if;
  exception when lock_not_available then
    lock_confirmed := true;
  end;
  if not lock_confirmed then
    if probe_id is null then raise exception 'STOP: pair target row is missing'; end if;
    raise exception '[PAIR ROW LOCK NOT HELD] holder session exists but requested synthetic row is unlocked';
  end if;
  result := public.claim_amuhon_order_validation_job_for_attempt('__TARGET_ORDER_ID__', '__TARGET_ATTEMPT_ID__', 300);
  if result is not null then raise exception '[PAIR LOCKED TARGET] targeted claim returned a job while a target row was locked'; end if;
  select state into target_state from public.amuhon_order_validation_jobs where attempt_id = '__TARGET_ATTEMPT_ID__';
  if not found or target_state is distinct from 'queued' then raise exception '[PAIR TARGET STATE] target job missing or changed'; end if;
  select state into decoy_state from public.amuhon_order_validation_jobs where attempt_id = '__DECOY_ATTEMPT_ID__';
  if not found or decoy_state is distinct from 'queued' then raise exception '[PAIR NO FALLBACK] decoy job was claimed or modified'; end if;
  update public.amuhon_orders
  set book_snapshot = jsonb_set(book_snapshot, '{native_lock_probes}',
      coalesce(book_snapshot->'native_lock_probes', '[]'::jsonb) || jsonb_build_array('__LOCK_KIND__'::text), true)
  where id = '__DECOY_ORDER_ID__' and customer->>'native_test_run' = '__RUN_ID__'
    and book_snapshot->>'native_test_run' = '__RUN_ID__'
    and jsonb_typeof(coalesce(book_snapshot->'native_lock_probes', '[]'::jsonb)) = 'array'
    and not (coalesce(book_snapshot->'native_lock_probes', '[]'::jsonb) @> jsonb_build_array('__LOCK_KIND__'::text));
  get diagnostics updated_rows = row_count;
  if updated_rows is distinct from 1 then raise exception '[PAIR EVIDENCE] exact decoy fixture did not accept this result'; end if;
  raise notice 'PAIR_PROBE_STAGE:SKIP_LOCKED_VALIDATION_COMPLETED';
end;
$native_concurrency_pair_probe$;
commit;
\echo PAIR_PROBE_STAGE:COMMIT_ACKNOWLEDGED
