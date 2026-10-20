import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20261020000300_order_temp_uploads.sql", import.meta.url), "utf8");
const testSql = await readFile(new URL("../supabase/tests/order_temp_uploads.test.sql", import.meta.url), "utf8");

test("temporary upload migration is additive and configures only the dedicated private bucket", () => {
  assert.match(migration, /'amuhon-order-temp-files'.*false, 40000000/s);
  assert.match(migration, /array\['application\/pdf', 'image\/png'\]/);
  assert.match(migration, /on conflict \(id\) do nothing/i);
  assert.doesNotMatch(migration, /on conflict \(id\) do update/i);
  assert.match(migration, /if not exists \([\s\S]*?storage\.buckets[\s\S]*?public is false[\s\S]*?file_size_limit = 40000000[\s\S]*?raise exception/i);
  assert.doesNotMatch(migration, /(?:insert|update|delete|truncate)\s+into?\s+storage\.objects/i);
  assert.doesNotMatch(migration, /delete\s+from\s+storage\.objects|update\s+storage\.objects/i);
  assert.match(migration, /create policy amuhon_order_temp_files_deny_public_access[\s\S]*?as restrictive[\s\S]*?for all to public/i);
  assert.doesNotMatch(migration, /alter\s+role|drop\s+table|truncate\s+table/i);
  assert.doesNotMatch(migration, /(?:insert|update|delete)\s+into\s+storage\.buckets[\s\S]*?amuhon-order-files/i);
  assert.doesNotMatch(migration, /public\.amuhon_orders\s+(?:delete|truncate)/i);
});

test("all temporary-upload RPCs are SECURITY DEFINER with restricted search path and service-only execute grants", () => {
  const functions = [
    "register_amuhon_order_temp_upload_attempt",
    "get_amuhon_order_temp_upload_attempt",
    "claim_expired_amuhon_order_temp_upload_attempts",
    "finish_amuhon_order_temp_upload_cleanup",
  ];
  for (const name of functions) {
    const start = migration.indexOf(`function public.${name}`);
    assert.notEqual(start, -1, `${name} should exist`);
    const end = migration.indexOf("$$;", start);
    const definition = migration.slice(start, end + 3);
    assert.match(definition, /security definer/i, `${name} must be SECURITY DEFINER`);
    assert.match(definition, /set search_path = pg_catalog, pg_temp/i, `${name} must pin search_path`);
    const permission = migration.slice(end + 3, end + 700);
    assert.match(permission, /revoke all on function[\s\S]*from public, anon, authenticated/i);
    assert.match(permission, /grant execute on function[\s\S]*to service_role/i);
  }
});

test("cleanup-owned and failed attempts are never reused, and historical attempts can recover the order lease", () => {
  assert.match(migration, /existing_attempt\.state <> 'issued'/i);
  assert.doesNotMatch(migration, /existing_attempt\.state not in \('issued',\s*'cleanup_failed'\)/i);
  assert.match(migration, /Return the authenticated historical attempt even after expiry\/cleanup/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(testSql, /CLEANUP RACE/);
  assert.match(testSql, /CLEANUP FAILED REUSE/);
  assert.match(testSql, /LEASE RECOVERY/);
  assert.match(testSql, /FRESH ATTEMPT/);
});

test("manual staging SQL test rolls back and reports an explicit success marker", () => {
  assert.match(testSql, /confirmed_project constant text := 'amuhon-staging'/);
  assert.match(testSql, /begin isolation level repeatable read/i);
  assert.match(testSql, /select 'ALL TESTS PASSED'/);
  assert.match(testSql, /rollback\s*;\s*$/i);
  assert.match(testSql, /wrong token registered a temp upload/i);
});

test("global cleanup RPC tests stop when existing attempts could be claimed and use a one-row bound", () => {
  const guard = testSql.indexOf("existing expired temporary-upload attempts could be claimed");
  const firstDraftWrite = testSql.indexOf("created := public.create_amuhon_order_draft_with_upload_token");
  const firstCleanupClaim = testSql.indexOf("from public.claim_expired_amuhon_order_temp_upload_attempts(");
  assert.notEqual(guard, -1, "must stop before test writes when pre-existing cleanup candidates exist");
  assert.ok(guard < firstDraftWrite, "guard must run before creating synthetic test data");
  assert.ok(guard < firstCleanupClaim, "guard must run before invoking the global cleanup RPC");
  assert.match(testSql, /attempts\.expires_at <= clock_timestamp\(\)[\s\S]*attempts\.state in \('issued', 'cleanup_failed'\)[\s\S]*attempts\.cleanup_claimed_at <= clock_timestamp\(\) - interval '10 minutes'/i);
  assert.equal((testSql.match(/claim_expired_amuhon_order_temp_upload_attempts\(cleanup_lease_id, 1\)/g) ?? []).length, 2);
  assert.doesNotMatch(testSql, /claim_expired_amuhon_order_temp_upload_attempts\(cleanup_lease_id, 10\)/);
});
