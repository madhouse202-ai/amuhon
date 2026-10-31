-- Explicit exact-ID cleanup of marked synthetic rows only; never a general cleaner.
\set ON_ERROR_STOP on
-- Identify the connected cluster before acquiring locks or deleting data.
do $native_concurrency_cleanup$
begin
  if current_database() is distinct from 'amuhon_validation_native' or current_user is distinct from 'postgres' or
     host(inet_server_addr()) is distinct from '127.0.0.1' or host(inet_client_addr()) is distinct from '127.0.0.1' or
     inet_server_port() is distinct from 55432 or replace(current_setting('data_directory'), chr(92), '/') is distinct from '__DATA_DIRECTORY__' or
     (select system_identifier::text from pg_catalog.pg_control_system()) is distinct from '__SYSTEM_IDENTIFIER__' or
     current_setting('cluster_name') is distinct from 'amuhon-native-order-validation-v1' or
     current_setting('application_name') is distinct from '__APP_NAME__' or
     current_setting('app.amuhon_native_test_environment', true) is distinct from 'amuhon-native-pg-isolated-v1' or
     current_setting('app.amuhon_native_system_identifier', true) is distinct from '__SYSTEM_IDENTIFIER__' or
     current_setting('app.amuhon_native_concurrency_run', true) is distinct from '__RUN_ID__' then
    raise exception 'STOP: native concurrency cleanup identity guard failed';
  end if;
end;
$native_concurrency_cleanup$;
begin;
set local statement_timeout = '20000';
select pg_catalog.pg_advisory_xact_lock(20261031, 405);
do $native_concurrency_cleanup_fixture$
declare
  order_count integer;
  valid_order_count integer;
  attempt_count integer;
  valid_attempt_count integer;
  job_count integer;
  valid_job_count integer;
begin
  if exists (select 1 from pg_catalog.pg_stat_activity
             where datname = current_database() and backend_type = 'client backend'
               and pid <> pg_backend_pid()) then
    raise exception 'STOP: another client session is connected; cleanup requires an otherwise idle test database';
  end if;
  select count(*), count(*) filter (where o.customer->>'native_test_run' = '__RUN_ID__'
                                    and o.book_snapshot->>'native_test_run' = '__RUN_ID__'
                                    and o.status = 'preparing' and o.files_validated_at is null
                                    and o.body_pdf_storage_path is null and o.cover_png_storage_path is null)
    into order_count, valid_order_count
  from public.amuhon_orders o where o.id = any(array['__TARGET_ORDER_ID__', '__DECOY_ORDER_ID__']::uuid[]);
  select count(*), count(*) filter (where a.state = 'issued' and
      ((a.id = '__TARGET_ATTEMPT_ID__' and a.order_id = '__TARGET_ORDER_ID__') or
       (a.id = '__DECOY_ATTEMPT_ID__' and a.order_id = '__DECOY_ORDER_ID__')) and
      a.body_object_key = a.order_id::text || '/' || a.id::text || '/body.pdf' and
      a.cover_object_key = a.order_id::text || '/' || a.id::text || '/cover.png')
    into attempt_count, valid_attempt_count
  from public.amuhon_order_temp_upload_attempts a where a.id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[]);
  select count(*), count(*) filter (where
      (j.state = 'queued' and j.attempt_count = 0 and j.lease_id is null and j.lease_expires_at is null) or
      (j.state = 'validating' and j.attempt_count between 1 and 5 and j.lease_id is not null and j.lease_expires_at is not null))
    into job_count, valid_job_count
  from public.amuhon_order_validation_jobs j where j.attempt_id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[]);
  if order_count not in (0, 2) or attempt_count not in (0, 2) or job_count not in (0, 2) or
     order_count <> valid_order_count or attempt_count <> valid_attempt_count or job_count <> valid_job_count or
     (order_count = 0 and (attempt_count <> 0 or job_count <> 0)) or
     (order_count = 2 and (attempt_count <> 2 or job_count <> 2)) then
    raise exception 'STOP: synthetic fixture is partial, changed, or marker-mismatched; no rows deleted';
  end if;
end;
$native_concurrency_cleanup_fixture$;
delete from public.amuhon_order_validation_jobs where attempt_id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])
  and ((state = 'queued' and attempt_count = 0 and lease_id is null and lease_expires_at is null) or
       (state = 'validating' and attempt_count between 1 and 5 and lease_id is not null and lease_expires_at is not null));
delete from public.amuhon_order_temp_upload_attempts where
  (id = '__TARGET_ATTEMPT_ID__' and order_id = '__TARGET_ORDER_ID__' or id = '__DECOY_ATTEMPT_ID__' and order_id = '__DECOY_ORDER_ID__')
  and state = 'issued'
  and body_object_key = order_id::text || '/' || id::text || '/body.pdf'
  and cover_object_key = order_id::text || '/' || id::text || '/cover.png';
delete from public.amuhon_orders where id = any(array['__TARGET_ORDER_ID__', '__DECOY_ORDER_ID__']::uuid[])
  and customer->>'native_test_run' = '__RUN_ID__' and book_snapshot->>'native_test_run' = '__RUN_ID__'
  and status = 'preparing' and files_validated_at is null and body_pdf_storage_path is null and cover_png_storage_path is null;
do $native_cleanup_verify$
begin
  if exists (select 1 from public.amuhon_order_validation_jobs where attempt_id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])) or
     exists (select 1 from public.amuhon_order_temp_upload_attempts where id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])) or
     exists (select 1 from public.amuhon_orders where id = any(array['__TARGET_ORDER_ID__', '__DECOY_ORDER_ID__']::uuid[])) then
    raise exception 'STOP: one or more exact synthetic rows remain after cleanup';
  end if;
end;
$native_cleanup_verify$;
commit;
