begin;

-- Commercial use is an explicit, edition-specific curation decision. No
-- catalog row is seeded or implicitly approved by this migration.
create table if not exists public.amuhon_work_commercial_rights (
  work_id text not null check (work_id ~ '^[0-9]{1,12}$'),
  text_edition_ref text not null check (length(btrim(text_edition_ref)) between 1 and 500),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  title text not null check (length(btrim(title)) between 1 and 500),
  author text not null check (length(btrim(author)) <= 300),
  card_url text not null check (card_url ~ '^https://(www\.)?aozora\.gr\.jp/cards/'),
  text_url text not null check (text_url ~ '^https://(www\.)?aozora\.gr\.jp/cards/'),
  xhtml_url text not null check (xhtml_url ~ '^https://(www\.)?aozora\.gr\.jp/cards/'),
  catalog_contributors jsonb not null check (jsonb_typeof(catalog_contributors) = 'array'),
  catalog_source_metadata jsonb not null check (jsonb_typeof(catalog_source_metadata) = 'object'),
  status text not null check (status in ('A', 'B', 'C')),
  evidence_basis text not null check (length(btrim(evidence_basis)) between 1 and 4000),
  checked_at timestamptz not null,
  checked_by text not null check (length(btrim(checked_by)) between 1 and 200),
  rights_reviews_complete boolean not null default false,
  permission_conditions text not null check (length(btrim(permission_conditions)) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (work_id, xhtml_url, source_sha256),
  constraint amuhon_work_rights_audit_complete check (
    status <> 'A' or (
      length(btrim(evidence_basis)) > 0 and checked_at is not null and
      length(btrim(coalesce(checked_by, ''))) > 0 and rights_reviews_complete
    )
  )
);

create table if not exists public.amuhon_work_rights_holders (
  work_id text not null,
  xhtml_url text not null,
  source_sha256 text not null,
  person_name text not null check (length(btrim(person_name)) between 1 and 300),
  role text not null check (length(btrim(role)) between 1 and 80),
  status text not null check (status in ('A', 'B', 'C')),
  evidence_basis text not null check (length(btrim(evidence_basis)) between 1 and 4000),
  checked_at timestamptz not null,
  checked_by text not null check (length(btrim(checked_by)) between 1 and 200),
  permission_conditions text not null check (length(btrim(permission_conditions)) between 1 and 1000),
  primary key (work_id, xhtml_url, source_sha256, person_name, role),
  foreign key (work_id, xhtml_url, source_sha256)
    references public.amuhon_work_commercial_rights(work_id, xhtml_url, source_sha256)
    on delete restrict,
  constraint amuhon_work_rights_holder_audit_complete check (
    status <> 'A' or (
      length(btrim(evidence_basis)) > 0 and checked_at is not null and
      length(btrim(coalesce(checked_by, ''))) > 0
    )
  )
);

-- Existing queue migration is already deployed independently. Extend its
-- bounded failure vocabulary in this additive migration only.
alter table public.amuhon_order_pdf_render_jobs
  drop constraint if exists amuhon_order_pdf_render_job_error_code;
alter table public.amuhon_order_pdf_render_jobs
  add constraint amuhon_order_pdf_render_job_error_code
  check (error_code is null or error_code in (
    'aozora_unavailable', 'storage_unavailable', 'processing_timeout',
    'worker_unavailable', 'invalid_snapshot', 'invalid_render',
    'page_count_mismatch', 'internal_error', 'rights_unverified'
  ));

alter table public.amuhon_work_commercial_rights enable row level security;
alter table public.amuhon_work_rights_holders enable row level security;
revoke all on public.amuhon_work_commercial_rights from public, anon, authenticated, service_role;
revoke all on public.amuhon_work_rights_holders from public, anon, authenticated, service_role;

create or replace function public._amuhon_book_works_rights_approved_v1(
  p_works jsonb,
  p_require_notice boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_work jsonb;
  approved_work_count integer := 0;
  contributor_count integer;
begin
  if jsonb_typeof(p_works) is distinct from 'array' or
     jsonb_array_length(p_works) not between 1 and 100 then
    return false;
  end if;

  for target_work in select item.value from jsonb_array_elements(p_works) as item(value) loop
    if jsonb_typeof(target_work) is distinct from 'object' or
       jsonb_typeof(target_work -> 'contributors') is distinct from 'array' or
       jsonb_typeof(target_work -> 'sourceMetadata') is distinct from 'object' or
       jsonb_array_length(target_work -> 'contributors') < 1 or
       coalesce(target_work ->> 'sourceSha256', '') !~ '^[a-f0-9]{64}$' then
      return false;
    end if;

    contributor_count := jsonb_array_length(target_work -> 'contributors');
    if not exists (
      select 1
      from public.amuhon_work_commercial_rights as rights
      where rights.work_id = target_work ->> 'id'
        and rights.title = target_work ->> 'title'
        and rights.author = target_work ->> 'author'
        and rights.card_url = target_work ->> 'cardUrl'
        and rights.text_url = target_work ->> 'textUrl'
        and rights.xhtml_url = target_work ->> 'xhtmlUrl'
        and rights.source_sha256 = target_work ->> 'sourceSha256'
        and rights.catalog_contributors = target_work -> 'contributors'
        and rights.catalog_source_metadata = target_work -> 'sourceMetadata'
        and rights.status = 'A'
        and length(btrim(rights.evidence_basis)) > 0
        and rights.checked_at is not null
        and length(btrim(coalesce(rights.checked_by, ''))) > 0
        and rights.rights_reviews_complete
        and length(btrim(rights.permission_conditions)) > 0
        and (not p_require_notice or rights.permission_conditions = target_work ->> 'rightsNotice')
        and (
          select count(*)
          from public.amuhon_work_rights_holders as holder
          where holder.work_id = rights.work_id
            and holder.xhtml_url = rights.xhtml_url
            and holder.source_sha256 = rights.source_sha256
        ) = contributor_count
        and not exists (
          select 1
          from jsonb_array_elements(target_work -> 'contributors') as contributor(value)
          where jsonb_typeof(contributor.value) is distinct from 'object'
             or nullif(btrim(contributor.value ->> 'name'), '') is null
             or nullif(btrim(contributor.value ->> 'role'), '') is null
             or not exists (
               select 1
               from public.amuhon_work_rights_holders as holder
               where holder.work_id = rights.work_id
                 and holder.xhtml_url = rights.xhtml_url
                 and holder.source_sha256 = rights.source_sha256
                 and holder.person_name = contributor.value ->> 'name'
                 and holder.role = contributor.value ->> 'role'
                 and holder.status = 'A'
                 and length(btrim(holder.evidence_basis)) > 0
                 and holder.checked_at is not null
                 and length(btrim(coalesce(holder.checked_by, ''))) > 0
                 and length(btrim(holder.permission_conditions)) > 0
             )
        )
    ) then
      return false;
    end if;
    approved_work_count := approved_work_count + 1;
  end loop;

  return approved_work_count = jsonb_array_length(p_works);
exception when others then
  return false;
end;
$$;
revoke all on function public._amuhon_book_works_rights_approved_v1(jsonb, boolean) from public, anon, authenticated, service_role;

create or replace function public.check_amuhon_works_commercial_rights_v1(p_works jsonb)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select case when public._amuhon_book_works_rights_approved_v1(p_works, false) then
    jsonb_build_object(
      'approved', true,
      'notices', coalesce((
        select jsonb_agg(jsonb_build_object(
          'workId', item.work ->> 'id',
          'sourceSha256', rights.source_sha256,
          'conditions', rights.permission_conditions
        ) order by item.ordinality)
        from jsonb_array_elements(p_works) with ordinality as item(work, ordinality)
        join public.amuhon_work_commercial_rights as rights
          on rights.work_id = item.work ->> 'id'
         and rights.xhtml_url = item.work ->> 'xhtmlUrl'
         and rights.source_sha256 = item.work ->> 'sourceSha256'
         and rights.title = item.work ->> 'title'
         and rights.author = item.work ->> 'author'
         and rights.card_url = item.work ->> 'cardUrl'
         and rights.text_url = item.work ->> 'textUrl'
         and rights.catalog_contributors = item.work -> 'contributors'
         and rights.catalog_source_metadata = item.work -> 'sourceMetadata'
         and rights.status = 'A'
      ), '[]'::jsonb)
    )
    else jsonb_build_object('approved', false, 'notices', '[]'::jsonb)
  end;
$$;
revoke all on function public.check_amuhon_works_commercial_rights_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.check_amuhon_works_commercial_rights_v1(jsonb) to service_role;

create or replace function public.check_amuhon_order_commercial_rights_v1(
  p_order_id uuid,
  p_upload_token_hash text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_snapshot jsonb;
  target_token_hash text;
begin
  if p_order_id is null or p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('approved', false);
  end if;
  select book_snapshot, upload_token_hash
    into target_snapshot, target_token_hash
    from public.amuhon_orders
   where id = p_order_id;
  if not found or target_token_hash is distinct from p_upload_token_hash then
    return jsonb_build_object('approved', false);
  end if;
  return jsonb_build_object(
    'approved', public._amuhon_book_works_rights_approved_v1(target_snapshot -> 'works', true)
  );
end;
$$;
revoke all on function public.check_amuhon_order_commercial_rights_v1(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.check_amuhon_order_commercial_rights_v1(uuid, text) to service_role;

create or replace function public.guard_amuhon_pdf_render_rights_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_snapshot jsonb;
  target_status text;
begin
  if new.state = 'rendering' and old.state is distinct from new.state then
    select book_snapshot, status
      into target_snapshot, target_status
      from public.amuhon_orders
     where id = new.order_id;
    if target_status is distinct from 'paid' or
       not public._amuhon_book_works_rights_approved_v1(target_snapshot -> 'works', true) then
      new.state := 'failed';
      new.lease_id := null;
      new.lease_expires_at := null;
      new.error_code := 'rights_unverified';
      new.completed_at := null;
      new.updated_at := clock_timestamp();
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_amuhon_pdf_render_rights_v1() from public, anon, authenticated, service_role;
drop trigger if exists guard_amuhon_pdf_render_rights_v1 on public.amuhon_order_pdf_render_jobs;
create trigger guard_amuhon_pdf_render_rights_v1
before update of state on public.amuhon_order_pdf_render_jobs
for each row execute function public.guard_amuhon_pdf_render_rights_v1();

-- Fail unapproved jobs as a fixed terminal queue state instead of throwing in
-- the claim RPC and leaving them queued to fail repeatedly on every run.
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

  for candidate in
    select jobs.order_id
    from public.amuhon_order_pdf_render_jobs as jobs
    where jobs.state = 'queued' or
      (jobs.state = 'rendering' and jobs.lease_expires_at <= clock_timestamp())
    order by jobs.created_at, jobs.order_id
    limit 100
  loop
    select * into target_order from public.amuhon_orders where id = candidate.order_id for update skip locked;
    if not found then continue; end if;
    select * into target_job from public.amuhon_order_pdf_render_jobs where order_id = candidate.order_id for update skip locked;
    if not found or not (target_job.state = 'queued' or
      (target_job.state = 'rendering' and target_job.lease_expires_at <= clock_timestamp())) then
      continue;
    end if;

    checked_at := clock_timestamp();
    if target_job.attempt_count >= 5 then
      update public.amuhon_order_pdf_render_jobs set state = 'failed', lease_id = null,
        lease_expires_at = null, error_code = 'processing_timeout', updated_at = checked_at
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
       (target_order.declared_body_pdf_page_count is not null and target_order.declared_body_pdf_page_count <> target_order.body_pdf_page_count) or
       jsonb_typeof(target_order.book_snapshot) is distinct from 'object' or
       jsonb_typeof(target_order.book_snapshot -> 'works') is distinct from 'array' or
       (case when jsonb_typeof(target_order.book_snapshot -> 'works') = 'array'
         then jsonb_array_length(target_order.book_snapshot -> 'works') not between 1 and 100 else true end) or
       jsonb_typeof(target_order.book_snapshot -> 'title') is distinct from 'string' or
       nullif(btrim(target_order.book_snapshot ->> 'title'), '') is null or
       jsonb_typeof(target_order.book_snapshot -> 'editor') is distinct from 'string' or
       nullif(btrim(target_order.book_snapshot ->> 'editor'), '') is null or
       jsonb_typeof(target_order.book_snapshot -> 'coverStyle') is distinct from 'string' or
       jsonb_typeof(target_order.book_snapshot -> 'coverColor') is distinct from 'string' then
      update public.amuhon_order_pdf_render_jobs set state = 'failed', lease_id = null,
        lease_expires_at = null, error_code = 'invalid_snapshot', updated_at = checked_at
      where order_id = candidate.order_id;
      continue;
    end if;

    if not public._amuhon_book_works_rights_approved_v1(target_order.book_snapshot -> 'works', true) then
      update public.amuhon_order_pdf_render_jobs set state = 'failed', lease_id = null,
        lease_expires_at = null, error_code = 'rights_unverified', updated_at = checked_at
      where order_id = candidate.order_id;
      continue;
    end if;

    new_lease_id := pg_catalog.gen_random_uuid();
    update public.amuhon_order_pdf_render_jobs set state = 'rendering', lease_id = new_lease_id,
      lease_expires_at = checked_at + pg_catalog.make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1, error_code = null, updated_at = checked_at
    where order_id = candidate.order_id returning * into target_job;
    if target_job.state <> 'rendering' then continue; end if;

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

-- A rights decision can be revoked while a lease is running. Revalidate it
-- at finalization before attaching either private Storage object to the order.
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
  if not public._amuhon_book_works_rights_approved_v1(target_order.book_snapshot -> 'works', true) then
    raise exception 'WORK_RIGHTS_NOT_APPROVED';
  end if;
  if target_order.files_validated_at is null or target_order.body_pdf_page_count is distinct from p_body_pdf_page_count or
     (target_order.declared_body_pdf_page_count is not null and target_order.declared_body_pdf_page_count <> p_body_pdf_page_count) then
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

comment on table public.amuhon_work_commercial_rights is
  'Manually curated commercial-use ledger, edition-specific and fail-closed. Aozora catalog availability alone never grants status A.';
comment on column public.amuhon_work_commercial_rights.source_sha256 is
  'SHA-256 of the exact approved source text edition; requests without a server-verified matching digest are denied.';
comment on column public.amuhon_work_commercial_rights.rights_reviews_complete is
  'Curator attestation that every author, translator, adaptor and other required rights holder was individually reviewed.';

notify pgrst, 'reload schema';
commit;
