-- Read-only verification for the PDF render queue migration.
-- First confirm the active project in the Supabase Dashboard is amuhon-staging.
-- This script never calls an application RPC and never reads customer/order rows.

with
queue_table as (
  select c.oid, c.relrowsecurity, c.relacl, c.relowner
  from pg_catalog.pg_class as c
  where c.oid = pg_catalog.to_regclass('public.amuhon_order_pdf_render_jobs')
),
expected_functions(label, signature, return_type) as (
  values
    ('claim', 'public.claim_amuhon_order_pdf_render_job(integer)', 'jsonb'),
    ('fail', 'public.fail_amuhon_order_pdf_render_job(uuid,uuid,text)', 'bool'),
    ('complete', 'public.complete_amuhon_order_pdf_render_job(uuid,uuid,text,text,integer,text,text,integer,integer)', 'jsonb'),
    ('admin_status', 'public.get_amuhon_admin_order_pdf_render_status(uuid)', 'jsonb')
),
function_checks as (
  select
    expected.label,
    p.oid,
    p.prorettype = pg_catalog.to_regtype(expected.return_type) as return_type_matches,
    p.prosecdef as security_definer,
    coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp'], false) as search_path_fixed,
    coalesce(pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'), false) as service_role_execute,
    coalesce(pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'), false) as anon_execute,
    coalesce(pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'), false) as authenticated_execute,
    exists (
      select 1
      from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) as acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) as public_execute
  from expected_functions as expected
  left join pg_catalog.pg_proc as p
    on p.oid = pg_catalog.to_regprocedure(expected.signature)
),
required_order_columns(column_name) as (
  values
    ('status'), ('files_validated_at'), ('body_pdf_page_count'), ('declared_body_pdf_page_count'),
    ('body_pdf_storage_path'), ('cover_png_storage_path'), ('body_pdf_sha256'),
    ('cover_png_sha256'), ('body_pdf_size_bytes'), ('cover_png_size_bytes'), ('book_snapshot')
),
order_column_check as (
  select count(*) = (select count(*) from required_order_columns) as all_present
  from required_order_columns as required
  where exists (
    select 1 from pg_catalog.pg_attribute as a
    where a.attrelid = pg_catalog.to_regclass('public.amuhon_orders')
      and a.attname = required.column_name and a.attnum > 0 and not a.attisdropped
  )
),
job_schema_check as (
  select
    exists (
      select 1 from pg_catalog.pg_constraint as constraint_row
      where constraint_row.conrelid = pg_catalog.to_regclass('public.amuhon_order_pdf_render_jobs')
        and constraint_row.conname = 'amuhon_order_pdf_render_jobs_pkey'
        and constraint_row.contype = 'p' and constraint_row.convalidated
    ) as one_job_per_order_primary_key,
    exists (
      select 1 from pg_catalog.pg_constraint as constraint_row
      where constraint_row.conrelid = pg_catalog.to_regclass('public.amuhon_order_pdf_render_jobs')
        and constraint_row.contype = 'f'
        and constraint_row.confrelid = pg_catalog.to_regclass('public.amuhon_orders')
        and constraint_row.confdeltype = 'r' and constraint_row.convalidated
    ) as order_delete_restricted,
    coalesce((
      select bool_and(constraint_row.convalidated)
      from pg_catalog.pg_constraint as constraint_row
      where constraint_row.conrelid = pg_catalog.to_regclass('public.amuhon_order_pdf_render_jobs')
        and constraint_row.conname in (
          'amuhon_order_pdf_render_jobs_state_check',
          'amuhon_order_pdf_render_jobs_attempt_count_check',
          'amuhon_order_pdf_render_job_error_code',
          'amuhon_order_pdf_render_job_state_shape'
        ) and constraint_row.contype = 'c'
    ) and (
      select count(*) = 4
      from pg_catalog.pg_constraint as constraint_row
      where constraint_row.conrelid = pg_catalog.to_regclass('public.amuhon_order_pdf_render_jobs')
        and constraint_row.conname in (
          'amuhon_order_pdf_render_jobs_state_check',
          'amuhon_order_pdf_render_jobs_attempt_count_check',
          'amuhon_order_pdf_render_job_error_code',
          'amuhon_order_pdf_render_job_state_shape'
        ) and constraint_row.contype = 'c'
    ), false) as all_job_checks_validated,
    exists (
      select 1 from pg_catalog.pg_index as index_row
      join pg_catalog.pg_class as index_class on index_class.oid = index_row.indexrelid
      where index_row.indrelid = pg_catalog.to_regclass('public.amuhon_order_pdf_render_jobs')
        and index_class.relname = 'amuhon_order_pdf_render_jobs_claim_idx'
        and index_row.indisvalid and not index_row.indisunique
    ) as claim_index_valid,
    exists (
      select 1 from pg_catalog.pg_index as index_row
      join pg_catalog.pg_class as index_class on index_class.oid = index_row.indexrelid
      where index_row.indrelid = pg_catalog.to_regclass('public.amuhon_order_pdf_render_jobs')
        and index_class.relname = 'amuhon_order_pdf_render_jobs_lease_idx'
        and index_row.indisvalid and index_row.indisunique and index_row.indpred is not null
    ) as unique_partial_lease_index_valid
),
trigger_check as (
  select exists (
    select 1
    from pg_catalog.pg_trigger as t
    join pg_catalog.pg_proc as p on p.oid = t.tgfoid
    where t.tgrelid = pg_catalog.to_regclass('public.amuhon_orders')
      and t.tgname = 'enqueue_amuhon_order_pdf_render_after_paid'
      and not t.tgisinternal
      and t.tgenabled in ('O', 'A')
      and p.proname = 'enqueue_amuhon_order_pdf_render_after_paid'
      and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog, pg_temp']
      and pg_catalog.pg_get_functiondef(p.oid) ilike '%on conflict (order_id) do nothing%'
      and pg_catalog.pg_get_functiondef(p.oid) ilike '%new.status = ''paid''%'
  ) as enabled_paid_trigger
),
trigger_function_check as (
  select exists (
    select 1
    from pg_catalog.pg_proc as p
    where p.oid = pg_catalog.to_regprocedure('public.enqueue_amuhon_order_pdf_render_after_paid()')
      and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog, pg_temp']
      and not exists (
        select 1
        from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) as acl
        where acl.grantee in (0,
          (select oid from pg_catalog.pg_roles where rolname = 'anon'),
          (select oid from pg_catalog.pg_roles where rolname = 'authenticated'),
          (select oid from pg_catalog.pg_roles where rolname = 'service_role'))
          and acl.privilege_type = 'EXECUTE'
      )
  ) as trigger_function_not_directly_executable
),
function_acl_checks as (
  select
    count(oid) = 4 as all_functions_present,
    coalesce(bool_and(return_type_matches), false) as return_types_match,
    coalesce(bool_and(security_definer), false) as all_security_definer,
    coalesce(bool_and(search_path_fixed), false) as all_search_paths_fixed,
    coalesce(bool_and(service_role_execute), false) as service_role_can_execute,
    coalesce(bool_and(not anon_execute and not authenticated_execute and not public_execute), false) as no_public_client_execute
  from function_checks
),
queue_table_acl as (
  select exists(select 1 from queue_table) as table_exists,
    coalesce((select relrowsecurity from queue_table), false) as rls_enabled,
    coalesce((select pg_catalog.has_table_privilege('anon', oid, 'SELECT') from queue_table), false) as anon_select,
    coalesce((select pg_catalog.has_table_privilege('authenticated', oid, 'SELECT') from queue_table), false) as authenticated_select,
    coalesce((select pg_catalog.has_table_privilege('service_role', oid, 'SELECT') from queue_table), false) as service_role_select,
    coalesce((
      select exists (
        select 1 from pg_catalog.aclexplode(coalesce(relacl, pg_catalog.acldefault('r', relowner))) as acl
        where acl.grantee = 0 and acl.privilege_type = 'SELECT'
      ) from queue_table
    ), false) as public_select,
    not exists (
      select 1
      from pg_catalog.pg_policy as policy
      cross join lateral unnest(policy.polroles) as assigned(role_oid)
      where policy.polrelid = pg_catalog.to_regclass('public.amuhon_order_pdf_render_jobs')
        and assigned.role_oid in (0, (select oid from pg_catalog.pg_roles where rolname = 'anon'),
          (select oid from pg_catalog.pg_roles where rolname = 'authenticated'))
    ) as no_client_policies
),
bucket_check as (
  select exists (
    select 1 from storage.buckets where id = 'amuhon-order-files' and public is false
  ) as existing_bucket_is_private
),
storage_policy_check as (
  select
    coalesce((select c.relrowsecurity from pg_catalog.pg_class as c
      where c.oid = pg_catalog.to_regclass('storage.objects')), false) as objects_rls_enabled,
    exists (
      select 1 from pg_catalog.pg_policy as policy
      where policy.polrelid = pg_catalog.to_regclass('storage.objects')
        and policy.polname = 'amuhon_order_files_deny_public_access'
        and not policy.polpermissive and policy.polcmd = '*'
        and 0 = any(policy.polroles)
        and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) ilike '%bucket_id <> ''amuhon-order-files''%'
        and pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) ilike '%bucket_id <> ''amuhon-order-files''%'
    ) as order_bucket_restrictive_deny_policy
)
select check_name, result
from (
  select 'queue_table_exists' as check_name, case when table_exists then 'PASS' else 'FAIL' end as result from queue_table_acl
  union all select 'queue_table_rls_enabled', case when rls_enabled then 'PASS' else 'FAIL' end from queue_table_acl
  union all select 'queue_table_no_anon_select', case when not anon_select then 'PASS' else 'FAIL' end from queue_table_acl
  union all select 'queue_table_no_authenticated_select', case when not authenticated_select then 'PASS' else 'FAIL' end from queue_table_acl
  union all select 'queue_table_no_service_role_select', case when not service_role_select then 'PASS' else 'FAIL' end from queue_table_acl
  union all select 'queue_table_no_public_select', case when not public_select then 'PASS' else 'FAIL' end from queue_table_acl
  union all select 'queue_table_no_client_policy', case when no_client_policies then 'PASS' else 'FAIL' end from queue_table_acl
  union all select 'order_render_columns_present', case when all_present then 'PASS' else 'FAIL' end from order_column_check
  union all select 'one_job_per_order_primary_key', case when one_job_per_order_primary_key then 'PASS' else 'FAIL' end from job_schema_check
  union all select 'order_delete_restricted', case when order_delete_restricted then 'PASS' else 'FAIL' end from job_schema_check
  union all select 'all_job_checks_validated', case when all_job_checks_validated then 'PASS' else 'FAIL' end from job_schema_check
  union all select 'claim_index_valid', case when claim_index_valid then 'PASS' else 'FAIL' end from job_schema_check
  union all select 'unique_partial_lease_index_valid', case when unique_partial_lease_index_valid then 'PASS' else 'FAIL' end from job_schema_check
  union all select 'paid_transition_trigger_enabled', case when enabled_paid_trigger then 'PASS' else 'FAIL' end from trigger_check
  union all select 'trigger_function_no_direct_execute', case when trigger_function_not_directly_executable then 'PASS' else 'FAIL' end from trigger_function_check
  union all select 'four_expected_rpc_signatures_present', case when all_functions_present then 'PASS' else 'FAIL' end from function_acl_checks
  union all select 'rpc_return_types_match', case when return_types_match then 'PASS' else 'FAIL' end from function_acl_checks
  union all select 'rpc_security_definer', case when all_security_definer then 'PASS' else 'FAIL' end from function_acl_checks
  union all select 'rpc_search_path_fixed', case when all_search_paths_fixed then 'PASS' else 'FAIL' end from function_acl_checks
  union all select 'rpc_service_role_execute', case when service_role_can_execute then 'PASS' else 'FAIL' end from function_acl_checks
  union all select 'rpc_no_public_or_client_execute', case when no_public_client_execute then 'PASS' else 'FAIL' end from function_acl_checks
  union all select 'existing_storage_bucket_private', case when existing_bucket_is_private then 'PASS' else 'FAIL' end from bucket_check
  union all select 'storage_objects_rls_enabled', case when objects_rls_enabled then 'PASS' else 'FAIL' end from storage_policy_check
  union all select 'order_bucket_restrictive_deny_policy', case when order_bucket_restrictive_deny_policy then 'PASS' else 'FAIL' end from storage_policy_check
) as checks
order by check_name;

-- Optional aggregate-only operational snapshot. Run only after the catalog
-- checks above pass. It returns no identifiers or customer fields.
select state, count(*) as job_count
from public.amuhon_order_pdf_render_jobs
group by state
order by state;

-- Paid orders without a render-job row are intentionally not backfilled by the
-- migration. This aggregate is informational and does not identify any order.
select count(*) as paid_orders_without_render_job
from public.amuhon_orders as orders
left join public.amuhon_order_pdf_render_jobs as jobs on jobs.order_id = orders.id
where orders.status = 'paid' and jobs.order_id is null;
