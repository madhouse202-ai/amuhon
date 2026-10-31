-- Read-only diagnosis of the exact cleanup predicates for one synthetic run.
\set ON_ERROR_STOP on
-- Refuse any connection that does not identify as the guarded native cluster.
do $native_concurrency_diagnose_guard$
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
    raise exception 'STOP: native concurrency diagnose identity guard failed';
  end if;
end;
$native_concurrency_diagnose_guard$;
begin read only;
set local statement_timeout = '20000';
with observed as (
  select
    (select count(*)::bigint from pg_catalog.pg_stat_activity
     where datname = current_database() and backend_type = 'client backend' and pid <> pg_backend_pid()) as other_client_count,
    (select count(*)::bigint from public.amuhon_orders o
     where o.id = any(array['__TARGET_ORDER_ID__', '__DECOY_ORDER_ID__']::uuid[])) as order_count,
    (select count(*)::bigint from public.amuhon_orders o
     where o.id = any(array['__TARGET_ORDER_ID__', '__DECOY_ORDER_ID__']::uuid[])
       and o.customer->>'native_test_run' = '__RUN_ID__'
       and o.book_snapshot->>'native_test_run' = '__RUN_ID__'
       and o.status = 'preparing' and o.files_validated_at is null
       and o.body_pdf_storage_path is null and o.cover_png_storage_path is null) as valid_order_count,
    (select count(*)::bigint from public.amuhon_order_temp_upload_attempts a
     where a.id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])) as attempt_count,
    (select count(*)::bigint from public.amuhon_order_temp_upload_attempts a
     where a.id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])
       and a.state = 'issued'
       and ((a.id = '__TARGET_ATTEMPT_ID__' and a.order_id = '__TARGET_ORDER_ID__') or
            (a.id = '__DECOY_ATTEMPT_ID__' and a.order_id = '__DECOY_ORDER_ID__'))
       and a.body_object_key = a.order_id::text || '/' || a.id::text || '/body.pdf'
       and a.cover_object_key = a.order_id::text || '/' || a.id::text || '/cover.png') as valid_attempt_count,
    (select count(*)::bigint from public.amuhon_order_validation_jobs j
     where j.attempt_id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])) as job_count,
    (select count(*)::bigint from public.amuhon_order_validation_jobs j
     where j.attempt_id = any(array['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__']::uuid[])
       and ((j.state = 'queued' and j.attempt_count = 0 and j.lease_id is null and j.lease_expires_at is null) or
            (j.state = 'validating' and j.attempt_count between 1 and 5 and j.lease_id is not null and j.lease_expires_at is not null))) as valid_job_count,
    (select count(*)::bigint from pg_catalog.pg_locks l
     where l.locktype = 'advisory'
       and l.database = (select d.oid from pg_catalog.pg_database d where d.datname = current_database())
       and l.classid::text = '20261031' and l.objid::text = '405' and l.objsubid = 2) as cleanup_advisory_lock_entries
), checks as (
  select 'native_connection_identity_guard'::text as condition_name,
         true as passed, 1::bigint as observed_count, '1 (or SQL stopped before report)'::text as expected
  from observed
  union all
  select 'other_client_sessions_absent'::text as condition_name,
         other_client_count = 0 as passed, other_client_count as observed_count, '0'::text as expected
  from observed
  union all
  select 'order_id_count_allowed', order_count in (0, 2), order_count, '0 or 2' from observed
  union all
  select 'order_rows_match_cleanup_predicate', order_count = valid_order_count, valid_order_count, order_count::text from observed
  union all
  select 'attempt_id_count_allowed', attempt_count in (0, 2), attempt_count, '0 or 2' from observed
  union all
  select 'attempt_rows_match_cleanup_predicate', attempt_count = valid_attempt_count, valid_attempt_count, attempt_count::text from observed
  union all
  select 'job_attempt_id_count_allowed', job_count in (0, 2), job_count, '0 or 2' from observed
  union all
  select 'job_rows_match_cleanup_predicate', job_count = valid_job_count, valid_job_count, job_count::text from observed
  union all
  select 'fixture_groups_are_coherent',
         (order_count = 0 and attempt_count = 0 and job_count = 0) or
         (order_count = 2 and attempt_count = 2 and job_count = 2),
         case when (order_count = 0 and attempt_count = 0 and job_count = 0) or
                   (order_count = 2 and attempt_count = 2 and job_count = 2) then 1::bigint else 0::bigint end,
         '1 (all zero or all two)'::text
  from observed
  union all
  select 'all_cleanup_preconditions_pass',
         other_client_count = 0 and order_count in (0, 2) and attempt_count in (0, 2) and job_count in (0, 2)
           and order_count = valid_order_count and attempt_count = valid_attempt_count and job_count = valid_job_count
           and ((order_count = 0 and attempt_count = 0 and job_count = 0) or
                (order_count = 2 and attempt_count = 2 and job_count = 2)),
         case when other_client_count = 0 and order_count in (0, 2) and attempt_count in (0, 2) and job_count in (0, 2)
                   and order_count = valid_order_count and attempt_count = valid_attempt_count and job_count = valid_job_count
                   and ((order_count = 0 and attempt_count = 0 and job_count = 0) or
                        (order_count = 2 and attempt_count = 2 and job_count = 2))
              then 1::bigint else 0::bigint end,
         '1'::text
  from observed
)
select condition_name,
       case when passed then 'PASS' else 'FAIL' end as result,
       observed_count,
       expected
from checks
union all
select 'cleanup_advisory_lock_snapshot',
       case when cleanup_advisory_lock_entries = 0 then 'PASS' else 'FAIL (informational)' end,
       cleanup_advisory_lock_entries,
       '0 at query snapshot; no lock is acquired'::text
from observed
order by condition_name;
rollback;
