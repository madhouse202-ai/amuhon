import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../supabase/migrations/20261017000100_order_drafts.sql", import.meta.url), "utf8");
const integrationSql = readFileSync(new URL("../supabase/tests/order_drafts.test.sql", import.meta.url), "utf8");

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

test("integration test requires explicit staging confirmation and rolls back its test data", () => {
  assert.match(integrationSql, /target_confirmation constant text := '__CONFIRM_AMUHON_STAGING__'/i);
  assert.match(integrationSql, /target_confirmation <> 'amuhon-staging'/i);
  assert.match(integrationSql, /exists \(select 1 from public\.amuhon_orders\)[\s\S]*?exists \(select 1 from public\.amuhon_order_rate_limits\)/i);
  assert.match(integrationSql, /\$security_tests\$;\s*select 'ALL TESTS PASSED' as result;\s*rollback;/i);
  assert.match(integrationSql, /\bbegin;[\s\S]*\brollback;\s*$/i);
});
