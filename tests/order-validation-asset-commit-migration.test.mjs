import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20261022000100_order_validation_asset_commit.sql", import.meta.url), "utf8");
const sqlTest = await readFile(new URL("../supabase/tests/order_validation_asset_commit.test.sql", import.meta.url), "utf8");
const oldUploadMigration = await readFile(new URL("../supabase/migrations/20261020000100_order_asset_uploads.sql", import.meta.url), "utf8");

const rpcSignatures = [
  "commit_amuhon_order_validation_assets(uuid, uuid, uuid, integer, text, text, text, text, integer, integer)",
  "get_amuhon_order_validation_asset_commit_status(uuid)",
  "claim_amuhon_order_temp_upload_attempt_cleanup(uuid, uuid)",
  "complete_amuhon_order_validation_job(uuid, uuid)",
  "enqueue_amuhon_order_validation_job(uuid, text, uuid)",
  "claim_expired_amuhon_order_temp_upload_attempts(uuid, integer)",
];

function functionDefinition(name) {
  const start = migration.indexOf(`function public.${name}`);
  assert.notEqual(start, -1, `${name} is defined`);
  const end = migration.indexOf("$$;", start);
  assert.notEqual(end, -1, `${name} body is terminated`);
  return migration.slice(start, end + 3);
}

test("asset commit migration is additive and keeps legacy asset-size data nullable", () => {
  assert.match(migration, /add column if not exists body_pdf_size_bytes integer/i);
  assert.match(migration, /add column if not exists cover_png_size_bytes integer/i);
  assert.match(migration, /body_pdf_size_bytes is null and cover_png_size_bytes is null/i);
  assert.match(migration, /body_pdf_size_bytes is not null and cover_png_size_bytes is not null/i);
  assert.match(migration, /body_pdf_size_bytes between 1 and 40000000/i);
  assert.match(migration, /cover_png_size_bytes between 1 and 40000000/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.(?:amuhon_orders|amuhon_order_temp_upload_attempts|amuhon_order_validation_jobs)/i);
  assert.doesNotMatch(migration, /delete\s+from\s+storage\.|update\s+storage\./i);
  assert.doesNotMatch(migration, /drop\s+table|truncate\s+table|alter\s+role/i);
  assert.equal((migration.match(/\$\$/g) ?? []).length % 2, 0, "all dollar-quoted function bodies are paired");
});

