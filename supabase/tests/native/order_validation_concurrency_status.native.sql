-- Read-only status for exactly this run's two synthetic fixture pairs.
\set ON_ERROR_STOP on
do $native_concurrency_status_guard$
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
    raise exception 'STOP: native concurrency status identity guard failed';
  end if;
end;
$native_concurrency_status_guard$;
with fixture_counts as (
  select
    (select count(*) from public.amuhon_orders o where o.id = any(array['__TARGET_ORDER_ID__', '__DECOY_ORDER_ID__']::uuid[])
      and o.customer->>'native_test_run' = '__RUN_ID__' and o.book_snapshot->>'native_test_run' = '__RUN_ID__') as order_count,
    (select count(*) from public.amuhon_order_temp_upload_attempts a where a.id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])) as attempt_count,
    (select count(*) from public.amuhon_order_validation_jobs j where j.attempt_id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])) as job_count,
    (select count(*) from public.amuhon_order_validation_jobs j where j.attempt_id = '__TARGET_ATTEMPT_ID__' and j.state = 'validating') as claimed_count
)
select case
         when order_count = 0 and attempt_count = 0 and job_count = 0 and '__MANIFEST_STATUS__' = 'cleaned' then 'cleanup_completed'
         when order_count = 0 and attempt_count = 0 and job_count = 0 then 'fixture_not_present'
         when order_count = 2 and attempt_count = 2 and job_count = 2 and claimed_count = 1 then 'claim_committed_cleanup_pending'
         when order_count = 2 and attempt_count = 2 and job_count = 2 then 'fixture_in_progress'
         else 'fixture_inconsistent_stop'
       end as fixture_status,
       order_count, attempt_count, job_count, claimed_count
from fixture_counts;
