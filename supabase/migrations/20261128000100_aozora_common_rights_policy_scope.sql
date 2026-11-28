begin;

-- Common policy approvals and explicit work scope are separate from the
-- legacy edition-specific ledger. The seeded policy is intentionally draft.
create table if not exists public.amuhon_aozora_rights_policy_registry (
  policy_id text not null check (policy_id ~ '^[A-Z0-9][A-Z0-9_-]{2,99}$'),
  policy_version text not null check (policy_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  definition_sha256 text not null check (definition_sha256 ~ '^[a-f0-9]{64}$'),
  policy_status text not null check (policy_status in ('draft', 'active', 'suspended')),
  legal_review_status text not null check (legal_review_status in ('unconfirmed', 'confirmed')),
  policy_definition jsonb not null check (jsonb_typeof(policy_definition) = 'object'),
  approved_by text,
  approved_at timestamptz,
  legal_reviewed_by text,
  legal_reviewed_at timestamptz,
  legal_review_evidence text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (policy_id, policy_version),
  constraint amuhon_aozora_policy_definition_identity check (
    policy_definition ->> 'policyId' = policy_id and
    policy_definition ->> 'version' = policy_version and
    policy_definition ->> 'status' = policy_status and
    policy_definition ->> 'legalReviewStatus' = legal_review_status and
    policy_definition ->> 'approvedBy' is not distinct from approved_by and
    (policy_definition ->> 'approvedAt')::timestamptz is not distinct from approved_at and
    policy_definition ->> 'legalReviewedBy' is not distinct from legal_reviewed_by and
    (policy_definition ->> 'legalReviewedAt')::timestamptz is not distinct from legal_reviewed_at and
    policy_definition ->> 'legalReviewEvidence' is not distinct from legal_review_evidence
  ),
  constraint amuhon_aozora_policy_approval_complete check (
    policy_status <> 'active' or (
      legal_review_status = 'confirmed' and
      length(btrim(coalesce(approved_by, ''))) between 1 and 200 and approved_at is not null and
      length(btrim(coalesce(legal_reviewed_by, ''))) between 1 and 200 and legal_reviewed_at is not null and
      length(btrim(coalesce(legal_review_evidence, ''))) between 1 and 1000
    )
  )
);

insert into public.amuhon_aozora_rights_policy_registry (
  policy_id, policy_version, definition_sha256, policy_status, legal_review_status, policy_definition,
  approved_by, approved_at, legal_reviewed_by, legal_reviewed_at, legal_review_evidence
) values (
  'AMUHON-AOZORA-COMMERCIAL-USE', '1.0.0',
  'bd4d17f7503349fa8706112bbae0ef920335d0c3a3a7a9a7f529f14b3c0a4db0',
  'draft', 'unconfirmed',
  $policy${
    "schema":"amuhon-aozora-rights-policy/v1",
    "policyId":"AMUHON-AOZORA-COMMERCIAL-USE",
    "version":"1.0.0",
    "title":"青空文庫収録作品の商用製本利用・共通審査基準",
    "status":"draft",
    "legalReviewStatus":"unconfirmed",
    "approvedBy":null,
    "approvedAt":null,
    "legalReviewedBy":null,
    "legalReviewedAt":null,
    "legalReviewEvidence":null,
    "scope":[
      "青空文庫の公式拡充CSVに掲載され、使用XHTML版を実バイトSHA-256で特定できる作品",
      "国内作家の単独オリジナル作品として人が根拠を確認できる作品",
      "青空文庫のファイル取扱規準を守り、出典情報を製本物に保持・表示できる作品"
    ],
    "eligibilityCriteria":[
      "作品著作権フラグが全行で正確に『なし』である",
      "全関係者の人物著作権フラグが全行で正確に『なし』であり、関係者と役割が特定されている",
      "単独の国内オリジナル作品であることを公式資料等で確認できる",
      "翻訳・翻案・共同著作・編者・校訂者・第三者の文章・図版・解説・独自編集部分など、未確認の権利がない",
      "日本での保護期間、経過措置、外国著作物等を確認し、商用利用可能とする具体的な根拠がある",
      "青空文庫のファイル取扱規準と必要な出典・利用条件を確認し、製本時に保持・表示できる",
      "公式カタログの対象作品情報と使用XHTML URLが一致し、使用版のSHA-256を固定・再検証できる"
    ],
    "individualReviewConditions":[
      "権利フラグの欠落・未知・矛盾、関係者の欠落・役割不明、複数の著作者がある",
      "翻訳・翻案・共同著作、外国著作物、保護期間の経過措置、第三者素材、編集・校訂等の権利確認が必要",
      "作品固有の根拠、利用条件、出典情報、公式カタログ情報または本文版の一致を確認できない"
    ],
    "exclusionConditions":[
      "作品または関係者の著作権フラグに『あり』が含まれ、別途有効な商用利用許諾を確認できない",
      "必要な権利者の許諾がなく、共通基準では利用可能と判断できない"
    ],
    "humanReviewRequirements":[
      "CSVの著作権フラグだけで原作性、国内著作物性、保護期間、第三者素材の不存在を確定しない",
      "法改正の経過措置、外国著作物、翻訳者等の独立した権利を根拠資料に基づいて確認する",
      "共通基準で扱えない例外は一括対象から外し、個別審査に回す",
      "基準の法務確認と運営者による基準承認が完了するまでA登録SQLを生成しない"
    ],
    "references":[
      {"title":"青空文庫収録ファイルの取り扱い規準","url":"https://www.aozora.gr.jp/guide/kijyunn.html","purpose":"収録ファイルの利用条件、出典表示、翻訳者等の権利に関する確認"},
      {"title":"青空文庫の作業マニュアル","url":"https://www.aozora.gr.jp/aozora-manual/","purpose":"著作権状態、入力・校正・底本等の書誌情報を確認するための資料"},
      {"title":"青空文庫の書架情報・著作権フラグについて","url":"https://www.aozora.gr.jp/soramoyou/soramoyou2023.html","purpose":"公式CSVの著作権フラグの意味を確認する資料"}
    ],
    "attributionRule":"青空文庫由来であることと作品ごとの出典情報を保持・表示し、青空文庫の承認・関与を示す表現はしない。",
    "maxBatchSize":50
  }$policy$::jsonb,
  null, null, null, null, null
) on conflict (policy_id, policy_version) do nothing;

create table if not exists public.amuhon_aozora_rights_scope_batches (
  scope_id bigint generated always as identity primary key,
  policy_id text not null,
  policy_version text not null,
  policy_sha256 text not null check (policy_sha256 ~ '^[a-f0-9]{64}$'),
  scope_status text not null check (scope_status in ('active', 'suspended')),
  scope_kind text not null check (scope_kind = 'explicit_work_id_set'),
  catalog_fetched_at timestamptz not null,
  catalog_sha256 text not null check (catalog_sha256 ~ '^[a-f0-9]{64}$'),
  source_package_sha256 text not null check (source_package_sha256 ~ '^[a-f0-9]{64}$'),
  batch_package_sha256 text not null check (batch_package_sha256 ~ '^[a-f0-9]{64}$'),
  selection_sha256 text not null check (selection_sha256 ~ '^[a-f0-9]{64}$'),
  approved_set_sha256 text not null check (approved_set_sha256 ~ '^[a-f0-9]{64}$'),
  approval_statement text not null check (length(btrim(approval_statement)) between 1 and 1000),
  approved_by text not null check (length(btrim(approved_by)) between 1 and 200),
  approved_at timestamptz not null,
  common_review_basis text not null check (length(btrim(common_review_basis)) between 1 and 4000),
  permission_conditions text not null check (length(btrim(permission_conditions)) between 1 and 1000),
  batch_audit jsonb not null check (jsonb_typeof(batch_audit) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  constraint amuhon_aozora_rights_scope_batch_package_unique unique (batch_package_sha256),
  foreign key (policy_id, policy_version)
    references public.amuhon_aozora_rights_policy_registry(policy_id, policy_version) on delete restrict
);

create table if not exists public.amuhon_aozora_rights_scope_members (
  scope_id bigint not null references public.amuhon_aozora_rights_scope_batches(scope_id) on delete restrict,
  work_id text not null check (work_id ~ '^[0-9]{1,12}$'),
  disposition text not null check (disposition in ('approved', 'individual_review', 'excluded')),
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  facts_sha256 text not null check (facts_sha256 ~ '^[a-f0-9]{64}$'),
  facts_snapshot jsonb not null check (jsonb_typeof(facts_snapshot) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (scope_id, work_id)
);
create index if not exists amuhon_aozora_rights_scope_members_work_idx
  on public.amuhon_aozora_rights_scope_members(work_id, scope_id desc);

alter table public.amuhon_aozora_rights_policy_registry enable row level security;
alter table public.amuhon_aozora_rights_scope_batches enable row level security;
alter table public.amuhon_aozora_rights_scope_members enable row level security;
revoke all on public.amuhon_aozora_rights_policy_registry from public, anon, authenticated, service_role;
revoke all on public.amuhon_aozora_rights_scope_batches from public, anon, authenticated, service_role;
revoke all on public.amuhon_aozora_rights_scope_members from public, anon, authenticated, service_role;
revoke all on sequence public.amuhon_aozora_rights_scope_batches_scope_id_seq from public, anon, authenticated, service_role;

create or replace function public._amuhon_aozora_work_in_approved_scope_v1(
  p_work_id text,
  p_policy_id text,
  p_policy_version text,
  p_policy_sha256 text,
  p_facts_sha256 text,
  p_require_notice boolean default false,
  p_rights_notice text default null
) returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  selected_disposition text;
  selected_facts_sha256 text;
  selected_scope_status text;
  selected_permission_conditions text;
begin
  if p_work_id is null or p_work_id !~ '^[0-9]{1,12}$' or
     p_policy_id is null or p_policy_version is null or
     coalesce(p_policy_sha256, '') !~ '^[a-f0-9]{64}$' or
     coalesce(p_facts_sha256, '') !~ '^[a-f0-9]{64}$' then
    return false;
  end if;

  if not exists (
    select 1 from public.amuhon_aozora_rights_policy_registry as policy
    where policy.policy_id = p_policy_id and policy.policy_version = p_policy_version
      and policy.definition_sha256 = p_policy_sha256
      and policy.policy_status = 'active' and policy.legal_review_status = 'confirmed'
      and length(btrim(coalesce(policy.approved_by, ''))) between 1 and 200 and policy.approved_at is not null
      and length(btrim(coalesce(policy.legal_reviewed_by, ''))) between 1 and 200 and policy.legal_reviewed_at is not null
      and length(btrim(coalesce(policy.legal_review_evidence, ''))) between 1 and 1000
  ) then
    return false;
  end if;

  select member.disposition, member.facts_sha256, batch.scope_status, batch.permission_conditions
    into selected_disposition, selected_facts_sha256, selected_scope_status, selected_permission_conditions
    from public.amuhon_aozora_rights_scope_members as member
    join public.amuhon_aozora_rights_scope_batches as batch on batch.scope_id = member.scope_id
   where member.work_id = p_work_id
     and batch.policy_id = p_policy_id and batch.policy_version = p_policy_version
     and batch.policy_sha256 = p_policy_sha256
   order by batch.scope_id desc
   limit 1;
  if not found or selected_scope_status <> 'active' or selected_disposition <> 'approved' or
     selected_facts_sha256 <> p_facts_sha256 then
    return false;
  end if;
  if p_require_notice and selected_permission_conditions is distinct from p_rights_notice then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;
revoke all on function public._amuhon_aozora_work_in_approved_scope_v1(text, text, text, text, text, boolean, text) from public, anon, authenticated, service_role;

create or replace function public.get_amuhon_aozora_sellable_work_facts_v1(
  p_policy_id text,
  p_policy_version text,
  p_policy_sha256 text
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  result jsonb;
begin
  if not exists (
    select 1 from public.amuhon_aozora_rights_policy_registry as policy
    where policy.policy_id = p_policy_id and policy.policy_version = p_policy_version
      and policy.definition_sha256 = p_policy_sha256
      and policy.policy_status = 'active' and policy.legal_review_status = 'confirmed'
      and length(btrim(coalesce(policy.approved_by, ''))) between 1 and 200 and policy.approved_at is not null
      and length(btrim(coalesce(policy.legal_reviewed_by, ''))) between 1 and 200 and policy.legal_reviewed_at is not null
      and length(btrim(coalesce(policy.legal_review_evidence, ''))) between 1 and 1000
  ) then
    return jsonb_build_object('ready', false, 'works', '[]'::jsonb);
  end if;

  with latest_membership as (
    select distinct on (member.work_id)
      member.work_id, member.disposition, member.facts_sha256, batch.scope_status
    from public.amuhon_aozora_rights_scope_members as member
    join public.amuhon_aozora_rights_scope_batches as batch on batch.scope_id = member.scope_id
    where batch.policy_id = p_policy_id and batch.policy_version = p_policy_version
      and batch.policy_sha256 = p_policy_sha256
    order by member.work_id, batch.scope_id desc
  )
  select jsonb_build_object(
    'ready', true,
    'works', coalesce(jsonb_agg(jsonb_build_object('workId', latest.work_id, 'factsSha256', latest.facts_sha256)
      order by latest.work_id), '[]'::jsonb)
  ) into result
  from latest_membership as latest
  where latest.scope_status = 'active' and latest.disposition = 'approved'
    and not public._amuhon_work_rights_manual_stop_active_v1(latest.work_id);
  return result;
exception when others then
  return jsonb_build_object('ready', false, 'works', '[]'::jsonb);
end;
$$;
revoke all on function public.get_amuhon_aozora_sellable_work_facts_v1(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.get_amuhon_aozora_sellable_work_facts_v1(text, text, text) to service_role;

-- Official-CSV A is still only a classification. It becomes saleable only
-- when the exact current policy version/hash and work-facts digest are in an
-- active, approved scope. Keep the legacy edition-bound ledger branch intact.
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
         jsonb_array_length(target_work -> 'contributors') <> 1 or
         coalesce(rights_snapshot ->> 'workFactsSha256', '') !~ '^[a-f0-9]{64}$' or
         jsonb_typeof(rights_snapshot -> 'policy') is distinct from 'object' then
        return false;
      end if;

      if not public._amuhon_aozora_work_in_approved_scope_v1(
        target_work ->> 'id',
        rights_snapshot -> 'policy' ->> 'policyId',
        rights_snapshot -> 'policy' ->> 'policyVersion',
        rights_snapshot -> 'policy' ->> 'policySha256',
        rights_snapshot ->> 'workFactsSha256',
        p_require_notice,
        target_work ->> 'rightsNotice'
      ) then
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

    -- Legacy manually-curated snapshots remain edition-bound and unchanged.
    contributor_count := jsonb_array_length(target_work -> 'contributors');
    if not exists (
      select 1 from public.amuhon_work_commercial_rights as rights
      where rights.work_id = target_work ->> 'id'
        and rights.title = target_work ->> 'title' and rights.author = target_work ->> 'author'
        and rights.card_url = target_work ->> 'cardUrl' and rights.text_url = target_work ->> 'textUrl'
        and rights.xhtml_url = target_work ->> 'xhtmlUrl' and rights.source_sha256 = target_work ->> 'sourceSha256'
        and rights.catalog_contributors = target_work -> 'contributors'
        and rights.catalog_source_metadata = target_work -> 'sourceMetadata' and rights.status = 'A'
        and length(btrim(rights.evidence_basis)) > 0 and rights.checked_at is not null
        and length(btrim(coalesce(rights.checked_by, ''))) > 0 and rights.rights_reviews_complete
        and length(btrim(rights.permission_conditions)) > 0
        and (not p_require_notice or rights.permission_conditions = target_work ->> 'rightsNotice')
        and (select count(*) from public.amuhon_work_rights_holders as holder
             where holder.work_id = rights.work_id and holder.xhtml_url = rights.xhtml_url
               and holder.source_sha256 = rights.source_sha256) = contributor_count
        and not exists (
          select 1 from jsonb_array_elements(target_work -> 'contributors') as contributor(value)
          where jsonb_typeof(contributor.value) is distinct from 'object'
             or nullif(btrim(contributor.value ->> 'name'), '') is null
             or nullif(btrim(contributor.value ->> 'role'), '') is null
             or not exists (
               select 1 from public.amuhon_work_rights_holders as holder
               where holder.work_id = rights.work_id and holder.xhtml_url = rights.xhtml_url
                 and holder.source_sha256 = rights.source_sha256
                 and holder.person_name = contributor.value ->> 'name' and holder.role = contributor.value ->> 'role'
                 and holder.status = 'A' and length(btrim(holder.evidence_basis)) > 0
                 and holder.checked_at is not null and length(btrim(coalesce(holder.checked_by, ''))) > 0
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

-- Return the policy-approved notice for official-scope records and preserve
-- the existing exact edition-bound notice path for legacy ledger records.
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
          'conditions', case when item.work ? 'catalogRights' then (
            select batch.permission_conditions
            from public.amuhon_aozora_rights_scope_members as member
            join public.amuhon_aozora_rights_scope_batches as batch on batch.scope_id = member.scope_id
            where member.work_id = item.work ->> 'id'
              and member.disposition = 'approved'
              and batch.scope_status = 'active'
              and member.facts_sha256 = item.work -> 'catalogRights' ->> 'workFactsSha256'
              and batch.policy_id = item.work -> 'catalogRights' -> 'policy' ->> 'policyId'
              and batch.policy_version = item.work -> 'catalogRights' -> 'policy' ->> 'policyVersion'
              and batch.policy_sha256 = item.work -> 'catalogRights' -> 'policy' ->> 'policySha256'
            order by batch.scope_id desc limit 1
          ) else (
            select rights.permission_conditions
            from public.amuhon_work_commercial_rights as rights
            where rights.work_id = item.work ->> 'id'
              and rights.xhtml_url = item.work ->> 'xhtmlUrl'
              and rights.source_sha256 = item.work ->> 'sourceSha256'
              and rights.title = item.work ->> 'title'
              and rights.author = item.work ->> 'author'
              and rights.card_url = item.work ->> 'cardUrl'
              and rights.text_url = item.work ->> 'textUrl'
              and rights.catalog_contributors = item.work -> 'contributors'
              and rights.catalog_source_metadata = item.work -> 'sourceMetadata'
              and rights.status = 'A'
            limit 1
          ) end
        ) order by item.ordinality)
        from jsonb_array_elements(p_works) with ordinality as item(work, ordinality)
      ), '[]'::jsonb)
    )
    else jsonb_build_object('approved', false, 'notices', '[]'::jsonb)
  end;
$$;
revoke all on function public.check_amuhon_works_commercial_rights_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.check_amuhon_works_commercial_rights_v1(jsonb) to service_role;

comment on table public.amuhon_aozora_rights_policy_registry is
  'Versioned shared rights-policy evidence. The current seeded policy is draft/unconfirmed; only an exact active, legally confirmed definition can authorize works.';
comment on table public.amuhon_aozora_rights_scope_batches is
  'Append-only operator-approved explicit work-ID scopes for a particular common policy version and hash.';
comment on table public.amuhon_aozora_rights_scope_members is
  'Per-work machine facts and approved/individual_review/excluded disposition within a common scope batch; not an individual legal approval.';

notify pgrst, 'reload schema';
commit;