test("commit validates pages, hashes, file sizes, associations, and canonical attempt keys", () => {
  const definition = functionDefinition("commit_amuhon_order_validation_assets");
  assert.match(definition, /p_body_pdf_page_count < 24/i);
  assert.match(definition, /p_body_pdf_page_count > 496/i);
  assert.match(definition, /p_body_pdf_page_count % 8 <> 0/i);
  assert.match(definition, /\[a-f0-9\]\{64\}/i);
  assert.match(definition, /p_body_pdf_size_bytes > 40000000/i);
  assert.match(definition, /p_cover_png_size_bytes > 40000000/i);
  assert.match(definition, /target_order\.declared_body_pdf_page_count/i);
  assert.match(definition, /target_attempt\.order_id is distinct from p_order_id/i);
  assert.match(definition, /target_job\.lease_id is distinct from p_lease_id/i);
  assert.match(definition, /target_job\.lease_expires_at <= commit_time/i);
  assert.match(definition, /target_attempt\.expires_at <= commit_time/i);
  assert.match(definition, /body_object_key is distinct from \(p_order_id::text \|\| '[\s\S]*body\.pdf/i);
  assert.match(definition, /cover_object_key is distinct from \(p_order_id::text \|\| '[\s\S]*cover\.png/i);
  assert.match(definition, /select \* into target_order[\s\S]*?for update[\s\S]*?select \* into target_attempt[\s\S]*?for update[\s\S]*?select \* into target_job[\s\S]*?for update/i);
  assert.match(definition, /update public\.amuhon_orders set[\s\S]*?files_validated_at = commit_time/i);
  assert.match(definition, /update public\.amuhon_order_validation_jobs set[\s\S]*?state = 'succeeded'/i);
  const orderUpdate = definition.match(/update public\.amuhon_orders set([\s\S]*?)where id = p_order_id/i)?.[1] ?? "";
  assert.match(orderUpdate, /body_pdf_page_count/);
  assert.doesNotMatch(orderUpdate, /status\s*=|amount_minor|shipping_minor|currency\s*=|stripe_payment_id/i);
});

test("new RPCs are private SECURITY DEFINER functions with fixed search path", () => {
  for (const signature of rpcSignatures) {
    const name = signature.slice(0, signature.indexOf("("));
    const definition = functionDefinition(name);
    assert.match(definition, /security definer/i, `${name} uses SECURITY DEFINER`);
    assert.match(definition, /set search_path = pg_catalog, pg_temp/i, `${name} pins search_path`);
    const start = migration.indexOf(`function public.${name}`);
    const ending = migration.indexOf("$$;", start) + 3;
    const permissions = migration.slice(ending, ending + 500);
    assert.match(permissions, /revoke all on function[\s\S]*from public, anon, authenticated/i);
    assert.match(permissions, /grant execute on function[\s\S]*to service_role/i);
  }
});

test("read-only outcome lookup and standalone complete cannot finalize a job", () => {
  const status = functionDefinition("get_amuhon_order_validation_asset_commit_status");
  assert.doesNotMatch(status, /\binsert\s+into\b|\bupdate\s+public\.|\bdelete\s+from\b/i);
  const complete = functionDefinition("complete_amuhon_order_validation_job");
  assert.match(complete, /raise exception 'ATOMIC_ASSET_FINALIZATION_REQUIRED'/i);
  assert.doesNotMatch(complete, /update public\.amuhon_order_validation_jobs/i);
});

test("cleanup eligibility requires committed matching order assets for succeeded jobs", () => {
  const eligibility = functionDefinition("amuhon_order_temp_upload_attempt_cleanup_eligible");
  assert.match(eligibility, /jobs\.state = 'succeeded'[\s\S]*orders\.files_validated_at is not null/i);
  assert.match(eligibility, /orders\.body_pdf_storage_path = \(attempts\.order_id::text \|\| '[\s\S]*attempts\.id::text \|\| '[\s\S]*body\.pdf/i);
  assert.match(eligibility, /orders\.cover_png_storage_path = \(attempts\.order_id::text \|\| '[\s\S]*attempts\.id::text \|\| '[\s\S]*cover\.png/i);
  assert.match(functionDefinition("claim_amuhon_order_temp_upload_attempt_cleanup"), /for update skip locked/i);
  assert.match(functionDefinition("claim_expired_amuhon_order_temp_upload_attempts"), /order_temp_upload_attempt_cleanup_eligible/i);
  assert.match(migration, /create or replace function public\.claim_expired_amuhon_order_temp_upload_attempts\([\s\S]*?\) returns table \(attempt_id uuid, order_id uuid, body_object_key text, cover_object_key text\)/i);
});

test("staging integration test is synthetic, rolled back, and avoids global claim or external Storage", () => {
  assert.match(sqlTest, /begin isolation level read committed/i);
  assert.match(sqlTest, /confirmed_project constant text := 'CHANGE_THIS_TO_CONFIRM_amuhon-staging'/i);
  assert.match(sqlTest, /current_user <> 'postgres'/i);
  assert.match(sqlTest, /gen_random_uuid\(\)/i);
  assert.match(sqlTest, /ALL TESTS PASSED/i);
  assert.match(sqlTest, /rollback\s*;\s*$/i);
  assert.doesNotMatch(sqlTest, /claim_amuhon_order_validation_job\s*\(|claim_expired_amuhon_order_temp_upload_attempts\s*\(|(?:create_amuhon_order_draft_with_upload_token|begin_amuhon_order_asset_upload)\s*\(/i);
  assert.doesNotMatch(sqlTest, /amuhon_order_(?:asset_)?rate_limits|storage\.objects|storage\.buckets|delete\s+from\s+storage\./i);
  assert.match(sqlTest, /ATOMIC_ASSET_FINALIZATION_REQUIRED/i);
  assert.match(sqlTest, /DECLARED_PAGE_COUNT_MISMATCH/i);
  assert.match(sqlTest, /HASH MISMATCH/i);
  assert.match(sqlTest, /synthetic reclaim/i);
  assert.match(sqlTest, /legacy finalizer must not overwrite/i);
  assert.match(sqlTest, /uncommitted validating attempt was claimable/i);
  assert.match(sqlTest, /committed expired attempt was not claimable/i);
  assert.match(sqlTest, /finish_amuhon_order_temp_upload_cleanup/i);
  assert.match(sqlTest, /only simulates a Storage deletion/i);
});

test("legacy upload finalizer remains available and refuses conflicting finalized bytes", () => {
  assert.match(oldUploadMigration, /create or replace function public\.finish_amuhon_order_asset_upload/i);
  assert.match(oldUploadMigration, /raise exception 'ORDER_FILES_ALREADY_FINALIZED'/i);
  assert.match(sqlTest, /finish_amuhon_order_asset_upload/i);
});
