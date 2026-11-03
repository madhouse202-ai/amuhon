-- Minimal operator-only order review and manual printer-submission state.
-- Apply after 20261103000100_order_stripe_checkout.sql. The service-role RPCs
-- are intended to be called only by server routes after Supabase Auth and the
-- server-side AMUHON_ADMIN_USER_ID allowlist have both been checked.

alter table public.amuhon_orders
  add column if not exists printer_submission_status text not null default 'not_submitted',
  add column if not exists printer_submitted_at timestamptz,
  add column if not exists printer_submitted_by uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.amuhon_orders'::regclass
      and conname = 'amuhon_orders_printer_submission_status'
  ) then
    alter table public.amuhon_orders add constraint amuhon_orders_printer_submission_status
      check (printer_submission_status in ('not_submitted', 'submitted'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.amuhon_orders'::regclass
      and conname = 'amuhon_orders_printer_submission_audit_pair'
  ) then
    alter table public.amuhon_orders add constraint amuhon_orders_printer_submission_audit_pair
      check (
        (printer_submission_status = 'submitted') =
        (printer_submitted_at is not null and printer_submitted_by is not null)
      );
  end if;
end;
$$;

create or replace function public.get_amuhon_admin_order_list()
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'orders', coalesce(jsonb_agg(items.order_json order by items.created_at desc), '[]'::jsonb)
  )
  from (
    select
      created_at,
      jsonb_build_object(
        'id', id,
        'orderNumber', 'AMU-' || to_char(created_at, 'YYYYMMDD') || '-' || upper(substr(replace(id::text, '-', ''), 1, 8)),
        'title', book_snapshot ->> 'title',
        'pageCount', body_pdf_page_count,
        'amountYen', amount_minor,
        'currency', currency,
        'paymentStatus', status,
        'fulfillmentStatus', printer_submission_status,
        'createdAt', created_at
      ) as order_json
    from public.amuhon_orders
    order by created_at desc
    limit 200
  ) as items;
$$;
revoke all on function public.get_amuhon_admin_order_list() from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_admin_order_list() to service_role;

