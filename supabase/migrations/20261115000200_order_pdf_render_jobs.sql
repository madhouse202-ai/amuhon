-- Add a separate post-payment PDF render queue. This does not change payment,
-- pricing, the existing upload-validation queue, or any already-paid order.

create table if not exists public.amuhon_order_pdf_render_jobs (
  order_id uuid primary key
    references public.amuhon_orders (id) on delete restrict,
  state text not null default 'queued'
    check (state in ('queued', 'rendering', 'succeeded', 'failed')),
  lease_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error_code text,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint amuhon_order_pdf_render_job_error_code check (
    error_code is null or error_code in (
      'aozora_unavailable', 'storage_unavailable', 'processing_timeout',
      'worker_unavailable', 'invalid_snapshot', 'invalid_render',
      'page_count_mismatch', 'internal_error'
    )
  ),
  constraint amuhon_order_pdf_render_job_state_shape check (
    (state = 'queued' and lease_id is null and lease_expires_at is null and completed_at is null) or
    (state = 'rendering' and lease_id is not null and lease_expires_at is not null and error_code is null and completed_at is null) or
    (state = 'succeeded' and lease_id is null and lease_expires_at is null and error_code is null and completed_at is not null) or
    (state = 'failed' and lease_id is null and lease_expires_at is null and error_code is not null and completed_at is null)
  )
);

create index if not exists amuhon_order_pdf_render_jobs_claim_idx
  on public.amuhon_order_pdf_render_jobs (created_at, order_id)
  where state in ('queued', 'rendering');
create unique index if not exists amuhon_order_pdf_render_jobs_lease_idx
  on public.amuhon_order_pdf_render_jobs (lease_id)
  where lease_id is not null;

alter table public.amuhon_order_pdf_render_jobs enable row level security;
revoke all on public.amuhon_order_pdf_render_jobs from public, anon, authenticated, service_role;

comment on table public.amuhon_order_pdf_render_jobs is
  'Private post-payment renderer queue. It never makes an order payable; a successful lease only replaces already-verified assets when the generated page count is unchanged.';

create or replace function public.enqueue_amuhon_order_pdf_render_after_paid()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status is distinct from new.status and new.status = 'paid' then
    insert into public.amuhon_order_pdf_render_jobs (order_id)
    values (new.id)
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.enqueue_amuhon_order_pdf_render_after_paid() from public, anon, authenticated, service_role;

drop trigger if exists enqueue_amuhon_order_pdf_render_after_paid on public.amuhon_orders;
create trigger enqueue_amuhon_order_pdf_render_after_paid
after update of status on public.amuhon_orders
for each row
when (old.status is distinct from new.status and new.status = 'paid')
execute function public.enqueue_amuhon_order_pdf_render_after_paid();

