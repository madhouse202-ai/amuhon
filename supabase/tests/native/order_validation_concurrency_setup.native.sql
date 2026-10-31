-- Fixed synthetic fixture setup used only by the guarded concurrency wrapper.
-- This transaction commits two marked synthetic rows so another session can see them.
\set ON_ERROR_STOP on
-- Identify the connected cluster before acquiring locks or changing data.
do $native_concurrency_setup$
begin
  if current_database() is distinct from 'amuhon_validation_native' or
     current_user is distinct from 'postgres' or
     host(inet_server_addr()) is distinct from '127.0.0.1' or
     host(inet_client_addr()) is distinct from '127.0.0.1' or
     inet_server_port() is distinct from 55432 or
     replace(current_setting('data_directory'), chr(92), '/') is distinct from '__DATA_DIRECTORY__' or
     (select system_identifier::text from pg_catalog.pg_control_system()) is distinct from '__SYSTEM_IDENTIFIER__' or
     current_setting('cluster_name') is distinct from 'amuhon-native-order-validation-v1' or
     current_setting('application_name') is distinct from '__APP_NAME__' or
     current_setting('app.amuhon_native_test_environment', true) is distinct from 'amuhon-native-pg-isolated-v1' or
     current_setting('app.amuhon_native_system_identifier', true) is distinct from '__SYSTEM_IDENTIFIER__' or
     current_setting('app.amuhon_native_concurrency_run', true) is distinct from '__RUN_ID__' then
    raise exception 'STOP: native concurrency setup identity guard failed';
  end if;
end;
$native_concurrency_setup$;
begin;
set local statement_timeout = '20000';
-- Serialize fixture creation/cleanup. The following DO gets a fresh READ COMMITTED snapshot.
select pg_catalog.pg_advisory_xact_lock(20261031, 405);
do $native_concurrency_setup_fixture$
begin
  if exists (select 1 from public.amuhon_orders where id = any(array['__TARGET_ORDER_ID__', '__DECOY_ORDER_ID__']::uuid[])) or
     exists (select 1 from public.amuhon_order_temp_upload_attempts where id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])) or
     exists (select 1 from public.amuhon_order_validation_jobs where attempt_id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])) then
    raise exception 'STOP: generated synthetic fixture identifier already exists';
  end if;
  if exists (select 1 from public.amuhon_orders
             where customer ? 'native_test_run' or book_snapshot ? 'native_test_run') then
    raise exception 'STOP: a prior native concurrency fixture remains; inspect its manifest before preparing another run';
  end if;
  if exists (select 1 from pg_catalog.pg_stat_activity
             where datname = current_database() and backend_type = 'client backend'
               and pid <> pg_backend_pid()) then
    raise exception 'STOP: another client session is connected to the test database';
  end if;
end;
$native_concurrency_setup_fixture$;
insert into public.amuhon_orders (
  id, idempotency_key, status, customer, book_snapshot, declared_body_pdf_page_count,
  upload_token_hash, upload_lease_id, upload_lease_expires_at
) values
  ('__TARGET_ORDER_ID__', '__TARGET_IDEMPOTENCY_ID__', 'preparing',
   jsonb_build_object('native_test_run', '__RUN_ID__'),
   jsonb_build_object('native_test_run', '__RUN_ID__'), 24, repeat('a', 64),
   '__UPLOAD_LEASE_ID__', clock_timestamp() + interval '2 hours'),
  ('__DECOY_ORDER_ID__', '__DECOY_IDEMPOTENCY_ID__', 'preparing',
   jsonb_build_object('native_test_run', '__RUN_ID__'),
   jsonb_build_object('native_test_run', '__RUN_ID__'), 32, repeat('b', 64),
   '__DECOY_UPLOAD_LEASE_ID__', clock_timestamp() + interval '2 hours');
insert into public.amuhon_order_temp_upload_attempts (
  id, order_id, lease_id, body_object_key, cover_object_key, state, expires_at
) values
  ('__TARGET_ATTEMPT_ID__', '__TARGET_ORDER_ID__', '__UPLOAD_LEASE_ID__',
   '__TARGET_ORDER_ID__/__TARGET_ATTEMPT_ID__/body.pdf',
   '__TARGET_ORDER_ID__/__TARGET_ATTEMPT_ID__/cover.png', 'issued', clock_timestamp() + interval '1 hour'),
  ('__DECOY_ATTEMPT_ID__', '__DECOY_ORDER_ID__', '__DECOY_UPLOAD_LEASE_ID__',
   '__DECOY_ORDER_ID__/__DECOY_ATTEMPT_ID__/body.pdf',
   '__DECOY_ORDER_ID__/__DECOY_ATTEMPT_ID__/cover.png', 'issued', clock_timestamp() + interval '1 hour');
insert into public.amuhon_order_validation_jobs (attempt_id, state, attempt_count)
values ('__TARGET_ATTEMPT_ID__', 'queued', 0), ('__DECOY_ATTEMPT_ID__', 'queued', 0);
commit;