create or replace function public.get_amuhon_admin_order_detail(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  verified_assets boolean;
  asset_paths_verified boolean;
  works jsonb;
begin
  select * into target from public.amuhon_orders where id = p_order_id;
  if not found then return null; end if;

  asset_paths_verified :=
    (target.body_pdf_storage_path = target.id::text || '/body.pdf' and
     target.cover_png_storage_path = target.id::text || '/cover.png') or
    (target.body_pdf_storage_path ~ ('^' || target.id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/body[.]pdf$') and
     target.cover_png_storage_path = regexp_replace(target.body_pdf_storage_path, '/body[.]pdf$', '/cover.png'));
  verified_assets := target.files_validated_at is not null and
    target.body_pdf_page_count is not null and target.body_pdf_page_count > 0 and
    (target.declared_body_pdf_page_count is null or target.declared_body_pdf_page_count = target.body_pdf_page_count) and
    coalesce(asset_paths_verified, false) and
    target.body_pdf_sha256 ~ '^[a-f0-9]{64}$' and
    target.cover_png_sha256 ~ '^[a-f0-9]{64}$';

  select coalesce(jsonb_agg(
    jsonb_build_object('title', item.work ->> 'title', 'author', item.work ->> 'author')
    order by item.ordinality
  ), '[]'::jsonb)
  into works
  from jsonb_array_elements(
    case when jsonb_typeof(target.book_snapshot -> 'works') = 'array'
      then target.book_snapshot -> 'works' else '[]'::jsonb end
  ) with ordinality as item(work, ordinality);

  return jsonb_build_object(
    'id', target.id,
    'orderNumber', 'AMU-' || to_char(target.created_at, 'YYYYMMDD') || '-' || upper(substr(replace(target.id::text, '-', ''), 1, 8)),
    'title', target.book_snapshot ->> 'title',
    'works', works,
    'pageCount', target.body_pdf_page_count,
    'amountYen', target.amount_minor,
    'currency', target.currency,
    'paymentStatus', target.status,
    'assetsVerified', coalesce(verified_assets, false),
    'canDownloadAssets', target.status = 'paid' and coalesce(verified_assets, false),
    'fulfillmentStatus', target.printer_submission_status,
    'submittedAt', target.printer_submitted_at,
    'customer', jsonb_build_object(
      'name', target.customer ->> 'name',
      'postalCode', target.customer ->> 'postalCode',
      'prefecture', target.customer ->> 'prefecture',
      'city', target.customer ->> 'city',
      'address', target.customer ->> 'address',
      'phone', target.customer ->> 'phone',
      'email', target.customer ->> 'email'
    )
  );
end;
$$;
revoke all on function public.get_amuhon_admin_order_detail(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_admin_order_detail(uuid) to service_role;

create or replace function public.get_amuhon_admin_order_asset(
  p_order_id uuid,
  p_asset_kind text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  verified_assets boolean;
  asset_paths_verified boolean;
  object_path text;
  expected_digest text;
  content_type text;
begin
  if p_asset_kind not in ('body_pdf', 'cover_png') then return null; end if;
  select * into target from public.amuhon_orders where id = p_order_id;
  if not found or target.status <> 'paid' then return null; end if;

  asset_paths_verified :=
    (target.body_pdf_storage_path = target.id::text || '/body.pdf' and
     target.cover_png_storage_path = target.id::text || '/cover.png') or
    (target.body_pdf_storage_path ~ ('^' || target.id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/body[.]pdf$') and
     target.cover_png_storage_path = regexp_replace(target.body_pdf_storage_path, '/body[.]pdf$', '/cover.png'));
  verified_assets := target.files_validated_at is not null and
    target.body_pdf_page_count is not null and target.body_pdf_page_count > 0 and
    (target.declared_body_pdf_page_count is null or target.declared_body_pdf_page_count = target.body_pdf_page_count) and
    coalesce(asset_paths_verified, false) and
    target.body_pdf_sha256 ~ '^[a-f0-9]{64}$' and
    target.cover_png_sha256 ~ '^[a-f0-9]{64}$';
  if not coalesce(verified_assets, false) then return null; end if;

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

create or replace function public.mark_amuhon_order_printer_submitted(
  p_order_id uuid,
  p_admin_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target public.amuhon_orders%rowtype;
  verified_assets boolean;
  asset_paths_verified boolean;
begin
  if p_admin_user_id is null then raise exception 'ADMIN_AUDIT_ID_REQUIRED'; end if;
  select * into target from public.amuhon_orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if target.printer_submission_status = 'submitted' then
    return jsonb_build_object('state', 'already_submitted', 'submittedAt', target.printer_submitted_at);
  end if;
  if target.status <> 'paid' then raise exception 'ORDER_NOT_PAID'; end if;

  asset_paths_verified :=
    (target.body_pdf_storage_path = target.id::text || '/body.pdf' and
     target.cover_png_storage_path = target.id::text || '/cover.png') or
    (target.body_pdf_storage_path ~ ('^' || target.id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/body[.]pdf$') and
     target.cover_png_storage_path = regexp_replace(target.body_pdf_storage_path, '/body[.]pdf$', '/cover.png'));
  verified_assets := target.files_validated_at is not null and
    target.body_pdf_page_count is not null and target.body_pdf_page_count > 0 and
    (target.declared_body_pdf_page_count is null or target.declared_body_pdf_page_count = target.body_pdf_page_count) and
    coalesce(asset_paths_verified, false) and
    target.body_pdf_sha256 ~ '^[a-f0-9]{64}$' and
    target.cover_png_sha256 ~ '^[a-f0-9]{64}$';
  if not coalesce(verified_assets, false) then raise exception 'ORDER_ASSETS_NOT_VERIFIED'; end if;

  update public.amuhon_orders set
    printer_submission_status = 'submitted',
    printer_submitted_at = now(),
    printer_submitted_by = p_admin_user_id
  where id = p_order_id and printer_submission_status = 'not_submitted';

  return jsonb_build_object('state', 'submitted', 'submittedAt', now());
end;
$$;
revoke all on function public.mark_amuhon_order_printer_submitted(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.mark_amuhon_order_printer_submitted(uuid, uuid) to service_role;

comment on column public.amuhon_orders.printer_submission_status is
  'Manual fulfillment state, independent from payment status. Only paid orders with verified immutable assets may transition to submitted.';
comment on column public.amuhon_orders.printer_submitted_by is
  'Supabase Auth user UUID verified by the server-side administrator allowlist before the service-role RPC is called.';
