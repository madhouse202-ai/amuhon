import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20261021000100_order_validation_jobs.sql", import.meta.url), "utf8");
const integrationSql = await readFile(new URL("../supabase/tests/order_validation_jobs.test.sql", import.meta.url), "utf8");
const isolatedCleanupSql = await readFile(new URL("../supabase/tests/order_validation_jobs_cleanup.isolated.sql", import.meta.url), "utf8");
const priorMigration = await readFile(new URL("../supabase/migrations/20261020000300_order_temp_uploads.sql", import.meta.url), "utf8");

const rpcNames = [
  "enqueue_amuhon_order_validation_job",
  "claim_amuhon_order_validation_job",
  "complete_amuhon_order_validation_job",
  "fail_amuhon_order_validation_job",
  "retry_amuhon_order_validation_job",
];

test("validation job migration is additive, private, and has one job per temp attempt", () => {
  assert.match(migration, /create table if not exists public\.amuhon_order_validation_jobs/i);
  assert.match(migration, /attempt_id uuid primary key[\s\S]*?references public\.amuhon_order_temp_upload_attempts\s*\(id\) on delete restrict/i);
  assert.match(migration, /state in \('queued', 'validating', 'succeeded', 'failed'\)/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on public\.amuhon_order_validation_jobs from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(migration, /alter table public\.amuhon_orders|update public\.amuhon_orders|delete from public\.amuhon_orders/i);
  assert.doesNotMatch(migration, /storage\.objects|storage\.buckets/i);
  assert.doesNotMatch(migration, /alter\s+role|drop\s+table|truncate\s+table/i);
  assert.match(migration, /attempt_count >= 5/);
  assert.match(migration, /error_code is null or error_code in/);
});

test("every validation RPC is SECURITY DEFINER with pinned search path and service-only EXECUTE", () => {
  for (const name of rpcNames) {
    const marker = `function public.${name}`;
    const start = migration.indexOf(marker);
    assert.notEqual(start, -1, `${name} is defined`);
    const end = migration.indexOf("$$;", start);
    const definition = migration.slice(start, end + 3);
    assert.match(definition, /security definer/i, `${name} is SECURITY DEFINER`);
    assert.match(definition, /set search_path = pg_catalog, pg_temp/i, `${name} pins its search path`);
    const permissions = migration.slice(end + 3, end + 700);
    assert.match(permissions, /revoke all on function[\s\S]*from public, anon, authenticated/i);
    assert.match(permissions, /grant execute on function[\s\S]*to service_role/i);
  }
});

test("claim leases are exclusive, stale leases are rejected, retries are bounded, and cleanup protects active jobs", () => {
  const claimStart = migration.indexOf("function public.claim_amuhon_order_validation_job(");
  const claimEnd = migration.indexOf("$$;", claimStart);
  const claimDefinition = migration.slice(claimStart, claimEnd + 3);
  assert.match(claimDefinition, /p_lease_seconds integer default 300/i);
  assert.match(claimDefinition, /new_lease_id uuid/i);
  assert.match(claimDefinition, /new_lease_id := pg_catalog\.gen_random_uuid\(\)/i);
  assert.match(claimDefinition, /state = 'validating', lease_id = new_lease_id/i);
  assert.doesNotMatch(claimDefinition, /p_lease_id/i);
  assert.match(migration, /revoke all on function public\.claim_amuhon_order_validation_job\(integer\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.claim_amuhon_order_validation_job\(integer\) to service_role/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /target_job\.lease_id is distinct from p_lease_id/i);
  assert.match(migration, /target_job\.lease_expires_at <= clock_timestamp\(\)/i);
  assert.match(migration, /target_job\.attempt_count >= 5/i);
  assert.match(migration, /target_job\.error_code not in \([\s\S]*'storage_unavailable'[\s\S]*'internal_error'/i);
  assert.match(migration, /jobs\.state in \('queued', 'validating', 'succeeded'\)/i);
  assert.match(migration, /CLEANUP_REQUIRES_READ_COMMITTED/i);
  assert.match(migration, /a separate statement after locking each attempt/i);
  assert.match(priorMigration, /create or replace function public\.claim_expired_amuhon_order_temp_upload_attempts/i);
  assert.match(migration, /create or replace function public\.claim_expired_amuhon_order_temp_upload_attempts/i);
});

test("staging job SQL uses synthetic identifiers, avoids the global cleanup RPC, and rolls back", () => {
  assert.match(integrationSql, /confirmed_project constant text := 'amuhon-staging'/i);
  assert.match(integrationSql, /begin isolation level read committed/i);
  assert.match(integrationSql, /gen_random_uuid\(\)/i);
  assert.match(integrationSql, /insert into public\.amuhon_orders/i);
  assert.match(integrationSql, /upload_lease_id, upload_lease_expires_at/i);
  assert.doesNotMatch(integrationSql, /public\.(?:create_amuhon_order_draft_with_upload_token|begin_amuhon_order_asset_upload)\s*\(/i);
  assert.doesNotMatch(integrationSql, /amuhon_order_(?:asset_)?rate_limits/i);
  assert.match(integrationSql, /existing validation jobs could be claimed by the global worker RPC/i);
  assert.match(integrationSql, /race with concurrent enqueue\/worker activity/i);
  assert.doesNotMatch(integrationSql, /claim_expired_amuhon_order_temp_upload_attempts/i);
  assert.match(integrationSql, /EXCLUSIVE CLAIM/i);
  assert.match(integrationSql, /LEASE RECLAIM/i);
  assert.match(integrationSql, /STALE LEASE/i);
  assert.match(integrationSql, /DOUBLE COMPLETE/i);
  assert.match(integrationSql, /RETRY POLICY/i);
  assert.match(integrationSql, /ALL TESTS PASSED/i);
  assert.match(integrationSql, /rollback\s*;\s*$/i);
  assert.doesNotMatch(integrationSql, /delete\s+from\s+public\.|delete\s+from\s+storage\.|update\s+storage\./i);
  assert.doesNotMatch(integrationSql, /storage\.objects|storage\.buckets/i);
});

test("cleanup RPC integration is isolated-only, synthetic, and rolled back", () => {
  assert.match(isolatedCleanupSql, /ISOLATED DATABASE ONLY\. Never run against shared staging or production/i);
  assert.match(isolatedCleanupSql, /begin isolation level read committed/i);
  assert.match(isolatedCleanupSql, /requires an empty isolated database/i);
  assert.match(isolatedCleanupSql, /gen_random_uuid\(\)/i);
  assert.match(isolatedCleanupSql, /claim_expired_amuhon_order_temp_upload_attempts\(cleanup_lease_id, 1\)/i);
  assert.match(isolatedCleanupSql, /finish_amuhon_order_temp_upload_cleanup/i);
  assert.match(isolatedCleanupSql, /ALL ISOLATED CLEANUP TESTS PASSED/i);
  assert.match(isolatedCleanupSql, /rollback\s*;\s*$/i);
  assert.doesNotMatch(isolatedCleanupSql, /storage\.objects|storage\.buckets|delete\s+from\s+storage\./i);
});

