-- One bounded session holds exactly one synthetic row lock, then rolls back.
\set ON_ERROR_STOP on
begin;
set local statement_timeout = '160000';
set local lock_timeout = '3000';
do $native_concurrency_lock$
declare
  found_id uuid;
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
    raise exception 'STOP: native concurrency lock identity guard failed';
  end if;
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
    raise exception 'STOP: lock target or decoy is not the exact marked synthetic fixture';
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
    raise exception 'STOP: unknown synthetic lock kind';
  end if;
  if found_id is null then raise exception 'STOP: synthetic lock target is missing'; end if;
  raise notice 'LOCK_HELD run=% kind=%; run matching Probe in a second PowerShell window now', '__RUN_ID__', '__LOCK_KIND__';
end;
$native_concurrency_lock$;
-- This statement runs on the same psql connection and inside the open transaction,
-- so the row lock above remains held while the probe checks it.
select pg_catalog.pg_sleep(120);
rollback;
