-- Guest checkout foundation. Customer data is intentionally inaccessible to browser roles.
create table if not exists public.amuhon_orders (
  id uuid primary key,
  idempotency_key uuid not null unique,
  status text not null default 'draft'
    check (status in ('draft', 'preparing', 'ready_for_payment', 'paid', 'cancelled', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  draft_expires_at timestamptz not null default (now() + interval '30 days'),
  customer jsonb not null,
  book_snapshot jsonb not null,
  declared_body_pdf_page_count integer,
  body_pdf_page_count integer,
  body_pdf_storage_path text,
  cover_png_storage_path text,
  files_validated_at timestamptz,
  amount_minor bigint,
  shipping_minor bigint,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  stripe_payment_id text,
  constraint order_pages_nonnegative check (
    (declared_body_pdf_page_count is null or declared_body_pdf_page_count > 0) and
    (body_pdf_page_count is null or body_pdf_page_count > 0)
  ),
  constraint order_amounts_nonnegative check (
    (amount_minor is null or amount_minor >= 0) and
    (shipping_minor is null or shipping_minor >= 0)
  ),
  constraint ready_order_has_verified_assets check (
    status <> 'ready_for_payment' or (
      body_pdf_page_count is not null and body_pdf_storage_path is not null and
      cover_png_storage_path is not null and files_validated_at is not null and
      amount_minor is not null and currency is not null
    )
  )
);

create index if not exists amuhon_orders_status_created_idx
  on public.amuhon_orders (status, created_at desc);
create index if not exists amuhon_orders_expiry_idx
  on public.amuhon_orders (draft_expires_at) where status = 'draft';

create or replace function public.guard_amuhon_order_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status <> new.status and not (
    (old.status = 'draft' and new.status in ('preparing', 'cancelled', 'failed')) or
    (old.status = 'preparing' and new.status in ('ready_for_payment', 'cancelled', 'failed')) or
    (old.status = 'ready_for_payment' and new.status in ('paid', 'cancelled')) or
    (old.status = 'failed' and new.status in ('preparing', 'cancelled'))
  ) then
    raise exception 'INVALID_ORDER_STATUS_TRANSITION';
  end if;
  if old.status <> 'draft' and (
    old.customer is distinct from new.customer or
    old.book_snapshot is distinct from new.book_snapshot or
    old.declared_body_pdf_page_count is distinct from new.declared_body_pdf_page_count
  ) then
    raise exception 'CONFIRMED_ORDER_CONTENT_IS_IMMUTABLE';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists guard_amuhon_order_update on public.amuhon_orders;
create trigger guard_amuhon_order_update before update on public.amuhon_orders
for each row execute function public.guard_amuhon_order_update();

alter table public.amuhon_orders enable row level security;
revoke all on public.amuhon_orders from anon, authenticated;

-- Rate-limit buckets contain only an HMAC of the server-trusted client address.
create table if not exists public.amuhon_order_rate_limits (
  key_hash text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);
alter table public.amuhon_order_rate_limits enable row level security;
revoke all on public.amuhon_order_rate_limits from anon, authenticated;

create or replace function public.create_amuhon_order_draft(
  p_order_id uuid,
  p_idempotency_key uuid,
  p_customer jsonb,
  p_book_snapshot jsonb,
  p_declared_body_pdf_page_count integer,
  p_rate_limit_key_hash text,
  p_draft_retention_days integer default 30
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_order public.amuhon_orders%rowtype;
  bucket_count integer;
  inserted_order public.amuhon_orders%rowtype;
begin
  if p_draft_retention_days < 1 or p_draft_retention_days > 365 then
    raise exception 'INVALID_RETENTION_CONFIG';
  end if;
  if p_rate_limit_key_hash is null or length(p_rate_limit_key_hash) < 32 then
    raise exception 'INVALID_RATE_LIMIT_KEY';
  end if;

  -- Serialize duplicate submissions with the same key. Retries return only safe status fields.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into existing_order from public.amuhon_orders
    where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'id', existing_order.id,
      'status', existing_order.status,
      'createdAt', existing_order.created_at,
      'created', false
    );
  end if;

  delete from public.amuhon_order_rate_limits
    where updated_at < now() - interval '24 hours';

  insert into public.amuhon_order_rate_limits (key_hash, window_started_at, request_count)
  values (p_rate_limit_key_hash, now(), 1)
  on conflict (key_hash) do update set
    request_count = case
      when public.amuhon_order_rate_limits.window_started_at <= now() - interval '15 minutes' then 1
      else public.amuhon_order_rate_limits.request_count + 1
    end,
    window_started_at = case
      when public.amuhon_order_rate_limits.window_started_at <= now() - interval '15 minutes' then now()
      else public.amuhon_order_rate_limits.window_started_at
    end,
    updated_at = now()
  returning request_count into bucket_count;
  if bucket_count > 5 then
    raise exception using errcode = 'P0001', message = 'ORDER_RATE_LIMITED';
  end if;

  insert into public.amuhon_orders (
    id, idempotency_key, status, customer, book_snapshot,
    declared_body_pdf_page_count, draft_expires_at
  ) values (
    p_order_id, p_idempotency_key, 'draft', p_customer, p_book_snapshot,
    p_declared_body_pdf_page_count,
    now() + make_interval(days => p_draft_retention_days)
  ) returning * into inserted_order;

  return jsonb_build_object(
    'id', inserted_order.id,
    'status', inserted_order.status,
    'createdAt', inserted_order.created_at,
    'created', true
  );
end;
$$;

revoke all on function public.create_amuhon_order_draft(uuid, uuid, jsonb, jsonb, integer, text, integer) from public, anon, authenticated;
grant execute on function public.create_amuhon_order_draft(uuid, uuid, jsonb, jsonb, integer, text, integer) to service_role;

create or replace function public.purge_expired_amuhon_order_drafts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare removed_count integer;
begin
  delete from public.amuhon_orders
    where status = 'draft' and draft_expires_at <= now();
  get diagnostics removed_count = row_count;
  return removed_count;
end;
$$;
revoke all on function public.purge_expired_amuhon_order_drafts() from public, anon, authenticated;
grant execute on function public.purge_expired_amuhon_order_drafts() to service_role;

-- The bucket is private. No browser policies are created; uploads/downloads must use authorized server code.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('amuhon-order-files', 'amuhon-order-files', false, 62914560, array['application/pdf', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on column public.amuhon_orders.draft_expires_at is
  'Configurable draft retention deadline; purge expired drafts and related private objects with a scheduled server-side job.';
comment on column public.amuhon_orders.declared_body_pdf_page_count is
  'Untrusted browser-declared count for draft review only; never used for payment eligibility.';
comment on column public.amuhon_orders.body_pdf_page_count is
  'Server-verified final body PDF page count; remains NULL until PDF validation and private storage complete.';
