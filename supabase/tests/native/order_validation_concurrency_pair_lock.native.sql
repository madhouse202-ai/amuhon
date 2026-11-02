-- Pair-only holder. Its connection identity and migration ledger are checked
-- before beginning the lock-holding transaction.
\set ON_ERROR_STOP on
do $native_concurrency_pair_lock_identity$
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
    raise exception 'STOP: pair holder connection identity guard failed';
  end if;
  if exists (select 1 from pg_catalog.pg_stat_activity
             where datname = current_database() and backend_type = 'client backend'
               and pid <> pg_backend_pid()) then
    raise exception 'STOP: another client is connected before the pair holder starts';
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
    raise exception 'STOP: pair holder migration ledger does not match the seven approved files';
  end if;
end;
$native_concurrency_pair_lock_identity$;
begin;
set local statement_timeout = '160000';
set local lock_timeout = '3000';
do $native_concurrency_pair_lock$
declare
  found_id uuid;
begin
  if not exists (select 1 from public.amuhon_orders o
                 join public.amuhon_order_temp_upload_attempts a on a.order_id = o.id
                 join public.amuhon_order_validation_jobs j on j.attempt_id = a.id
                 where o.id = '__TARGET_ORDER_ID__' and a.id = '__TARGET_ATTEMPT_ID__'
                   and o.customer->>'native_test_run' = '__RUN_ID__'
                   and o.book_snapshot->>'native_test_run' = '__RUN_ID__'
                   and o.status = 'preparing' and o.files_validated_at is null
                   and o.upload_lease_id = a.lease_id and o.upload_lease_expires_at > clock_timestamp()
                   and a.state = 'issued' and a.expires_at > clock_timestamp() + interval '30 seconds'
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
    raise exception 'STOP: pair lock target or decoy is not the exact marked synthetic fixture';
  end if;
  if '__LOCK_KIND__' = 'order' then
    select id into found_id from public.amuhon_orders where id = '__TARGET_ORDER_ID__' for update;
  elsif '__LOCK_KIND__' = 'attempt' then
    select id into found_id from public.amuhon_order_temp_upload_attempts
    where id = '__TARGET_ATTEMPT_ID__' and order_id = '__TARGET_ORDER_ID__' for update;
  elsif '__LOCK_KIND__' = 'job' then
    select attempt_id into found_id from public.amuhon_order_validation_jobs
    where attempt_id = '__TARGET_ATTEMPT_ID__' for update;
  else
    raise exception 'STOP: unknown pair lock kind';
  end if;
  if found_id is null then raise exception 'STOP: pair synthetic lock target is missing'; end if;
  raise notice 'PAIR_HOLDER_READY run=% kind=%', '__RUN_ID__', '__LOCK_KIND__';
end;
$native_concurrency_pair_lock$;
select pg_catalog.pg_sleep(120);
rollback;
