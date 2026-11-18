begin;

-- Extend operator fulfillment tracking without changing payment state. A
-- printer order is recorded only after the operator confirms that the vendor
-- accepted the order. Every state transition is audited.
alter table public.amuhon_orders
  add column if not exists printer_order_number text;

alter table public.amuhon_orders
  drop constraint if exists amuhon_orders_printer_submission_status;
alter table public.amuhon_orders
  add constraint amuhon_orders_printer_submission_status
  check (printer_submission_status in ('not_submitted', 'processing', 'on_hold', 'submitted', 'shipped'));

alter table public.amuhon_orders
  drop constraint if exists amuhon_orders_printer_submission_audit_pair;
alter table public.amuhon_orders
  add constraint amuhon_orders_printer_submission_audit_pair
  check (
    (printer_submitted_at is null) = (printer_submitted_by is null)
    and ((printer_submission_status in ('submitted', 'shipped')) =
      (printer_submitted_at is not null and printer_submitted_by is not null))
    and (printer_order_number is null or length(btrim(printer_order_number)) between 1 and 100)
  );

create unique index if not exists amuhon_orders_printer_order_number_unique
  on public.amuhon_orders (printer_order_number)
  where printer_order_number is not null;

create table if not exists public.amuhon_order_fulfillment_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.amuhon_orders(id) on delete restrict,
  previous_status text not null check (previous_status in ('not_submitted', 'processing', 'on_hold', 'submitted')),
  next_status text not null check (next_status in ('processing', 'on_hold', 'submitted', 'shipped')),
  printer_order_number text,
  admin_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint amuhon_fulfillment_event_order_number_shape check (
    (next_status in ('submitted', 'shipped')) = (printer_order_number is not null)
  )
);
create index if not exists amuhon_order_fulfillment_events_order_idx
  on public.amuhon_order_fulfillment_events (order_id, created_at, id);
alter table public.amuhon_order_fulfillment_events enable row level security;
revoke all on public.amuhon_order_fulfillment_events from public, anon, authenticated, service_role;

