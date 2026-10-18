-- Manual target check: confirm the Supabase Dashboard project is amuhon-staging,
-- then replace the confirmation sentinel below with exactly 'amuhon-staging'.
-- The database does not expose a dependable project display name to SQL, so this
-- is an explicit operator confirmation, not cryptographic project identification.
-- This is a plain PostgreSQL script (no pgTAP dependency). All test DML is rolled back.
begin;

do $security_tests$
declare
  draft_id uuid := gen_random_uuid();
  idem uuid := gen_random_uuid();
  rate_key text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  first_result jsonb;
  retry_result jsonb;
  test_order_id uuid;
  rejected boolean;
  i integer;
  target_confirmation constant text := 'amuhon-staging';
begin
  if target_confirmation <> 'amuhon-staging' then
    raise exception 'STOP: confirm the Dashboard project is amuhon-staging and set target_confirmation accordingly';
  end if;
  if to_regclass('public.amuhon_orders') is null or
     to_regclass('public.amuhon_order_rate_limits') is null then
    raise exception '[SCHEMA] required order tables are missing; apply the migration first';
  end if;
  if to_regprocedure('public.create_amuhon_order_draft(uuid,uuid,jsonb,jsonb,integer,text,integer)') is null or
     to_regprocedure('public.purge_expired_amuhon_order_drafts()') is null or
     to_regprocedure('public.guard_amuhon_order_update()') is null then
    raise exception '[SCHEMA] required order functions are missing; apply the migration first';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception '[STORAGE] Supabase Storage tables are unavailable in this project';
  end if;
  if exists (select 1 from public.amuhon_orders) or
     exists (select 1 from public.amuhon_order_rate_limits) then
    raise exception 'STOP: test requires empty order and rate-limit tables to avoid touching existing staging data';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.amuhon_orders'::regclass) then
    raise exception '[RLS] orders table RLS is disabled';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.amuhon_order_rate_limits'::regclass) then
    raise exception '[RLS] rate-limit table RLS is disabled';
  end if;

  if has_table_privilege('anon', 'public.amuhon_orders', 'SELECT') or
     has_table_privilege('anon', 'public.amuhon_orders', 'INSERT') or
     has_table_privilege('anon', 'public.amuhon_orders', 'UPDATE') or
     has_table_privilege('anon', 'public.amuhon_orders', 'DELETE') or
     has_table_privilege('authenticated', 'public.amuhon_orders', 'SELECT') or
     has_table_privilege('authenticated', 'public.amuhon_orders', 'INSERT') or
     has_table_privilege('authenticated', 'public.amuhon_orders', 'UPDATE') or
     has_table_privilege('authenticated', 'public.amuhon_orders', 'DELETE') or
     has_table_privilege('service_role', 'public.amuhon_orders', 'SELECT') or
     has_table_privilege('service_role', 'public.amuhon_orders', 'INSERT') or
     has_table_privilege('service_role', 'public.amuhon_orders', 'UPDATE') or
     has_table_privilege('service_role', 'public.amuhon_orders', 'DELETE') then
    raise exception '[TABLE PRIVILEGES] anon, authenticated, or service_role has direct access to orders';
  end if;
  if has_table_privilege('anon', 'public.amuhon_order_rate_limits', 'SELECT') or
     has_table_privilege('anon', 'public.amuhon_order_rate_limits', 'INSERT') or
     has_table_privilege('anon', 'public.amuhon_order_rate_limits', 'UPDATE') or
     has_table_privilege('anon', 'public.amuhon_order_rate_limits', 'DELETE') or
     has_table_privilege('authenticated', 'public.amuhon_order_rate_limits', 'SELECT') or
     has_table_privilege('authenticated', 'public.amuhon_order_rate_limits', 'INSERT') or
     has_table_privilege('authenticated', 'public.amuhon_order_rate_limits', 'UPDATE') or
     has_table_privilege('authenticated', 'public.amuhon_order_rate_limits', 'DELETE') or
     has_table_privilege('service_role', 'public.amuhon_order_rate_limits', 'SELECT') or
     has_table_privilege('service_role', 'public.amuhon_order_rate_limits', 'INSERT') or
     has_table_privilege('service_role', 'public.amuhon_order_rate_limits', 'UPDATE') or
     has_table_privilege('service_role', 'public.amuhon_order_rate_limits', 'DELETE') then
    raise exception '[TABLE PRIVILEGES] anon, authenticated, or service_role has direct access to rate-limit buckets';
  end if;

  if (select pg_get_userbyid(proowner) from pg_proc where oid =
      'public.create_amuhon_order_draft(uuid,uuid,jsonb,jsonb,integer,text,integer)'::regprocedure
  ) <> 'postgres' then
    raise exception '[RPC SECURITY] draft RPC is not owned by postgres';
  end if;
  if not (select prosecdef from pg_proc where oid =
    'public.create_amuhon_order_draft(uuid,uuid,jsonb,jsonb,integer,text,integer)'::regprocedure) then
    raise exception '[RPC SECURITY] draft RPC is not SECURITY DEFINER';
  end if;
  if not (select coalesce(proconfig, array[]::text[]) @> array['search_path=pg_catalog, pg_temp']
    from pg_proc where oid =
      'public.create_amuhon_order_draft(uuid,uuid,jsonb,jsonb,integer,text,integer)'::regprocedure) then
    raise exception '[RPC SECURITY] draft RPC has an unexpected search_path';
  end if;
  if (select pg_get_userbyid(proowner) from pg_proc where oid =
      'public.purge_expired_amuhon_order_drafts()'::regprocedure
  ) <> 'postgres' or
     not (select prosecdef from pg_proc where oid = 'public.purge_expired_amuhon_order_drafts()'::regprocedure) or
     not (select coalesce(proconfig, array[]::text[]) @> array['search_path=pg_catalog, pg_temp']
       from pg_proc where oid = 'public.purge_expired_amuhon_order_drafts()'::regprocedure) then
    raise exception '[RPC SECURITY] purge function owner, SECURITY DEFINER, or search_path is incorrect';
  end if;
  if exists (select 1 from pg_roles where rolname = 'amuhon_order_executor') and (
    has_table_privilege('amuhon_order_executor', 'public.amuhon_orders', 'SELECT') or
    has_table_privilege('amuhon_order_executor', 'public.amuhon_orders', 'INSERT') or
    has_table_privilege('amuhon_order_executor', 'public.amuhon_orders', 'UPDATE') or
    has_table_privilege('amuhon_order_executor', 'public.amuhon_orders', 'DELETE') or
    has_table_privilege('amuhon_order_executor', 'public.amuhon_order_rate_limits', 'SELECT') or
    has_table_privilege('amuhon_order_executor', 'public.amuhon_order_rate_limits', 'INSERT') or
    has_table_privilege('amuhon_order_executor', 'public.amuhon_order_rate_limits', 'UPDATE') or
    has_table_privilege('amuhon_order_executor', 'public.amuhon_order_rate_limits', 'DELETE')
  ) then
    raise exception '[LEGACY ROLE] executor role retains direct table privileges';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in ('amuhon_orders', 'amuhon_order_rate_limits')
      and 'amuhon_order_executor' = any(roles)
  ) then
    raise exception '[LEGACY ROLE] executor role retains order-table RLS policies';
  end if;
  if has_function_privilege('anon', 'public.create_amuhon_order_draft(uuid,uuid,jsonb,jsonb,integer,text,integer)', 'EXECUTE') or
     has_function_privilege('authenticated', 'public.create_amuhon_order_draft(uuid,uuid,jsonb,jsonb,integer,text,integer)', 'EXECUTE') or
     has_function_privilege('service_role', 'public.create_amuhon_order_draft(uuid,uuid,jsonb,jsonb,integer,text,integer)', 'EXECUTE') is false or
     has_function_privilege('anon', 'public.purge_expired_amuhon_order_drafts()', 'EXECUTE') or
     has_function_privilege('authenticated', 'public.purge_expired_amuhon_order_drafts()', 'EXECUTE') or
     has_function_privilege('service_role', 'public.purge_expired_amuhon_order_drafts()', 'EXECUTE') is false then
    raise exception '[RPC PRIVILEGES] anon/authenticated can execute a protected RPC, or service_role cannot';
  end if;
  if has_function_privilege('anon', 'public.guard_amuhon_order_update()', 'EXECUTE') or
     has_function_privilege('authenticated', 'public.guard_amuhon_order_update()', 'EXECUTE') or
     has_function_privilege('service_role', 'public.guard_amuhon_order_update()', 'EXECUTE') then
    raise exception '[RPC PRIVILEGES] API roles can directly execute the trigger helper';
  end if;
  if (select "public" from storage.buckets where id = 'amuhon-order-files') is distinct from false then
    raise exception '[STORAGE] order bucket is missing or public';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'amuhon_order_files_deny_public_access'
      and permissive = 'RESTRICTIVE'
      and 'public'::name = any(roles)
      and qual like '%bucket_id <>%'
      and with_check like '%bucket_id <>%'
  ) then
    raise exception '[STORAGE RLS] bucket-scoped restrictive deny policy is missing or incomplete';
  end if;
  if coalesce((select rolbypassrls from pg_roles where rolname = 'service_role'), false) is not true then
    raise exception '[STORAGE RLS] service_role does not bypass RLS; verify server-side Storage access before deployment';
  end if;

  -- Directly inserting paid data without verified files/pricing must hit the CHECK constraint.
  rejected := false;
  begin
    insert into public.amuhon_orders (id, idempotency_key, status, customer, book_snapshot)
    values (draft_id, idem, 'paid', '{}'::jsonb, '{}'::jsonb);
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then raise exception '[PAYMENT GATE] paid order without verified files/price was accepted'; end if;

  first_result := public.create_amuhon_order_draft(
    draft_id, idem, '{"name":"test"}'::jsonb, '{"title":"test"}'::jsonb, 24, rate_key, 30
  );
  retry_result := public.create_amuhon_order_draft(
    gen_random_uuid(), idem, '{"name":"changed"}'::jsonb, '{"title":"changed"}'::jsonb, 32, rate_key, 30
  );
  if first_result->>'id' is distinct from retry_result->>'id' or
     first_result->>'created' is distinct from 'true' or retry_result->>'created' is distinct from 'false' then
    raise exception '[IDEMPOTENCY] retry did not return the original safe order result';
  end if;

  test_order_id := (first_result->>'id')::uuid;
  rejected := false;
  begin
    update public.amuhon_orders set status = 'paid' where id = test_order_id;
  exception when raise_exception then
    if sqlerrm = 'INVALID_ORDER_STATUS_TRANSITION' then rejected := true; else raise; end if;
  end;
  if not rejected then raise exception '[STATE TRANSITION] invalid draft-to-paid transition was accepted'; end if;
  update public.amuhon_orders set status = 'preparing' where id = test_order_id;
  rejected := false;
  begin
    update public.amuhon_orders set customer = '{"changed":true}'::jsonb where id = test_order_id;
  exception when raise_exception then
    if sqlerrm = 'CONFIRMED_ORDER_CONTENT_IS_IMMUTABLE' then rejected := true; else raise; end if;
  end;
  if not rejected then raise exception '[IMMUTABILITY] preparing order contents were mutable'; end if;
  rejected := false;
  begin
    update public.amuhon_orders set status = 'ready_for_payment' where id = test_order_id;
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then raise exception '[PAYMENT GATE] preparing order without verified assets entered payment-ready state'; end if;

  -- A fresh rate key admits five orders in the window and rejects the sixth.
  rate_key := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  for i in 1..5 loop
    perform public.create_amuhon_order_draft(
      gen_random_uuid(), gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, null, rate_key, 30
    );
  end loop;
  rejected := false;
  begin
    perform public.create_amuhon_order_draft(
      gen_random_uuid(), gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, null, rate_key, 30
    );
  exception when raise_exception then
    if sqlerrm = 'ORDER_RATE_LIMITED' then rejected := true; else raise; end if;
  end;
  if not rejected then raise exception '[RATE LIMIT] sixth draft request was not rejected'; end if;
end;
$security_tests$;

select 'ALL TESTS PASSED' as result;

rollback;
