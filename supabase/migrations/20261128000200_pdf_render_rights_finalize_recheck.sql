begin;

-- A policy version referenced by an order is current only while it is the
-- single active version for that policy ID. Activation of a replacement must
-- suspend the prior version in the same reviewed transaction.
create unique index if not exists amuhon_aozora_rights_one_active_policy_version
  on public.amuhon_aozora_rights_policy_registry (policy_id)
  where policy_status = 'active';

-- Revalidate every linked work immediately before the worker commits generated
-- object references. The result may already exist in private Storage, but is
-- not an order asset until this transaction updates amuhon_orders.
create or replace function public.complete_amuhon_order_pdf_render_job(
  p_order_id uuid,
  p_lease_id uuid,
  p_body_object_key text,
  p_cover_object_key text,
  p_body_pdf_page_count integer,
  p_body_pdf_sha256 text,
  p_cover_png_sha256 text,
  p_body_pdf_size_bytes integer,
  p_cover_png_size_bytes integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_order public.amuhon_orders%rowtype;
  target_job public.amuhon_order_pdf_render_jobs%rowtype;
  target_work jsonb;
  v_completed_at timestamptz := clock_timestamp();
begin
  if p_order_id is null or p_lease_id is null or
     p_body_object_key is distinct from (p_order_id::text || '/' || p_lease_id::text || '/body.pdf') or
     p_cover_object_key is distinct from (p_order_id::text || '/' || p_lease_id::text || '/cover.png') or
     p_body_pdf_page_count is null or p_body_pdf_page_count < 24 or p_body_pdf_page_count > 300 or p_body_pdf_page_count % 8 <> 0 or
     p_body_pdf_sha256 is null or p_body_pdf_sha256 !~ '^[a-f0-9]{64}$' or
     p_cover_png_sha256 is null or p_cover_png_sha256 !~ '^[a-f0-9]{64}$' or
     p_body_pdf_size_bytes is null or p_body_pdf_size_bytes < 1 or p_body_pdf_size_bytes > 40000000 or
     p_cover_png_size_bytes is null or p_cover_png_size_bytes < 1 or p_cover_png_size_bytes > 40000000 then
    raise exception 'INVALID_PDF_RENDER_OUTPUT';
  end if;

  -- Keep the existing order -> job lock order used by claim/fail and the paid
  -- transition. The service-role worker is the only caller of this function.
  select * into target_order from public.amuhon_orders where id = p_order_id for update;
  if not found then raise exception 'PDF_RENDER_ORDER_NOT_FOUND'; end if;
  select * into target_job from public.amuhon_order_pdf_render_jobs where order_id = p_order_id for update;
  if not found or target_order.status <> 'paid' or target_job.state <> 'rendering' or
     target_job.lease_id is distinct from p_lease_id or target_job.lease_expires_at <= v_completed_at then
    raise exception 'PDF_RENDER_LEASE_STALE';
  end if;

  -- Scope/policy and the legacy ledger are operator-managed SQL data. These
  -- short SHARE locks serialize their changes with this final decision, so a
  -- concurrent suspension or revocation is seen either before or after this
  -- transaction, never half-way through finalization.
  lock table public.amuhon_aozora_rights_policy_registry in share mode;
  lock table public.amuhon_aozora_rights_scope_batches in share mode;
  lock table public.amuhon_aozora_rights_scope_members in share mode;
  lock table public.amuhon_work_commercial_rights in share mode;
  lock table public.amuhon_work_rights_holders in share mode;

  -- Match the per-work advisory lock used by set_amuhon_work_rights_manual_stop_v1
  -- and by claim. Stable ordering prevents deadlocks for multi-work books.
  if jsonb_typeof(target_order.book_snapshot -> 'works') = 'array' then
    for target_work in
      select item.value
      from jsonb_array_elements(target_order.book_snapshot -> 'works') as item(value)
      where jsonb_typeof(item.value) = 'object'
        and coalesce(item.value ->> 'id', '') ~ '^[0-9]{1,12}$'
      order by item.value ->> 'id'
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(target_work ->> 'id', 0)
      );
    end loop;
  end if;

  -- A manual stop is temporary: release the lease and return the job to the
  -- queue without charging a render attempt. It can run after an operator
  -- records a resume event. The uploaded attempt-specific objects are still
  -- unlinked and the worker will remove them best-effort.
  if public._amuhon_book_works_manual_stop_active_v1(target_order.book_snapshot -> 'works') then
    update public.amuhon_order_pdf_render_jobs set
      state = 'queued', lease_id = null, lease_expires_at = null,
      attempt_count = greatest(attempt_count - 1, 0), error_code = null,
      updated_at = v_completed_at
    where order_id = p_order_id;
    return jsonb_build_object('state', 'rights_stopped');
  end if;

  -- This shared helper validates the current policy registry, latest approved
  -- work scope, order-linked rights snapshot/notice, legacy edition approval,
  -- and manual stop. A permanent mismatch is terminal and never updates the
  -- order's formal asset references.
  if not public._amuhon_book_works_rights_approved_v1(target_order.book_snapshot -> 'works', true) then
    update public.amuhon_order_pdf_render_jobs set
      state = 'failed', lease_id = null, lease_expires_at = null,
      error_code = 'rights_ineligible', updated_at = v_completed_at
    where order_id = p_order_id;
    return jsonb_build_object('state', 'rights_ineligible');
  end if;

  if target_order.files_validated_at is null or target_order.body_pdf_page_count is distinct from p_body_pdf_page_count or
     (target_order.declared_body_pdf_page_count is not null and
      target_order.declared_body_pdf_page_count <> p_body_pdf_page_count) then
    raise exception 'PDF_RENDER_PAGE_COUNT_MISMATCH';
  end if;

  update public.amuhon_orders set
    body_pdf_storage_path = p_body_object_key,
    cover_png_storage_path = p_cover_object_key,
    body_pdf_page_count = p_body_pdf_page_count,
    body_pdf_sha256 = p_body_pdf_sha256,
    cover_png_sha256 = p_cover_png_sha256,
    body_pdf_size_bytes = p_body_pdf_size_bytes,
    cover_png_size_bytes = p_cover_png_size_bytes,
    files_validated_at = v_completed_at
  where id = p_order_id;

  update public.amuhon_order_pdf_render_jobs set
    state = 'succeeded', lease_id = null, lease_expires_at = null,
    error_code = null, completed_at = v_completed_at, updated_at = v_completed_at
  where order_id = p_order_id;
  return jsonb_build_object('state', 'succeeded');
end;
$$;
revoke all on function public.complete_amuhon_order_pdf_render_job(uuid, uuid, text, text, integer, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.complete_amuhon_order_pdf_render_job(uuid, uuid, text, text, integer, text, text, integer, integer) to service_role;

comment on function public.complete_amuhon_order_pdf_render_job(uuid, uuid, text, text, integer, text, text, integer, integer) is
  'Rechecks current rights under serialized locks before atomically linking verified private assets to a paid order; rights-stopped jobs are requeued and ineligible jobs fail closed.';

notify pgrst, 'reload schema';
commit;
