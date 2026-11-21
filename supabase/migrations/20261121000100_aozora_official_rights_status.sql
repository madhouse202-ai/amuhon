begin;

-- Keep a distinct terminal reason for permanent rights ineligibility. A
-- temporary manual stop is deliberately not recorded as a failure: its job
-- remains queued and becomes claimable after a resume event.
alter table public.amuhon_order_pdf_render_jobs
  drop constraint if exists amuhon_order_pdf_render_job_error_code;
alter table public.amuhon_order_pdf_render_jobs
  add constraint amuhon_order_pdf_render_job_error_code check (
    error_code is null or error_code in (
      'aozora_unavailable', 'storage_unavailable', 'processing_timeout',
      'worker_unavailable', 'invalid_snapshot', 'invalid_render',
      'page_count_mismatch', 'internal_error', 'rights_unverified', 'rights_ineligible'
    )
  );

-- Manual stop/resume is append-only. The latest event controls the status;
-- no order or historical event is deleted when a stop is lifted.
create table if not exists public.amuhon_work_rights_manual_stop_events (
  event_id bigint generated always as identity primary key,
  work_id text not null check (work_id ~ '^[0-9]{1,12}$'),
  action text not null check (action in ('stop', 'resume')),
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  actor text not null check (length(btrim(actor)) between 1 and 200),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists amuhon_work_rights_manual_stop_latest
  on public.amuhon_work_rights_manual_stop_events (work_id, event_id desc);
alter table public.amuhon_work_rights_manual_stop_events enable row level security;
revoke all on public.amuhon_work_rights_manual_stop_events from public, anon, authenticated, service_role;
revoke all on sequence public.amuhon_work_rights_manual_stop_events_event_id_seq from public, anon, authenticated, service_role;

create or replace function public.reject_amuhon_manual_rights_stop_event_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'MANUAL_RIGHTS_STOP_HISTORY_IS_APPEND_ONLY';
end;
$$;
revoke all on function public.reject_amuhon_manual_rights_stop_event_mutation_v1() from public, anon, authenticated, service_role;
drop trigger if exists amuhon_work_rights_manual_stop_events_append_only on public.amuhon_work_rights_manual_stop_events;
create trigger amuhon_work_rights_manual_stop_events_append_only
before update or delete on public.amuhon_work_rights_manual_stop_events
for each row execute function public.reject_amuhon_manual_rights_stop_event_mutation_v1();

create or replace function public._amuhon_work_rights_manual_stop_active_v1(p_work_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((
    select stop_event.action = 'stop'
    from public.amuhon_work_rights_manual_stop_events as stop_event
    where stop_event.work_id = p_work_id
    order by stop_event.event_id desc
    limit 1
  ), false);
$$;
revoke all on function public._amuhon_work_rights_manual_stop_active_v1(text) from public, anon, authenticated, service_role;

-- This function is intended for an operator in the Supabase SQL Editor.
-- Keep its EXECUTE privilege owner-only; no application API exposes it.
create or replace function public.set_amuhon_work_rights_manual_stop_v1(
  p_work_id text,
  p_action text,
  p_reason text,
  p_actor text
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  inserted_event_id bigint;
begin
  if p_work_id is null or p_work_id !~ '^[0-9]{1,12}$' or
     p_action is null or p_action not in ('stop', 'resume') or
     p_reason is null or length(btrim(p_reason)) not between 1 and 2000 or
     p_actor is null or length(btrim(p_actor)) not between 1 and 200 then
    raise exception 'INVALID_MANUAL_RIGHTS_STOP_EVENT';
  end if;
  -- Serialize stop/resume events for one work so the latest event ID also
  -- reflects the committed operator action order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_work_id, 0));
  insert into public.amuhon_work_rights_manual_stop_events (work_id, action, reason, actor)
  values (p_work_id, p_action, btrim(p_reason), btrim(p_actor))
  returning event_id into inserted_event_id;
  return inserted_event_id;
end;
$$;
revoke all on function public.set_amuhon_work_rights_manual_stop_v1(text, text, text, text) from public, anon, authenticated, service_role;

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
  rights_snapshot jsonb;
  approved_work_count integer := 0;
  contributor_count integer;
begin
  if jsonb_typeof(p_works) is distinct from 'array' or
     jsonb_array_length(p_works) not between 1 and 100 then
    return false;
  end if;

  for target_work in select item.value from jsonb_array_elements(p_works) as item(value) loop
    if jsonb_typeof(target_work) is distinct from 'object' or
       nullif(btrim(target_work ->> 'id'), '') is null or target_work ->> 'id' !~ '^[0-9]{1,12}$' or
       nullif(btrim(target_work ->> 'title'), '') is null or
       jsonb_typeof(target_work -> 'contributors') is distinct from 'array' or
       jsonb_typeof(target_work -> 'sourceMetadata') is distinct from 'object' or
       jsonb_array_length(target_work -> 'contributors') < 1 or
       coalesce(target_work ->> 'sourceSha256', '') !~ '^[a-f0-9]{64}$' or
       coalesce(target_work ->> 'cardUrl', '') !~ '^https://(www\.)?aozora\.gr\.jp/cards/' or
       coalesce(target_work ->> 'textUrl', '') !~ '^https://(www\.)?aozora\.gr\.jp/cards/' or
       coalesce(target_work ->> 'xhtmlUrl', '') !~ '^https://(www\.)?aozora\.gr\.jp/cards/' then
      return false;
    end if;

    if public._amuhon_work_rights_manual_stop_active_v1(target_work ->> 'id') then
      return false;
    end if;

    rights_snapshot := target_work -> 'catalogRights';
    if rights_snapshot is not null then
      if jsonb_typeof(rights_snapshot) is distinct from 'object' or
         rights_snapshot ->> 'schema' is distinct from 'amuhon-aozora-commercial-rights/v1' or
         rights_snapshot ->> 'classification' is distinct from 'A' or
         rights_snapshot ->> 'basis' is distinct from 'official_aozora_copyright_flags' or
         coalesce(rights_snapshot ->> 'catalogFetchedAt', '') !~ '^\d{4}-\d{2}-\d{2}T' or
         coalesce(rights_snapshot ->> 'catalogSha256', '') !~ '^[a-f0-9]{64}$' or
         rights_snapshot -> 'workCopyrightFlags' is distinct from '["なし"]'::jsonb or
         coalesce((rights_snapshot ->> 'missingWorkCopyrightFlagRows')::integer, -1) <> 0 or
         rights_snapshot -> 'catalogPersonCopyrightFlags' is distinct from '["なし"]'::jsonb or
         coalesce((rights_snapshot ->> 'missingPersonCopyrightFlagRows')::integer, -1) <> 0 or
         coalesce((rights_snapshot ->> 'incompleteContributorRows')::integer, -1) <> 0 or
         coalesce((rights_snapshot ->> 'catalogRowCount')::integer, 0) < 1 or
         rights_snapshot -> 'sourceMetadataConflicts' is distinct from '[]'::jsonb or
         rights_snapshot -> 'catalogIssues' is distinct from '[]'::jsonb or
         rights_snapshot -> 'reasons' is distinct from '["official_flags_none_single_author_scope"]'::jsonb or
         jsonb_typeof(rights_snapshot -> 'contributors') is distinct from 'array' or
         jsonb_array_length(rights_snapshot -> 'contributors') <> 1 or
         jsonb_array_length(target_work -> 'contributors') <> 1 then
        return false;
      end if;

      if p_require_notice and target_work ->> 'rightsNotice' is distinct from
        'このファイルは、インターネットの図書館、青空文庫（https://www.aozora.gr.jp/）で作られました。入力、校正、制作にあたったのは、ボランティアの皆さんです。' then
        return false;
      end if;

      if not exists (
        select 1
        from jsonb_array_elements(rights_snapshot -> 'contributors') as catalog_person(value)
        join jsonb_array_elements(target_work -> 'contributors') as snapshot_person(value)
          on catalog_person.value ->> 'name' = snapshot_person.value ->> 'name'
         and catalog_person.value ->> 'role' = snapshot_person.value ->> 'role'
        where catalog_person.value ->> 'name' = target_work ->> 'author'
          and catalog_person.value ->> 'role' in ('著者', '作者', '原著者')
          and catalog_person.value -> 'copyrightFlags' = '["なし"]'::jsonb
          and coalesce((catalog_person.value ->> 'missingCopyrightFlagRows')::integer, -1) = 0
          and jsonb_typeof(catalog_person.value -> 'personIds') = 'array'
          and jsonb_array_length(catalog_person.value -> 'personIds') = 1
          and (catalog_person.value -> 'personIds' ->> 0) ~ '^[0-9]{1,12}$'
      ) then
        return false;
      end if;

      approved_work_count := approved_work_count + 1;
      continue;
    end if;

    -- Compatibility for snapshots already stored under the previous manually
    -- curated ledger. Their exact edition-bound approval is retained.
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

-- Used to filter only temporary manual stops during candidate discovery.
-- Invalid snapshots are not treated as stopped; the claim function will
-- terminally fail those after locking the corresponding order and job.
create or replace function public._amuhon_book_works_manual_stop_active_v1(p_works jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_work jsonb;
begin
  if jsonb_typeof(p_works) is distinct from 'array' then
    return false;
  end if;

  for target_work in select item.value from jsonb_array_elements(p_works) as item(value) loop
    if jsonb_typeof(target_work) = 'object' and
       coalesce(target_work ->> 'id', '') ~ '^[0-9]{1,12}$' and
       public._amuhon_work_rights_manual_stop_active_v1(target_work ->> 'id') then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke all on function public._amuhon_book_works_manual_stop_active_v1(jsonb) from public, anon, authenticated, service_role;

-- Do not lease a paid order while its current rights decision is stopped or
-- no longer passes the shared A/B/C gate. Temporary stops remain queued;
-- permanently ineligible snapshots are terminally marked for operator review.
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
  target_work jsonb;
  checked_at timestamptz;
  new_lease_id uuid;
begin
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 1800 then
    raise exception 'INVALID_PDF_RENDER_LEASE';
  end if;

  for candidate in
    select jobs.order_id
    from public.amuhon_order_pdf_render_jobs as jobs
    join public.amuhon_orders as candidate_order on candidate_order.id = jobs.order_id
    where (jobs.state = 'queued' or
      (jobs.state = 'rendering' and jobs.lease_expires_at <= clock_timestamp()))
      and not public._amuhon_book_works_manual_stop_active_v1(candidate_order.book_snapshot -> 'works')
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

    -- Serialize the final manual-stop check with operator stop/resume writes.
    -- Stable ordering prevents deadlocks when a book contains multiple works.
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
    if public._amuhon_book_works_manual_stop_active_v1(target_order.book_snapshot -> 'works') then
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

    if not public._amuhon_book_works_rights_approved_v1(target_order.book_snapshot -> 'works', true) then
      update public.amuhon_order_pdf_render_jobs set
        state = 'failed', lease_id = null, lease_expires_at = null,
        error_code = 'rights_ineligible', updated_at = checked_at
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
          'sourceSha256', item.work ->> 'sourceSha256',
          'conditions', case when item.work ? 'catalogRights' then
            'このファイルは、インターネットの図書館、青空文庫（https://www.aozora.gr.jp/）で作られました。入力、校正、制作にあたったのは、ボランティアの皆さんです。'
            else rights.permission_conditions end
        ) order by item.ordinality)
        from jsonb_array_elements(p_works) with ordinality as item(work, ordinality)
        left join lateral (
          select candidate.permission_conditions
          from public.amuhon_work_commercial_rights as candidate
          where candidate.work_id = item.work ->> 'id'
            and candidate.xhtml_url = item.work ->> 'xhtmlUrl'
            and candidate.source_sha256 = item.work ->> 'sourceSha256'
            and candidate.status = 'A'
          limit 1
        ) as rights on true
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
  select book_snapshot, upload_token_hash into target_snapshot, target_token_hash
    from public.amuhon_orders where id = p_order_id;
  if not found or target_token_hash is distinct from p_upload_token_hash then
    return jsonb_build_object('approved', false);
  end if;
  return jsonb_build_object('approved', public._amuhon_book_works_rights_approved_v1(target_snapshot -> 'works', true));
