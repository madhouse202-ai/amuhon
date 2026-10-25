import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20261025000100_order_validation_targeted_claim.sql", import.meta.url), "utf8");
const sqlTest = await readFile(new URL("../supabase/tests/order_validation_targeted_claim.test.sql", import.meta.url), "utf8");
const jobsSqlTest = await readFile(new URL("../supabase/tests/order_validation_jobs.test.sql", import.meta.url), "utf8");
const docs = await readFile(new URL("../docs/ORDER_SETUP.md", import.meta.url), "utf8");

function functionDefinition(name) {
  const start = migration.indexOf(`function public.${name}`);
  assert.notEqual(start, -1, `${name} is defined`);
  const end = migration.indexOf("$$;", start);
  assert.notEqual(end, -1, `${name} body ends`);
  return migration.slice(start, end + 3);
}

test("global claim keeps its API and includes nullable declared page count", () => {
  const definition = functionDefinition("claim_amuhon_order_validation_job");
  assert.match(definition, /p_lease_seconds integer default 300\s*\) returns jsonb/i);
  assert.match(definition, /'declaredPageCount', declared_page_count/i);
  assert.match(definition, /declared_page_count := target_order\.declared_body_pdf_page_count/i);
  assert.match(definition, /for update skip locked/i);
  assert.match(definition, /target_attempt\.expires_at <= claim_checked_at \+ interval '30 seconds'/i);
  assert.match(definition, /target_order\.upload_lease_id is distinct from target_attempt\.lease_id/i);
  assert.match(definition, /target_order\.upload_lease_expires_at <= claim_checked_at \+ interval '30 seconds'/i);
  assert.match(definition, /target_order\.status <> 'preparing'/i);
  assert.match(definition, /target_order\.files_validated_at is not null/i);
  assert.match(definition, /target_order\.body_pdf_size_bytes is not null/i);
  assert.match(definition, /target_order\.upload_lease_expires_at\s*\n\s*\)/i);
  assert.match(definition, /target_job\.attempt_count >= 5/i);
  assert.match(definition, /pg_catalog\.gen_random_uuid\(\)/i);
  assert.ok(definition.indexOf("select * into target_order") < definition.indexOf("select * into target_attempt"));
  assert.ok(definition.indexOf("select * into target_attempt") < definition.indexOf("select * into target_job"));
});

test("exact claim is scoped to the supplied order and attempt with matching lease rules", () => {
  const definition = functionDefinition("claim_amuhon_order_validation_job_for_attempt");
  assert.match(definition, /p_order_id uuid,\s*p_attempt_id uuid,\s*p_lease_seconds integer default 300\s*\) returns jsonb/i);
  assert.match(definition, /from public\.amuhon_orders[\s\S]*where id = p_order_id\s*for update skip locked/i);
  assert.match(definition, /where id = p_attempt_id and order_id = p_order_id\s*for update skip locked/i);
  assert.match(definition, /where attempt_id = p_attempt_id\s*for update skip locked/i);
  assert.match(definition, /target_job\.state = 'queued'[\s\S]*target_job\.lease_expires_at <= clock_timestamp\(\)/i);
  assert.match(definition, /target_attempt\.state <> 'issued'/i);
  assert.match(definition, /target_attempt\.expires_at <= claim_checked_at \+ interval '30 seconds'/i);
  assert.match(definition, /target_order\.upload_lease_id is distinct from target_attempt\.lease_id/i);
  assert.match(definition, /target_order\.upload_lease_expires_at <= claim_checked_at \+ interval '30 seconds'/i);
  assert.match(definition, /target_order\.status <> 'preparing'/i);
  assert.match(definition, /target_order\.files_validated_at is not null/i);
  assert.match(definition, /target_job\.attempt_count >= 5/i);
  assert.match(definition, /'declaredPageCount', declared_page_count/i);
  assert.doesNotMatch(definition, /claim_amuhon_order_validation_job\s*\(/i);
  assert.ok(definition.indexOf("select * into target_order") < definition.indexOf("select * into target_attempt"));
  assert.ok(definition.indexOf("select * into target_attempt") < definition.indexOf("select * into target_job"));
});

test("both claim RPCs are SECURITY DEFINER and service-role-only", () => {
  for (const name of ["claim_amuhon_order_validation_job", "claim_amuhon_order_validation_job_for_attempt"]) {
    const definition = functionDefinition(name);
    assert.match(definition, /security definer/i);
    assert.match(definition, /set search_path = pg_catalog, pg_temp/i);
    const start = migration.indexOf(`function public.${name}`);
    const end = migration.indexOf("$$;", start) + 3;
    const grants = migration.slice(end, end + 500);
    assert.match(grants, /revoke all on function[\s\S]*from public, anon, authenticated/i);
    assert.match(grants, /grant execute on function[\s\S]*to service_role/i);
  }
  assert.doesNotMatch(migration, /alter\s+role|drop\s+table|truncate\s+table|delete\s+from\s+public\./i);
  assert.doesNotMatch(migration, /storage\.objects|storage\.buckets/i);
});

test("targeted SQL test uses synthetic rows, rollback, and never invokes global claim or cleanup", () => {
  assert.match(sqlTest, /begin isolation level read committed/i);
  assert.match(sqlTest, /confirmed_project constant text := 'CHANGE_THIS_TO_CONFIRM_amuhon-staging'/i);
  assert.match(sqlTest, /current_user <> 'postgres'/i);
  assert.match(sqlTest, /gen_random_uuid\(\)/i);
  assert.match(sqlTest, /declaredPageCount/i);
  assert.match(sqlTest, /JSON NULL/i);
  assert.match(sqlTest, /NO FALLBACK/i);
  assert.match(sqlTest, /DOUBLE CLAIM/i);
  assert.match(sqlTest, /ATTEMPT EXPIRY/i);
  assert.match(sqlTest, /ATTEMPT LIMIT/i);
  assert.match(sqlTest, /UPLOAD LEASE MISMATCH/i);
  assert.match(sqlTest, /ORDER STATE/i);
  assert.match(sqlTest, /ORDER FINALIZED/i);
  assert.match(sqlTest, /LEASE RECLAIM/i);
  assert.match(sqlTest, /ALL TARGETED CLAIM TESTS PASSED/i);
  assert.match(sqlTest, /rollback\s*;\s*$/i);
  assert.doesNotMatch(sqlTest, /public\.claim_amuhon_order_validation_job\s*\(|claim_expired_amuhon_order_temp_upload_attempts|finish_amuhon_order_temp_upload_cleanup/i);
  assert.doesNotMatch(sqlTest, /rate_limits|storage\.objects|storage\.buckets|delete\s+from\s+storage\./i);
  assert.match(jobsSqlTest, /claim_amuhon_order_validation_job\(300\)/i);
  assert.match(docs, /Do not run this test against shared staging or production/i);
  assert.match(docs, /existing SQL test `supabase\/tests\/order_validation_jobs\.test\.sql` invokes the global claim and must not be run on shared staging/i);
});