create or replace function public._amuhon_order_print_assets_ready_v1(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  render_state text;
  paths_valid boolean;
begin
  select * into target from public.amuhon_orders where id = p_order_id;
  if not found or target.status <> 'paid' then return false; end if;

  select state into render_state
    from public.amuhon_order_pdf_render_jobs
   where order_id = p_order_id;
  if render_state is distinct from 'succeeded' then return false; end if;

  paths_valid :=
    (target.body_pdf_storage_path = target.id::text || '/body.pdf' and
     target.cover_png_storage_path = target.id::text || '/cover.png') or
    (target.body_pdf_storage_path ~ ('^' || target.id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/body[.]pdf$') and
     target.cover_png_storage_path = regexp_replace(target.body_pdf_storage_path, '/body[.]pdf$', '/cover.png'));

  return coalesce(target.files_validated_at is not null and
    target.body_pdf_page_count between 24 and 300 and target.body_pdf_page_count % 8 = 0 and
    (target.declared_body_pdf_page_count is null or target.declared_body_pdf_page_count = target.body_pdf_page_count) and
    target.body_pdf_sha256 ~ '^[a-f0-9]{64}$' and target.cover_png_sha256 ~ '^[a-f0-9]{64}$' and
    target.body_pdf_size_bytes between 1 and 40000000 and target.cover_png_size_bytes between 1 and 40000000 and
    coalesce(paths_valid, false) and
    public._amuhon_book_works_rights_approved_v1(target.book_snapshot -> 'works', true), false);
exception when others then
  return false;
end;
$$;
revoke all on function public._amuhon_order_print_assets_ready_v1(uuid) from public, anon, authenticated, service_role;

create or replace function public.get_amuhon_admin_order_production_readiness_v1(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  render_state text;
  rights_approved boolean;
  assets_ready boolean;
begin
  select * into target from public.amuhon_orders where id = p_order_id;
  if not found then return null; end if;
  select state into render_state from public.amuhon_order_pdf_render_jobs where order_id = p_order_id;
  rights_approved := public._amuhon_book_works_rights_approved_v1(target.book_snapshot -> 'works', true);
  assets_ready := public._amuhon_order_print_assets_ready_v1(p_order_id);
  return jsonb_build_object(
    'rightsApproved', rights_approved,
    'assetsReady', assets_ready,
    'renderState', coalesce(render_state, case when target.status = 'paid' then 'not_queued' else 'not_applicable' end),
    'pageCount', target.body_pdf_page_count,
    'spineWidthMm', case when target.body_pdf_page_count between 24 and 300
      then round((0.06 * target.body_pdf_page_count + 0.5)::numeric, 2) else null end,
    'fulfillmentStatus', target.printer_submission_status,
    'printerOrderNumber', target.printer_order_number,
    'submittedAt', target.printer_submitted_at
  );
end;
$$;
revoke all on function public.get_amuhon_admin_order_production_readiness_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_admin_order_production_readiness_v1(uuid) to service_role;

create or replace function public.get_amuhon_admin_order_fulfillment_audit_v1(p_order_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'events', coalesce(jsonb_agg(jsonb_build_object(
      'from', previous_status,
      'to', next_status,
      'printerOrderNumber', printer_order_number,
      'adminUserId', admin_user_id,
      'createdAt', created_at
    ) order by created_at, id), '[]'::jsonb)
  )
  from public.amuhon_order_fulfillment_events
  where order_id = p_order_id;
$$;
revoke all on function public.get_amuhon_admin_order_fulfillment_audit_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_admin_order_fulfillment_audit_v1(uuid) to service_role;

create or replace function public.mark_amuhon_order_printer_submitted_v2(
  p_order_id uuid,
  p_admin_user_id uuid,
  p_next_status text,
  p_printer_order_number text,
  p_vendor_order_confirmed boolean
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  changed_at timestamptz := clock_timestamp();
  valid_transition boolean := false;
begin
  if p_order_id is null or p_admin_user_id is null or
     p_next_status not in ('processing', 'on_hold', 'submitted', 'shipped') then
    raise exception using errcode = 'P0001', message = 'FULFILLMENT_INPUT_INVALID';
  end if;
  if p_next_status in ('submitted', 'shipped') and
     (p_vendor_order_confirmed is distinct from true or
      p_printer_order_number is null or p_printer_order_number !~ '^[[:alnum:]][[:alnum:] _./-]{0,99}$') then
    raise exception using errcode = 'P0001', message = 'VENDOR_CONFIRMATION_REQUIRED';
  end if;
  if p_next_status in ('processing', 'on_hold') and p_printer_order_number is not null then
    raise exception using errcode = 'P0001', message = 'FULFILLMENT_INPUT_INVALID';
  end if;

  select * into target from public.amuhon_orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if p_next_status = 'shipped' and p_printer_order_number is distinct from target.printer_order_number then
    raise exception using errcode = 'P0001', message = 'PRINTER_ORDER_NUMBER_MISMATCH';
  end if;
  if target.status <> 'paid' then raise exception using errcode = 'P0001', message = 'ORDER_NOT_PAID'; end if;

  valid_transition :=
    (target.printer_submission_status = 'not_submitted' and p_next_status in ('processing', 'on_hold', 'submitted')) or
    (target.printer_submission_status = 'processing' and p_next_status in ('on_hold', 'submitted')) or
    (target.printer_submission_status = 'on_hold' and p_next_status in ('processing', 'submitted')) or
    (target.printer_submission_status = 'submitted' and p_next_status = 'shipped');
  if not valid_transition then
    if target.printer_submission_status = p_next_status then
      return jsonb_build_object('state', 'unchanged', 'fulfillmentStatus', target.printer_submission_status);
    end if;
    raise exception using errcode = 'P0001', message = 'FULFILLMENT_TRANSITION_INVALID';
  end if;
  -- Operators must be able to put a paid but blocked order on hold without
  -- making it eligible for download or printer submission. All forward
  -- production transitions still require verified assets and approved rights.
  if p_next_status <> 'on_hold' and not public._amuhon_order_print_assets_ready_v1(p_order_id) then
    raise exception using errcode = 'P0001', message = 'PRINT_ASSETS_NOT_READY';
  end if;

  update public.amuhon_orders set
    printer_submission_status = p_next_status,
    printer_order_number = case when p_next_status in ('submitted', 'shipped') then p_printer_order_number else printer_order_number end,
    printer_submitted_at = case when p_next_status = 'submitted' then changed_at else printer_submitted_at end,
    printer_submitted_by = case when p_next_status = 'submitted' then p_admin_user_id else printer_submitted_by end
  where id = p_order_id;

  insert into public.amuhon_order_fulfillment_events (
    order_id, previous_status, next_status, printer_order_number, admin_user_id, created_at
  ) values (
    p_order_id, target.printer_submission_status, p_next_status,
    case when p_next_status in ('submitted', 'shipped') then p_printer_order_number else null end,
    p_admin_user_id, changed_at
  );
  return jsonb_build_object('state', 'updated', 'fulfillmentStatus', p_next_status, 'changedAt', changed_at);
end;
$$;
revoke all on function public.mark_amuhon_order_printer_submitted_v2(uuid, uuid, text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.mark_amuhon_order_printer_submitted_v2(uuid, uuid, text, text, boolean) to service_role;

-- Disable the old two-argument RPC so older route code cannot falsely mark an
-- order submitted without the printer's confirmed order number.
create or replace function public.mark_amuhon_order_printer_submitted(p_order_id uuid, p_admin_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = 'P0001', message = 'LEGACY_SUBMISSION_RPC_DISABLED';
end;
$$;
revoke all on function public.mark_amuhon_order_printer_submitted(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.mark_amuhon_order_printer_submitted(uuid, uuid) to service_role;

-- Asset lookup remains private and now additionally requires successful
-- server rendering and edition-specific commercial-rights approval.
create or replace function public.get_amuhon_admin_order_asset(p_order_id uuid, p_asset_kind text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  object_path text;
  expected_digest text;
  content_type text;
begin
  if p_asset_kind not in ('body_pdf', 'cover_png') or
     not public._amuhon_order_print_assets_ready_v1(p_order_id) then return null; end if;
  select * into target from public.amuhon_orders where id = p_order_id;
  if not found then return null; end if;
  if p_asset_kind = 'body_pdf' then
    object_path := target.body_pdf_storage_path;
    expected_digest := target.body_pdf_sha256;
    content_type := 'application/pdf';
  else
    object_path := target.cover_png_storage_path;
    expected_digest := target.cover_png_sha256;
    content_type := 'image/png';
  end if;
  return jsonb_build_object('storagePath', object_path, 'sha256', expected_digest, 'contentType', content_type);
end;
$$;
revoke all on function public.get_amuhon_admin_order_asset(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_admin_order_asset(uuid, text) to service_role;

notify pgrst, 'reload schema';
commit;
