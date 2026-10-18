-- READ ONLY: run this in the amuhon-staging SQL Editor before reapplying.
-- It inspects only catalog/configuration metadata; it does not read order PII or mutate data.

select
  'legacy role' as section,
  coalesce(r.rolname, '(absent)') as object_name,
  case when r.oid is null then 'not created'
       else format('login=%s superuser=%s bypassrls=%s inherit=%s', r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolinherit)
  end as state
from (values ('amuhon_order_executor'::text)) as expected(role_name)
left join pg_roles r on r.rolname = expected.role_name

union all

select
  'table', expected.table_name,
  case when c.oid is null then 'absent'
       else format('exists; RLS=%s; FORCE RLS=%s; owner=%s', c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner))
  end
from (values ('amuhon_orders'::text), ('amuhon_order_rate_limits'::text)) as expected(table_name)
left join pg_class c on c.oid = to_regclass('public.' || expected.table_name)

union all

select
  'function', expected.signature,
  case when p.oid is null then 'absent'
       else format('exists; owner=%s; security_definer=%s; search_path=%s', pg_get_userbyid(p.proowner), p.prosecdef, coalesce(array_to_string(p.proconfig, ', '), '(default)'))
  end
from (values
  ('public.create_amuhon_order_draft(uuid,uuid,jsonb,jsonb,integer,text,integer)'::text),
  ('public.purge_expired_amuhon_order_drafts()'::text),
  ('public.guard_amuhon_order_update()'::text)
) as expected(signature)
left join pg_proc p on p.oid = to_regprocedure(expected.signature)

union all

select
  'bucket', 'amuhon-order-files',
  coalesce((select format('exists; public=%s; size_limit=%s; mime_types=%s', b.public, b.file_size_limit, b.allowed_mime_types)
            from storage.buckets b where b.id = 'amuhon-order-files'), 'absent')

order by section, object_name;

-- Effective direct table privileges for API roles (NULL means the table is absent).
select
  role_name,
  table_name,
  has_table_privilege(role_name, to_regclass('public.' || table_name), 'SELECT') as can_select,
  has_table_privilege(role_name, to_regclass('public.' || table_name), 'INSERT') as can_insert,
  has_table_privilege(role_name, to_regclass('public.' || table_name), 'UPDATE') as can_update,
  has_table_privilege(role_name, to_regclass('public.' || table_name), 'DELETE') as can_delete
from (values
  ('anon'::name), ('authenticated'::name), ('service_role'::name), ('amuhon_order_executor'::name)
) expected(role_name)
join pg_roles r on r.rolname = expected.role_name
cross join (values
  ('amuhon_orders'::text), ('amuhon_order_rate_limits'::text)
) expected_tables(table_name)
where to_regclass('public.' || table_name) is not null
order by table_name, r.rolname;

-- Relevant RLS policies, if the tables already exist.
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where (schemaname = 'public' and tablename in ('amuhon_orders', 'amuhon_order_rate_limits'))
   or (schemaname = 'storage' and tablename = 'objects' and policyname = 'amuhon_order_files_deny_public_access')
order by schemaname, tablename, policyname;
