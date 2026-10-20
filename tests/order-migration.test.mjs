import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../supabase/migrations/20261017000100_order_drafts.sql", import.meta.url), "utf8");
const assetsSql = readFileSync(new URL("../supabase/migrations/20261020000100_order_asset_uploads.sql", import.meta.url), "utf8");
const integrationSql = readFileSync(new URL("../supabase/tests/order_drafts.test.sql", import.meta.url), "utf8");
const assetIntegrationSql = readFileSync(new URL("../supabase/tests/order_asset_uploads.test.sql", import.meta.url), "utf8");

test("order migration restricts direct table, function, and storage access", () => {
  assert.match(sql, /revoke all on public\.amuhon_orders from public, anon, authenticated, service_role/i);
  assert.match(sql, /revoke all on public\.amuhon_order_rate_limits from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(sql, /\b(?:create|alter)\s+role\s+amuhon_order_executor/i);
  assert.doesNotMatch(sql, /\bgrant\s+amuhon_order_executor\b/i);
  assert.doesNotMatch(sql, /\bowner\s+to\s+amuhon_order_executor\b/i);
  assert.match(sql, /security definer[\s\S]*?set search_path = pg_catalog, pg_temp/i);
  assert.match(sql, /grant execute on function public\.create_amuhon_order_draft[^;]+ to service_role;/i);
  assert.match(sql, /grant execute on function public\.purge_expired_amuhon_order_drafts\(\) to service_role;/i);
  assert.match(sql, /drop policy if exists amuhon_order_executor_access on public\.amuhon_orders/i);
  assert.match(sql, /drop policy if exists amuhon_order_rate_limit_executor_access on public\.amuhon_order_rate_limits/i);
  assert.match(sql, /set search_path = pg_catalog, pg_temp/i);
  assert.match(sql, /revoke all on function public\.create_amuhon_order_draft[^;]+ from public, anon, authenticated;/i);
  assert.match(sql, /grant execute on function public\.create_amuhon_order_draft[^;]+ to service_role;/i);
  assert.match(sql, /create policy amuhon_order_files_deny_public_access\s+on storage\.objects as restrictive for all to public/i);
  assert.match(sql, /using \(bucket_id <> 'amuhon-order-files'\)\s+with check \(bucket_id <> 'amuhon-order-files'\)/i);
  assert.match(sql, /revoke all on function public\.purge_expired_amuhon_order_drafts\(\) from public, anon, authenticated;/i);
});

test("ready and paid statuses require verified files and final pricing", () => {
  assert.match(sql, /status not in \('ready_for_payment', 'paid'\) or \([\s\S]*?files_validated_at is not null[\s\S]*?amount_minor is not null[\s\S]*?currency is not null/i);
});

test("asset migration stores only upload-token hashes and exposes RPCs to service_role only", () => {
  assert.match(assetsSql, /add column if not exists upload_token_hash text/i);
  assert.match(assetsSql, /create or replace function public\.create_amuhon_order_draft_with_upload_token[\s\S]*?security definer[\s\S]*?set search_path = pg_catalog, pg_temp/i);
  assert.match(assetsSql, /grant execute on function public\.create_amuhon_order_draft_with_upload_token[^;]+ to service_role;/i);
  assert.match(assetsSql, /create or replace function public\.begin_amuhon_order_asset_upload[\s\S]*?security definer[\s\S]*?set search_path = pg_catalog, pg_temp/i);
  assert.match(assetsSql, /create or replace function public\.finish_amuhon_order_asset_upload/i);
  assert.match(assetsSql, /create or replace function public\.abort_amuhon_order_asset_upload/i);
  assert.match(assetsSql, /revoke all on public\.amuhon_order_asset_rate_limits from public, anon, authenticated, service_role/i);
  assert.match(assetsSql, /upload_token_hash = p_upload_token_hash/i);
  assert.match(assetsSql, /body_pdf_storage_path = p_order_id::text \|\| '\/body\.pdf'/i);
  assert.match(assetsSql, /cover_png_storage_path = p_order_id::text \|\| '\/cover\.png'/i);
  assert.match(assetsSql, /status = 'preparing'/i);
  assert.match(assetsSql, /claim_stale_amuhon_order_asset_cleanup/i);
  assert.match(assetsSql, /release_stale_amuhon_order_asset_cleanup/i);
  assert.match(assetsSql, /create table if not exists public\.amuhon_order_asset_rate_limits/i);
  assert.match(assetsSql, /revoke all on function public\.claim_stale_amuhon_order_asset_cleanup[^;]+ from public, anon, authenticated;/i);
  assert.match(assetsSql, /grant execute on function public\.claim_stale_amuhon_order_asset_cleanup[^;]+ to service_role;/i);
});

test("asset SQL integration test is staging-guarded, uses synthetic records, and rolls back", () => {
  assert.match(assetIntegrationSql, /target_confirmation constant text := 'amuhon-staging'/i);
  assert.match(assetIntegrationSql, /begin isolation level repeatable read;/i);
  assert.doesNotMatch(assetIntegrationSql, /requires empty order\/rate-limit tables/i);
  assert.match(assetIntegrationSql, /updated_at < now\(\) - interval '24 hours'/i);
  assert.match(assetIntegrationSql, /cleanup RPC could lease a pre-existing stale preparing order/i);
  assert.match(assetIntegrationSql, /order_id := gen_random_uuid\(\)/i);
  assert.match(assetIntegrationSql, /test_rate_key := md5\(gen_random_uuid\(\)::text\)/i);
  assert.match(assetIntegrationSql, /synthetic/i);
  assert.match(assetIntegrationSql, /select 'ALL TESTS PASSED' as result;\s*rollback;\s*$/i);
  assert.match(assetIntegrationSql, /\bbegin(?:\s+isolation\s+level\s+repeatable\s+read)?;[\s\S]*\brollback;\s*$/i);
});

test("integration test requires explicit staging confirmation and rolls back its test data", () => {
  assert.match(integrationSql, /target_confirmation constant text := 'amuhon-staging'/i);
  assert.match(integrationSql, /target_confirmation <> 'amuhon-staging'/i);
  assert.match(integrationSql, /exists \(select 1 from public\.amuhon_orders\)[\s\S]*?exists \(select 1 from public\.amuhon_order_rate_limits\)/i);
  assert.match(integrationSql, /\$security_tests\$;\s*select 'ALL TESTS PASSED' as result;\s*rollback;/i);
  assert.match(integrationSql, /\bbegin;[\s\S]*\brollback;\s*$/i);
});
