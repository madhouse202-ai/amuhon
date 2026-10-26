-- TEST-ONLY BOOTSTRAP for a brand-new, disposable native PostgreSQL cluster.
-- This creates PostgreSQL-global roles and a mock storage schema. It is NOT
-- Supabase Storage and must never be applied to amuhon or amuhon-staging.
-- Run only through apply-order-validation-native-bootstrap.ps1; direct psql use is unsupported.
\set ON_ERROR_STOP on
begin;
do $native_bootstrap_guard$
begin
  if current_database() is distinct from 'amuhon_validation_native' then
    raise exception 'STOP: native bootstrap database mismatch';
  end if;
  if current_user is distinct from 'postgres' then
    raise exception 'STOP: native bootstrap requires postgres';
  end if;
  if inet_server_addr() is distinct from inet '127.0.0.1' or
     inet_client_addr() is distinct from inet '127.0.0.1' or
     inet_server_port() is distinct from 55432 then
    raise exception 'STOP: native bootstrap requires IPv4 loopback port 55432';
  end if;
  if current_setting('cluster_name') is distinct from 'amuhon-native-order-validation-v1' or
     current_setting('application_name') is distinct from 'amuhon-native-order-validation' or
     current_setting('app.amuhon_native_test_environment', true) is distinct from 'amuhon-native-pg-isolated-v1' or
     current_setting('app.amuhon_native_system_identifier', true) is distinct from
       (select system_identifier::text from pg_catalog.pg_control_system()) or
     current_setting('app.amuhon_native_bootstrap_nonce', true) is distinct from
       '__NATIVE_BOOTSTRAP_NONCE__' or
     current_setting('app.amuhon_native_expected_data_directory', true) is distinct from
       replace(current_setting('data_directory'), chr(92), '/') then
    raise exception 'STOP: native bootstrap cluster identity mismatch';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname in ('anon', 'authenticated', 'service_role')) or
     pg_catalog.to_regnamespace('storage') is not null then
    raise exception 'STOP: bootstrap target is not a fresh native test cluster';
  end if;
  if exists (
       select 1 from pg_catalog.pg_database
       where datname not in ('postgres', 'template0', 'template1', 'amuhon_validation_native')
     ) or not exists (
       select 1 from pg_catalog.pg_database
       where datname = 'amuhon_validation_native' and not datistemplate
     ) then
    raise exception 'STOP: cluster database set is not the dedicated native-test allowlist';
  end if;
  if exists (
       select 1 from pg_catalog.pg_roles
       where rolname !~ '^pg_' and rolname <> 'postgres'
     ) then
    raise exception 'STOP: unexpected cluster-global login or application role exists';
  end if;
  if exists (
       select 1 from pg_catalog.pg_namespace
       where nspname !~ '^pg_'
         and nspname not in ('information_schema', 'public')
     ) then
    raise exception 'STOP: unexpected user schema exists in the test database';
  end if;
  if exists (
       select 1 from pg_catalog.pg_class
       where relnamespace = 'public'::pg_catalog.regnamespace
     ) or exists (
       select 1 from pg_catalog.pg_proc
       where pronamespace = 'public'::pg_catalog.regnamespace
     ) or exists (
       select 1 from pg_catalog.pg_type
       where typnamespace = 'public'::pg_catalog.regnamespace
     ) then
    raise exception 'STOP: public schema is not empty; bootstrap requires a fresh test database';
  end if;
end;
$native_bootstrap_guard$;

-- Roles are cluster-global. This bootstrap is safe only in its dedicated cluster.
create role anon nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
create role authenticated nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
create role service_role nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;

create schema storage authorization postgres;
create schema native_test authorization postgres;
create table native_test.migration_history (
  migration_version text primary key check (migration_version ~ '^202610[0-9]{8}_[a-z0-9_]+$'),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default clock_timestamp()
);
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  bucket_id text not null,
  name text
);
alter table storage.objects enable row level security;
revoke all on schema storage from public, anon, authenticated, service_role;
revoke all on all tables in schema storage from public, anon, authenticated, service_role;
revoke all on schema native_test from public, anon, authenticated, service_role;
revoke all on all tables in schema native_test from public, anon, authenticated, service_role;

comment on schema storage is
  'Mock schema only for parsing/testing migration references; it is not Supabase Storage.';
commit;