end;
$$;
revoke all on function public.check_amuhon_order_commercial_rights_v1(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.check_amuhon_order_commercial_rights_v1(uuid, text) to service_role;

create or replace function public.get_amuhon_order_rights_snapshot_v1(
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
  target_status text;
begin
  if p_order_id is null or p_upload_token_hash is null or p_upload_token_hash !~ '^[a-f0-9]{64}$' then
    return null;
  end if;
  select book_snapshot, upload_token_hash, status into target_snapshot, target_token_hash, target_status
    from public.amuhon_orders where id = p_order_id;
  if not found or target_token_hash is distinct from p_upload_token_hash or
     target_status not in ('draft', 'preparing', 'ready_for_payment') or
     jsonb_typeof(target_snapshot -> 'works') is distinct from 'array' then
    return null;
  end if;
  -- No customer, payment, upload capability, or storage fields are returned.
  return jsonb_build_object('works', target_snapshot -> 'works');
end;
$$;
revoke all on function public.get_amuhon_order_rights_snapshot_v1(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_order_rights_snapshot_v1(uuid, text) to service_role;

comment on table public.amuhon_work_rights_manual_stop_events is
  'Append-only manual stop/resume audit for Aozora work IDs; latest event controls new checkout and pre-submission rights checks.';
comment on table public.amuhon_work_commercial_rights is
  'Legacy edition-bound manual approvals remain valid for existing order snapshots; new orders use server-resolved official Aozora flags.';
comment on function public._amuhon_book_works_rights_approved_v1(jsonb, boolean) is
  'Accepts server-created official catalog A snapshots or preserves exact legacy ledger approvals; separately validates edition SHA and manual stops.';

notify pgrst, 'reload schema';
commit;
