import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../scripts/verify-supabase-secret-staging.ps1", import.meta.url), "utf8");
const credential = await readFile(new URL("../lib/supabase-service-credential.ts", import.meta.url), "utf8");
const orderMigration = await readFile(new URL("../supabase/migrations/20261017000100_order_drafts.sql", import.meta.url), "utf8");
const checkoutMigration = await readFile(new URL("../supabase/migrations/20261111000100_order_stripe_livemode.sql", import.meta.url), "utf8");
const orderRoute = await readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8");

test("staging secret probes are pinned to the approved project and fixed endpoints", () => {
  assert.match(source, /ExpectedProjectRef = 'ahxnmkuvdpzctcwcyadl'/);
  assert.match(source, /ExpectedHost = \$script:ExpectedProjectRef \+ '\.supabase\.co'/);
  assert.match(source, /ApiRootUri = 'https:\/\/' \+ \$script:ExpectedHost \+ '\/rest\/v1\/'/);
  assert.match(source, /CheckoutStatusRpcUri = \$script:ApiRootUri \+ 'rpc\/get_amuhon_order_checkout_status'/);
  assert.match(source, /InvalidCheckoutStatusArgs = '\{"p_order_id":null,"p_upload_token_hash":"invalid"\}'/);
  assert.match(source, /\$request\.Method = if \(\$Stage -eq 'api_root'\) \{ 'GET' \} else \{ 'POST' \}/);
  assert.match(source, /application\/openapi\+json/);
  assert.match(source, /\$request\.AllowAutoRedirect = \$false/);
  assert.match(source, /\$request\.Proxy = \$null/);
  const refGuard = source.indexOf("if (-not (Test-ExpectedStagingUrl");
  const requestStart = source.indexOf("$newRoot = Invoke-ReadOnlyStagingRequest");
  const rpcRequest = source.indexOf("$newRpc = Invoke-ReadOnlyStagingRequest");
  assert.ok(refGuard >= 0 && requestStart > refGuard, "project Ref guard must precede the network request");
  assert.ok(rpcRequest > requestStart, "RPC probe must follow the API root check");
  assert.match(source, /if \(\$newRoot\.Passed\)[\s\S]*?Stage checkout_status_rpc/);
  assert.match(source, /\$request\.Accept = if \(\$Stage -eq 'api_root'\) \{ 'application\/openapi\+json' \}/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|legacy_service_role|legacyRoot|legacyRpc/);
});

test("staging probe uses only the new secret key as apikey", () => {
  const headerFunctionStart = source.indexOf("function Set-ProbeAuthenticationHeaders");
  const headerFunctionEnd = source.indexOf("function Assert-SelfTest", headerFunctionStart);
  const headerFunction = source.slice(headerFunctionStart, headerFunctionEnd);
  assert.match(source, /SUPABASE_SECRET_KEY/);
  assert.match(source, /Set-ProbeAuthenticationHeaders/);
  assert.match(headerFunction, /Headers\.Add\('apikey', \$ApiKey\)/);
  assert.doesNotMatch(headerFunction, /Authorization|CredentialKind/);
  assert.match(source, /api_root_access_denied_ambiguous/);
  assert.match(source, /rpc_execute_or_role_denied_after_root_pass/);
  assert.match(source, /api_key_accepted/);
  assert.match(source, /invalid_token_guard_executed_before_order_lookup/);
  assert.match(source, /rpc_guard_unexpectedly_accepted/);
});

test("existing order table revokes direct grants and application routes use guarded service RPCs", () => {
  assert.match(orderMigration, /revoke all on public\.amuhon_orders from public, anon, authenticated, service_role/i);
  assert.match(orderMigration, /grant execute on function public\.create_amuhon_order_draft\([\s\S]*?to service_role/i);
  assert.match(orderRoute, /\/rest\/v1\/rpc\/create_amuhon_order_draft_with_upload_token/);
  assert.doesNotMatch(orderRoute, /\/rest\/v1\/amuhon_orders\?/);
  assert.match(credential, /headers\.set\("apikey", credential\.apiKey\)/);
  assert.doesNotMatch(credential, /SUPABASE_SERVICE_ROLE_KEY|legacy_service_role/);
  assert.match(credential, /headers\.delete\("authorization"\)/);
  assert.match(credential, /createSupabaseServiceFetch/);
  assert.match(credential, /headers\.delete\("authorization"\)/);
});

test("checkout status RPC is read-only and rejects invalid token before order lookup", () => {
  const functionStart = checkoutMigration.indexOf("create or replace function public.get_amuhon_order_checkout_status(");
  const functionEnd = checkoutMigration.indexOf("$$;", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const functionSql = checkoutMigration.slice(functionStart, functionEnd);
  const invalidTokenGuard = functionSql.indexOf("if p_upload_token_hash is null or p_upload_token_hash !~");
  const orderLookup = functionSql.indexOf("select * into target from public.amuhon_orders");
  assert.ok(invalidTokenGuard >= 0 && orderLookup > invalidTokenGuard);
  assert.doesNotMatch(functionSql, /\b(insert|update|delete|truncate|execute)\b/i);
  assert.match(functionSql, /security definer/i);
  assert.match(functionSql, /set search_path = pg_catalog, pg_temp/i);
  assert.match(checkoutMigration, /revoke all on function public\.get_amuhon_order_checkout_status\(uuid, text\) from public, anon, authenticated/i);
  assert.match(checkoutMigration, /grant execute on function public\.get_amuhon_order_checkout_status\(uuid, text\) to service_role/i);
});

test("response bodies and exception details are never emitted", () => {
  assert.doesNotMatch(source, /Write-(?:Host|Warning|Error|Verbose).*Exception|Exception\.Message/);
  assert.doesNotMatch(source, /ReadToEnd\(|StreamReader|Write-Output[^\n]*(?:bodyText|errorInfo|GetResponseStream)/);
  assert.match(source, /Test-ExpectedCheckoutGuardResponse/);
  assert.match(source, /totalBytes -gt 4096/);
  assert.match(source, /category=configuration_or_internal_error/);
  assert.match(source, /category=project_ref_mismatch/);
});

test("local self-test is explicitly network-free", () => {
  assert.match(source, /if \(\$SelfTest\)/);
  assert.match(source, /no secret file read or network request/);
  assert.match(source, /variable_expansion_rejected/);
  assert.match(source, /duplicate_setting_rejected/);
  assert.match(source, /Get-RepositoryRootFromScript[\s\S]*?Join-Path \$PSScriptRoot '\.\.'/);
  assert.doesNotMatch(source, /Join-Path \$PSScriptRoot '\.\.\\\.\.'/);
});
