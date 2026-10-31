-- The probe must run while the matching lock session is active.
\set ON_ERROR_STOP on
begin isolation level read committed;
set local statement_timeout = '15000';
set local lock_timeout = '3000';
do $native_concurrency_probe$
declare
  result jsonb;
  target_state text;
  decoy_state text;
  probe_id uuid;
  holder_pid integer;
  lock_confirmed boolean := false;
  updated_rows integer;
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
    raise exception 'STOP: native concurrency probe identity guard failed';
  end if;
  if (select count(*) from pg_catalog.pg_stat_activity
      where datname = current_database() and backend_type = 'client backend'
        and application_name = '__HOLDER_APP_NAME__' and state = 'active'
        and xact_start is not null and pid <> pg_backend_pid()) is distinct from 1 then
    raise exception 'STOP: matching lock-holder session is not active; no RPC was called';
  end if;
  select pid into holder_pid from pg_catalog.pg_stat_activity
  where datname = current_database() and backend_type = 'client backend'
    and application_name = '__HOLDER_APP_NAME__' and state = 'active'
    and xact_start is not null and pid <> pg_backend_pid();
  if not exists (
    select 1 from pg_catalog.pg_locks l
    where l.pid = holder_pid and l.granted and l.mode = 'RowShareLock'
      and l.relation = case '__LOCK_KIND__'
        when 'order' then 'public.amuhon_orders'::regclass::oid
        when 'attempt' then 'public.amuhon_order_temp_upload_attempts'::regclass::oid
        when 'job' then 'public.amuhon_order_validation_jobs'::regclass::oid
        else null::oid
      end
  ) then
    raise exception 'STOP: active holder does not own the expected table-level row-lock prerequisite';
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
    raise exception 'STOP: probe target or decoy is not the exact marked synthetic fixture';
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
      raise exception 'STOP: unknown synthetic lock kind';
    end if;
  exception when lock_not_available then
    lock_confirmed := true;
  end;
  if not lock_confirmed then
    if probe_id is null then raise exception 'STOP: target row for lock verification is missing'; end if;
    raise exception '[ROW LOCK NOT HELD] holder session exists but the expected synthetic row was not locked';
  end if;
  result := public.claim_amuhon_order_validation_job_for_attempt('__TARGET_ORDER_ID__', '__TARGET_ATTEMPT_ID__', 300);
  if result is not null then raise exception '[LOCKED TARGET] targeted claim returned a job while a target row was locked'; end if;
  select state into target_state from public.amuhon_order_validation_jobs where attempt_id = '__TARGET_ATTEMPT_ID__';
  if not found or target_state is distinct from 'queued' then
    raise exception '[LOCKED TARGET STATE] target job missing or changed while locked';
  end if;
  select state into decoy_state from public.amuhon_order_validation_jobs where attempt_id = '__DECOY_ATTEMPT_ID__';
  if not found or decoy_state is distinct from 'queued' then
    raise exception '[NO FALLBACK] decoy job was claimed or modified';
  end if;
  update public.amuhon_orders
  set book_snapshot = jsonb_set(
    book_snapshot,
    '{native_lock_probes}',
    coalesce(book_snapshot->'native_lock_probes', '[]'::jsonb) || jsonb_build_array('__LOCK_KIND__'::text),
    true
  )
  where id = '__DECOY_ORDER_ID__'
    and customer->>'native_test_run' = '__RUN_ID__'
    and book_snapshot->>'native_test_run' = '__RUN_ID__'
    and jsonb_typeof(coalesce(book_snapshot->'native_lock_probes', '[]'::jsonb)) = 'array'
    and not (coalesce(book_snapshot->'native_lock_probes', '[]'::jsonb) @> jsonb_build_array('__LOCK_KIND__'::text));
  get diagnostics updated_rows = row_count;
  if updated_rows is distinct from 1 then
    raise exception '[PROBE EVIDENCE] exact decoy fixture did not accept this unique lock result';
  end if;
end;
$native_concurrency_probe$;
commit;
