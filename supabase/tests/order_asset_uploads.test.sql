-- Verify the selected Dashboard project is amuhon-staging before running.
-- Uses only fresh synthetic UUIDs/keys; test writes are rolled back.
-- Stop if RPC-internal global cleanup could touch any pre-existing rows.
begin isolation level repeatable read;
do $asset_tests$
declare
  target_confirmation constant text := 'amuhon-staging';
  order_id uuid := gen_random_uuid();
  idem uuid := gen_random_uuid();
  lease_id uuid := gen_random_uuid();
  cleanup_lease uuid := gen_random_uuid();
  rate_key text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  asset_rate_key text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  limited_rate_key text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  token_hash text := repeat('a', 64);
  body_hash text := repeat('b', 64);
  cover_hash text := repeat('c', 64);
  result jsonb;
  claimed uuid[];
  rejected boolean;
  attempt integer;
  test_rate_key text;
begin
  if target_confirmation <> 'amuhon-staging' then raise exception 'STOP: wrong Supabase project'; end if;
  if to_regclass('public.amuhon_order_asset_rate_limits') is null or
     to_regprocedure('public.create_amuhon_order_draft_with_upload_token(uuid,uuid,jsonb,jsonb,integer,text,text,integer)') is null or
     to_regprocedure('public.begin_amuhon_order_asset_upload(uuid,text,text,uuid)') is null or
     to_regprocedure('public.finish_amuhon_order_asset_upload(uuid,text,uuid,integer,text,text)') is null or
     to_regprocedure('public.abort_amuhon_order_asset_upload(uuid,text,uuid)') is null or
     to_regprocedure('public.claim_stale_amuhon_order_asset_cleanup(uuid,integer)') is null or
     to_regprocedure('public.release_stale_amuhon_order_asset_cleanup(uuid,uuid[])') is null then
    raise exception '[SCHEMA] apply the order asset upload migration first';
  end if;
  -- Draft creation and upload start prune old rate-limit rows globally. Do not
  -- invoke those RPCs if any existing rate-limit row could be deleted.
  if exists (
    select 1 from public.amuhon_order_rate_limits where updated_at < now() - interval '24 hours'
  ) or exists (
    select 1 from public.amuhon_order_asset_rate_limits where updated_at < now() - interval '24 hours'
  ) then
    raise exception 'STOP: a production RPC would prune an existing rate-limit row; wait for approved cleanup or review the row first';
  end if;

  -- The cleanup-claim RPC leases every eligible stale preparing order, not a
  -- caller-selected order. Run this integration test only when none pre-exist.
  if exists (
    select 1 from public.amuhon_orders
    where status = 'preparing' and files_validated_at is null
      and (upload_lease_id is null or upload_lease_expires_at <= now())
  ) then
    raise exception 'STOP: cleanup RPC could lease a pre-existing stale preparing order';
  end if;

  -- Guard the random identifiers against existing data before any write.
  if exists (
    select 1 from public.amuhon_orders where id = order_id or idempotency_key = idem
  ) or exists (
    select 1 from public.amuhon_order_rate_limits where key_hash = rate_key
  ) or exists (
    select 1 from public.amuhon_order_asset_rate_limits where key_hash in (asset_rate_key, limited_rate_key)
  ) then
    raise exception 'STOP: a generated test identifier collided with existing data';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.amuhon_order_asset_rate_limits'::regclass) or
     has_table_privilege('anon', 'public.amuhon_order_asset_rate_limits', 'SELECT') or
     has_table_privilege('authenticated', 'public.amuhon_order_asset_rate_limits', 'SELECT') or
     has_table_privilege('service_role', 'public.amuhon_order_asset_rate_limits', 'SELECT') then
    raise exception '[RLS] asset rate-limit table protections are incorrect';
  end if;
  if exists (
    select 1 from pg_proc p
    where p.oid in (
      'public.create_amuhon_order_draft_with_upload_token(uuid,uuid,jsonb,jsonb,integer,text,text,integer)'::regprocedure,
      'public.begin_amuhon_order_asset_upload(uuid,text,text,uuid)'::regprocedure,
      'public.finish_amuhon_order_asset_upload(uuid,text,uuid,integer,text,text)'::regprocedure,
      'public.abort_amuhon_order_asset_upload(uuid,text,uuid)'::regprocedure,
      'public.claim_stale_amuhon_order_asset_cleanup(uuid,integer)'::regprocedure,
      'public.release_stale_amuhon_order_asset_cleanup(uuid,uuid[])'::regprocedure
    ) and (
      not p.prosecdef or pg_get_userbyid(p.proowner) <> 'postgres' or
      not (coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, pg_temp']) or
      has_function_privilege('anon', p.oid, 'EXECUTE') or
      has_function_privilege('authenticated', p.oid, 'EXECUTE') or
      not has_function_privilege('service_role', p.oid, 'EXECUTE') or
      exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
    )
  ) then raise exception '[RPC SECURITY/PRIVILEGES] owner, SECURITY DEFINER, search_path, or EXECUTE grants are incorrect'; end if;
  if (select "public" from storage.buckets where id = 'amuhon-order-files') is distinct from false or
     coalesce((select rolbypassrls from pg_roles where rolname = 'service_role'), false) is not true then
    raise exception '[STORAGE] bucket is not private or service_role bypass is unavailable';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'amuhon_order_files_deny_public_access'
      and permissive = 'RESTRICTIVE' and cmd = 'ALL'
      and roles @> array['public']::name[] and qual is not null and with_check is not null
      and qual like '%amuhon-order-files%' and with_check like '%amuhon-order-files%'
  ) then raise exception '[STORAGE RLS] restrictive private-bucket deny policy is missing or malformed'; end if;

  result := public.create_amuhon_order_draft_with_upload_token(
    order_id, idem, '{"name":"synthetic"}'::jsonb,
    '{"title":"synthetic","works":[]}'::jsonb, 24, rate_key, token_hash, 30
  );
  if result->>'status' <> 'draft' or result->>'uploadTokenAccepted' <> 'true' or
     (select upload_token_hash from public.amuhon_orders where id = order_id) <> token_hash then
    raise exception '[TOKEN] draft did not store only the upload capability hash';
  end if;
  rejected := false;
  begin
    perform public.begin_amuhon_order_asset_upload(order_id, repeat('d', 64), asset_rate_key, gen_random_uuid());
  exception when others then rejected := sqlerrm = 'UPLOAD_NOT_AUTHORIZED';
  end;
  if not rejected then raise exception '[TOKEN] wrong upload capability was accepted'; end if;

  result := public.begin_amuhon_order_asset_upload(order_id, token_hash, asset_rate_key, lease_id);
  if result->>'state' <> 'claimed' or (result->>'declaredPageCount')::integer <> 24 then
    raise exception '[LEASE] valid upload token did not claim the expected order';
  end if;
  result := public.finish_amuhon_order_asset_upload(order_id, token_hash, lease_id, 24, body_hash, cover_hash);
  if result->>'state' <> 'complete' then raise exception '[FINALIZE] file metadata was not finalized'; end if;
  result := public.finish_amuhon_order_asset_upload(order_id, token_hash, lease_id, 24, body_hash, cover_hash);
  if result->>'state' <> 'complete' then raise exception '[IDEMPOTENCY] repeated finalization failed'; end if;
  if (select status from public.amuhon_orders where id = order_id) <> 'preparing' or
     (select body_pdf_page_count from public.amuhon_orders where id = order_id) <> 24 or
     (select body_pdf_storage_path from public.amuhon_orders where id = order_id) <> order_id::text || '/body.pdf' or
     (select cover_png_storage_path from public.amuhon_orders where id = order_id) <> order_id::text || '/cover.png' or
     (select files_validated_at from public.amuhon_orders where id = order_id) is null then
    raise exception '[FINALIZE] verified files were not linked in preparing state';
  end if;
  rejected := false;
  begin
    update public.amuhon_orders set status = 'ready_for_payment' where id = order_id;
  exception when check_violation then rejected := true;
  end;
  if not rejected then raise exception '[PAYMENT GATE] unpriced order entered ready_for_payment'; end if;
  rejected := false;
  begin
    insert into public.amuhon_orders (
      id, idempotency_key, status, customer, book_snapshot
    ) values (gen_random_uuid(), gen_random_uuid(), 'paid', '{}'::jsonb, '{}'::jsonb);
  exception when check_violation then rejected := true;
  end;
  if not rejected then raise exception '[PAYMENT GATE] paid order without verified assets and price was accepted'; end if;

  order_id := gen_random_uuid();
  idem := gen_random_uuid();
  if exists (select 1 from public.amuhon_orders where id = order_id or idempotency_key = idem) then
    raise exception 'STOP: cleanup test identifier collided with existing order data';
  end if;
  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot, declared_body_pdf_page_count, upload_token_hash
  ) values (order_id, idem, 'draft', '{}'::jsonb, '{}'::jsonb, 24, token_hash)
  returning id into order_id;
  lease_id := gen_random_uuid();
  perform public.begin_amuhon_order_asset_upload(order_id, token_hash, asset_rate_key, lease_id);
  update public.amuhon_orders set upload_lease_expires_at = now() - interval '1 minute' where id = order_id;
  select array_agg(t.id) into claimed from public.claim_stale_amuhon_order_asset_cleanup(cleanup_lease, 50) as t(id);
  if claimed is null or not (order_id = any(claimed)) then raise exception '[CLEANUP] stale upload was not claimed'; end if;
  if public.release_stale_amuhon_order_asset_cleanup(cleanup_lease, claimed) < 1 then
    raise exception '[CLEANUP] stale upload lease was not released';
  end if;

  for attempt in 1..6 loop
    order_id := gen_random_uuid();
    idem := gen_random_uuid();
    test_rate_key := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
    if exists (select 1 from public.amuhon_orders where id = order_id or idempotency_key = idem) or
       exists (select 1 from public.amuhon_order_rate_limits where key_hash = test_rate_key) then
      raise exception 'STOP: rate-limit test identifier collided with existing data';
    end if;
    perform public.create_amuhon_order_draft_with_upload_token(
      order_id, idem, '{}'::jsonb, '{"title":"rate test"}'::jsonb,
      24, test_rate_key, token_hash, 30
    );
    rejected := false;
    begin
      perform public.begin_amuhon_order_asset_upload(
        order_id, token_hash, limited_rate_key, gen_random_uuid()
      );
    exception when others then
      rejected := sqlerrm = 'ORDER_FILE_RATE_LIMITED';
      if attempt <> 6 then raise; end if;
    end;
    if attempt <= 5 and rejected then raise exception '[RATE LIMIT] upload attempt % was rejected too early', attempt; end if;
    if attempt = 6 and not rejected then raise exception '[RATE LIMIT] sixth asset upload attempt was accepted'; end if;
  end loop;
end;
$asset_tests$;
select 'ALL TESTS PASSED' as result;
rollback;
