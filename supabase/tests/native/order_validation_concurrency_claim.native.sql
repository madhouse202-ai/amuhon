-- After the holder session exits, claim exactly the target and persist synthetic state.
\set ON_ERROR_STOP on
begin isolation level read committed;
set local statement_timeout = '15000';
set local lock_timeout = '3000';
do $native_concurrency_claim$
declare
  result jsonb;
  duplicate_result jsonb;
  claimed_lease uuid;
  target_state text;
  decoy_state text;
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
    raise exception 'STOP: native concurrency claim identity guard failed';
  end if;
  if exists (select 1 from pg_catalog.pg_stat_activity
             where datname = current_database() and application_name like 'amuhon-c-__RUN_ID_SHORT__-%'
               and pid <> pg_backend_pid()) then
    raise exception 'STOP: a lock-holder or probe session is still active';
  end if;
  if not exists (select 1 from public.amuhon_orders o
                 where o.id = '__DECOY_ORDER_ID__'
                   and o.customer->>'native_test_run' = '__RUN_ID__'
                   and o.book_snapshot->>'native_test_run' = '__RUN_ID__'
                   and case when jsonb_typeof(o.book_snapshot->'native_lock_probes') = 'array'
                     then jsonb_array_length(o.book_snapshot->'native_lock_probes') = 3
                       and o.book_snapshot->'native_lock_probes' @> '["order", "attempt", "job"]'::jsonb
                     else false end) then
    raise exception '[PROBE EVIDENCE] SQL-confirmed order/attempt/job lock probes for this run are required';
  end if;
  if not exists (select 1 from public.amuhon_orders o
                 join public.amuhon_order_temp_upload_attempts a on a.order_id = o.id
                 join public.amuhon_order_validation_jobs j on j.attempt_id = a.id
                 where o.id = '__TARGET_ORDER_ID__' and a.id = '__TARGET_ATTEMPT_ID__'
                   and o.customer->>'native_test_run' = '__RUN_ID__'
                   and o.book_snapshot->>'native_test_run' = '__RUN_ID__'
                   and o.status = 'preparing' and o.upload_lease_id = a.lease_id
                   and o.upload_lease_expires_at > clock_timestamp() and a.state = 'issued'
                   and a.expires_at > clock_timestamp() + interval '30 seconds'
                   and j.state = 'queued' and j.attempt_count = 0 and j.lease_id is null and j.lease_expires_at is null) or
     not exists (select 1 from public.amuhon_orders o
                 join public.amuhon_order_temp_upload_attempts a on a.order_id = o.id
                 join public.amuhon_order_validation_jobs j on j.attempt_id = a.id
                 where o.id = '__DECOY_ORDER_ID__' and a.id = '__DECOY_ATTEMPT_ID__'
                   and o.customer->>'native_test_run' = '__RUN_ID__'
                   and o.book_snapshot->>'native_test_run' = '__RUN_ID__'
                   and o.status = 'preparing' and a.state = 'issued' and j.state = 'queued') then
    raise exception 'STOP: claim target or decoy is not the exact marked synthetic fixture';
  end if;
  result := public.claim_amuhon_order_validation_job_for_attempt('__TARGET_ORDER_ID__', '__TARGET_ATTEMPT_ID__', 900);
  if result is null or jsonb_typeof(result) is distinct from 'object' or
     result->>'orderId' is distinct from '__TARGET_ORDER_ID__' or
     result->>'attemptId' is distinct from '__TARGET_ATTEMPT_ID__' or result->>'state' is distinct from 'validating' then
    raise exception '[UNLOCKED CLAIM] target was not claimed after the lock session ended';
  end if;
  claimed_lease := (result->>'leaseId')::uuid;
  if claimed_lease is null then raise exception '[UNLOCKED CLAIM] lease ID missing'; end if;
  duplicate_result := public.claim_amuhon_order_validation_job_for_attempt('__TARGET_ORDER_ID__', '__TARGET_ATTEMPT_ID__', 900);
  if duplicate_result is not null then raise exception '[DOUBLE CLAIM] active synthetic job was claimed twice'; end if;
  select state into target_state from public.amuhon_order_validation_jobs where attempt_id = '__TARGET_ATTEMPT_ID__';
  if not found or target_state is distinct from 'validating' then raise exception '[CLAIM STATE] target state is not validating'; end if;
  select state into decoy_state from public.amuhon_order_validation_jobs where attempt_id = '__DECOY_ATTEMPT_ID__';
  if not found or decoy_state is distinct from 'queued' then raise exception '[NO FALLBACK] decoy job was claimed or modified'; end if;
end;
$native_concurrency_claim$;
commit;