create or replace function public.claim_amuhon_order_pdf_render_job(
  p_lease_seconds integer default 900
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  candidate record;
  target_order public.amuhon_orders%rowtype;
  target_job public.amuhon_order_pdf_render_jobs%rowtype;
  checked_at timestamptz;
  new_lease_id uuid;
begin
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 1800 then
    raise exception 'INVALID_PDF_RENDER_LEASE';
  end if;

  -- Lock order -> render job, matching the paid-status trigger and commit/fail
  -- functions. Candidate discovery itself does not hold locks.
  for candidate in
    select jobs.order_id
    from public.amuhon_order_pdf_render_jobs as jobs
    where jobs.state = 'queued' or
      (jobs.state = 'rendering' and jobs.lease_expires_at <= clock_timestamp())
    order by jobs.created_at, jobs.order_id
    limit 100
  loop
    select * into target_order
    from public.amuhon_orders
    where id = candidate.order_id
    for update skip locked;
    if not found then continue; end if;

    select * into target_job
    from public.amuhon_order_pdf_render_jobs
    where order_id = candidate.order_id
    for update skip locked;
    if not found or not (
      target_job.state = 'queued' or
      (target_job.state = 'rendering' and target_job.lease_expires_at <= clock_timestamp())
    ) then
      continue;
    end if;

    checked_at := clock_timestamp();
    if target_job.attempt_count >= 5 then
      update public.amuhon_order_pdf_render_jobs set
        state = 'failed', lease_id = null, lease_expires_at = null,
        error_code = 'processing_timeout', updated_at = checked_at
      where order_id = candidate.order_id;
      continue;
    end if;

    if target_order.status <> 'paid' or target_order.files_validated_at is null or
       target_order.body_pdf_page_count is null or target_order.body_pdf_page_count < 24 or
       target_order.body_pdf_page_count > 300 or target_order.body_pdf_page_count % 8 <> 0 or
       nullif(btrim(target_order.body_pdf_storage_path), '') is null or
       nullif(btrim(target_order.cover_png_storage_path), '') is null or
       target_order.body_pdf_sha256 is null or target_order.body_pdf_sha256 !~ '^[a-f0-9]{64}$' or
       target_order.cover_png_sha256 is null or target_order.cover_png_sha256 !~ '^[a-f0-9]{64}$' or
       (target_order.declared_body_pdf_page_count is not null and
        target_order.declared_body_pdf_page_count <> target_order.body_pdf_page_count) or
       jsonb_typeof(target_order.book_snapshot) is distinct from 'object' or
       jsonb_typeof(target_order.book_snapshot -> 'works') is distinct from 'array' or
       (case when jsonb_typeof(target_order.book_snapshot -> 'works') = 'array'
         then jsonb_array_length(target_order.book_snapshot -> 'works') not between 1 and 100
         else true
        end) or
       jsonb_typeof(target_order.book_snapshot -> 'title') is distinct from 'string' or
       nullif(btrim(target_order.book_snapshot ->> 'title'), '') is null or
       jsonb_typeof(target_order.book_snapshot -> 'editor') is distinct from 'string' or
       nullif(btrim(target_order.book_snapshot ->> 'editor'), '') is null or
       jsonb_typeof(target_order.book_snapshot -> 'coverStyle') is distinct from 'string' or
       jsonb_typeof(target_order.book_snapshot -> 'coverColor') is distinct from 'string' then
      update public.amuhon_order_pdf_render_jobs set
        state = 'failed', lease_id = null, lease_expires_at = null,
        error_code = 'invalid_snapshot', updated_at = checked_at
      where order_id = candidate.order_id;
      continue;
    end if;

    new_lease_id := pg_catalog.gen_random_uuid();
    update public.amuhon_order_pdf_render_jobs set
      state = 'rendering', lease_id = new_lease_id,
      lease_expires_at = checked_at + pg_catalog.make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1,
      error_code = null,
      updated_at = checked_at
    where order_id = candidate.order_id
    returning * into target_job;

    -- Do not return customer, payment, upload-capability, or Storage data.
    return jsonb_build_object(
      'orderId', target_order.id,
      'leaseId', target_job.lease_id,
      'leaseExpiresAt', target_job.lease_expires_at,
      'attemptCount', target_job.attempt_count,
      'expectedBodyPdfPageCount', target_order.body_pdf_page_count,
      'bookSnapshot', jsonb_build_object(
        'title', target_order.book_snapshot ->> 'title',
        'editor', target_order.book_snapshot ->> 'editor',
        'coverStyle', target_order.book_snapshot ->> 'coverStyle',
        'coverColor', target_order.book_snapshot ->> 'coverColor',
        'works', target_order.book_snapshot -> 'works'
      )
    );
  end loop;
  return null;
end;
$$;
revoke all on function public.claim_amuhon_order_pdf_render_job(integer) from public, anon, authenticated;
grant execute on function public.claim_amuhon_order_pdf_render_job(integer) to service_role;

create or replace function public.fail_amuhon_order_pdf_render_job(
  p_order_id uuid,
  p_lease_id uuid,
  p_error_code text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_order public.amuhon_orders%rowtype;
  target_job public.amuhon_order_pdf_render_jobs%rowtype;
  retryable boolean;
begin
  if p_error_code is null or p_error_code not in (
    'aozora_unavailable', 'storage_unavailable', 'processing_timeout',
    'worker_unavailable', 'invalid_snapshot', 'invalid_render',
    'page_count_mismatch', 'internal_error'
  ) then
    raise exception 'INVALID_PDF_RENDER_ERROR_CODE';
  end if;

  select * into target_order from public.amuhon_orders where id = p_order_id for update;
  if not found then return false; end if;
  select * into target_job from public.amuhon_order_pdf_render_jobs where order_id = p_order_id for update;
  if not found or target_order.status <> 'paid' or target_job.state <> 'rendering' or
     target_job.lease_id is distinct from p_lease_id or target_job.lease_expires_at <= clock_timestamp() then
    return false;
  end if;

  retryable := p_error_code in ('aozora_unavailable', 'storage_unavailable', 'processing_timeout', 'worker_unavailable', 'internal_error')
    and target_job.attempt_count < 5;
  update public.amuhon_order_pdf_render_jobs set
    state = case when retryable then 'queued' else 'failed' end,
    lease_id = null,
    lease_expires_at = null,
    error_code = p_error_code,
    updated_at = clock_timestamp()
  where order_id = p_order_id;
  return true;
end;
$$;
revoke all on function public.fail_amuhon_order_pdf_render_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_amuhon_order_pdf_render_job(uuid, uuid, text) to service_role;

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

  select * into target_order from public.amuhon_orders where id = p_order_id for update;
  if not found then raise exception 'PDF_RENDER_ORDER_NOT_FOUND'; end if;
  select * into target_job from public.amuhon_order_pdf_render_jobs where order_id = p_order_id for update;
  if not found or target_order.status <> 'paid' or target_job.state <> 'rendering' or
     target_job.lease_id is distinct from p_lease_id or target_job.lease_expires_at <= v_completed_at then
    raise exception 'PDF_RENDER_LEASE_STALE';
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

create or replace function public.get_amuhon_admin_order_pdf_render_status(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  order_status text;
  target_job public.amuhon_order_pdf_render_jobs%rowtype;
begin
  select status into order_status from public.amuhon_orders where id = p_order_id;
  if not found then return null; end if;
  if order_status <> 'paid' then return jsonb_build_object('state', 'not_applicable'); end if;
  select * into target_job from public.amuhon_order_pdf_render_jobs where order_id = p_order_id;
  if not found then return jsonb_build_object('state', 'not_queued'); end if;
  return jsonb_build_object(
    'state', target_job.state,
    'attemptCount', target_job.attempt_count,
    'errorCode', target_job.error_code,
    'updatedAt', target_job.updated_at,
    'completedAt', target_job.completed_at
  );
end;
$$;
revoke all on function public.get_amuhon_admin_order_pdf_render_status(uuid) from public, anon, authenticated;
grant execute on function public.get_amuhon_admin_order_pdf_render_status(uuid) to service_role;

comment on function public.claim_amuhon_order_pdf_render_job(integer) is
  'Claims one eligible paid order with a bounded lease; returns only the immutable book snapshot, expected page count, order UUID, and lease UUID.';
comment on function public.complete_amuhon_order_pdf_render_job(uuid, uuid, text, text, integer, text, text, integer, integer) is
  'Atomically commits both verified private-storage object references only for the current paid-order lease and only when the generated page count is unchanged.';

notify pgrst, 'reload schema';
