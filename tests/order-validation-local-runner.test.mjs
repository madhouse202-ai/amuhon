import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (relativePath) => readFile(path.join(repoRoot, relativePath), 'utf8');

test('local runner has a fixed loopback target and verifies CLI/Docker port ownership', async () => {
  const runner = await readRepoFile('scripts/test-order-validation-local.ps1');

  assert.match(runner, /\$defaultDbPort\s*=\s*54322/);
  assert.match(runner, /-h\s+'127\.0\.0\.1'/);
  assert.doesNotMatch(runner, /\[string\]\$DatabaseUrl|\[uri\]\$DatabaseUrl|--db-url/i);
  assert.match(runner, /supabase'\s+@\('status', '--workdir', \$workdir, '--env', '--output-format', 'text'\)/);
  assert.match(runner, /docker'\s+@\('ps', '--filter', "name=\^\/supabase_db_/);
  assert.match(runner, /docker'\s+@\('inspect', '--format', '\{\{json \.NetworkSettings\.Ports\}\}'/);
  assert.match(runner, /public\.ecr\.aws\/supabase\/postgres:\*/);
  assert.match(runner, /\$labels\.'com\.docker\.compose\.service' -ne 'db'/);
  assert.match(runner, /HostIp\s+-notin\s+@\('127\.0\.0\.1', '::1'\)/);
  assert.match(runner, /Get-NetTCPConnection -State Listen -LocalPort \$defaultDbPort/);
  assert.match(runner, /ProcessName -notin \$allowedOwners/);
  assert.match(runner, /supabase\\\.temp\\project-ref/);
  assert.doesNotMatch(runner, /Set-Content|WriteAllText|Copy-Item|Move-Item|Remove-Item/);
});

test('runner refuses ambiguous environments and closes psql on SQL error', async () => {
  const runner = await readRepoFile('scripts/test-order-validation-local.ps1');

  for (const requiredGuard of [
    'amuhon-local',
    "'127.0.0.1', 'localhost', '::1'",
    "-ne $defaultDbPort",
    'Supabase workdir must be a disposable directory outside the repository.',
    'a linked project reference',
    'could not identify exactly one running database container',
    'port listener is not an identified Docker Desktop forwarding process',
    'ON_ERROR_STOP=1',
    'PGOPTIONS',
    'PGAPPNAME',
    'PGHOSTADDR',
    'PGCONNECT_TIMEOUT',
    'statement_timeout=120000',
    'lock_timeout=5000',
  ]) {
    assert.ok(runner.includes(requiredGuard), `missing fail-closed guard: ${requiredGuard}`);
  }
  assert.doesNotMatch(runner, /supabase\s+(?:start|db\s+reset|db\s+push|migration\s+up)|--linked/i);
  assert.doesNotMatch(runner, /\.env\.local|SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE/i);
  assert.match(runner, /psql reported a test failure; its process was closed/);
});

for (const relativePath of [
  'supabase/tests/local/order_validation_targeted_claim.local.sql',
  'supabase/tests/local/order_validation_asset_commit.local.sql',
]) {
  test(`${relativePath} has local-only identity guards and one rollback transaction`, async () => {
    const sql = await readRepoFile(relativePath);

    assert.equal((sql.match(/^begin isolation level read committed;$/gim) ?? []).length, 1);
    assert.equal((sql.match(/^rollback;$/gim) ?? []).length, 1);
    assert.doesNotMatch(sql, /^\s*commit\s*;/im);
    assert.doesNotMatch(sql, /^\s*(?:commit|rollback)\s+prepared\b/im);
    assert.match(sql, /confirmed_project constant text := 'amuhon-local-isolated-v1'/);
    assert.match(sql, /current_database\(\) is distinct from 'postgres'/);
    assert.match(sql, /current_user is distinct from 'postgres'/);
    assert.match(sql, /inet_server_addr\(\) is null or inet_client_addr\(\) is null/);
    assert.match(sql, /inet_server_port\(\) is distinct from 5432/);
    assert.match(sql, /current_setting\('application_name'\) is distinct from 'amuhon-local-order-validation'/);
    assert.match(sql, /current_setting\('app\.amuhon_test_environment', true\) is distinct from 'amuhon-local-isolated-v1'/);
    assert.doesNotMatch(sql, /CHANGE_THIS_TO_CONFIRM|amuhon-staging|amuhon-order-files|amuhon-order-temp-files/i);
  });

  test(`${relativePath} uses only synthetic order/attempt/job tables, with no Storage or cleaner RPC calls`, async () => {
    const sql = await readRepoFile(relativePath);
    const normalized = sql.replace(/--[^\r\n]*/g, '');

    assert.doesNotMatch(normalized, /\bstorage\s*\./i);
    assert.doesNotMatch(normalized, /public\.(?:claim|finish|release|purge)[a-z0-9_]*cleanup[a-z0-9_]*\s*\(/i);
    assert.doesNotMatch(normalized, /public\.claim_amuhon_order_validation_job\s*\(/i);
    assert.doesNotMatch(normalized, /public\.claim_expired_amuhon_order_temp_upload_attempts\s*\(/i);
    if (relativePath.includes('targeted_claim')) {
      assert.match(normalized, /public\.claim_amuhon_order_validation_job_for_attempt\s*\(/i);
    } else {
      assert.match(normalized, /public\.commit_amuhon_order_validation_assets\s*\(/i);
    }
    for (const table of ['amuhon_orders', 'amuhon_order_temp_upload_attempts', 'amuhon_order_validation_jobs']) {
      assert.match(normalized, new RegExp(`(?:insert\\s+into|update)\\s+public\\.${table}\\b`, 'i'));
    }
    assert.doesNotMatch(normalized, /(?:insert\s+into|update|delete\s+from)\s+public\.(?!amuhon_orders\b|amuhon_order_temp_upload_attempts\b|amuhon_order_validation_jobs\b)[a-z0-9_]+/i);
    assert.doesNotMatch(normalized, /\bdelete\s+from\b/i);
  });
}

test('local asset commit test omits all cleanup eligibility/claim verification', async () => {
  const sql = await readRepoFile('supabase/tests/local/order_validation_asset_commit.local.sql');
  const normalized = sql.replace(/--[^\r\n]*/g, '');

  assert.doesNotMatch(normalized, /cleanup_eligible|cleanup_lease_id|claim_amuhon_order_temp_upload_attempt_cleanup|finish_amuhon_order_temp_upload_cleanup/i);
  assert.match(normalized, /commit_amuhon_order_validation_assets/i);
  assert.match(normalized, /complete_amuhon_order_validation_job/i);
  assert.match(normalized, /ALL TESTS PASSED/);
});

test('local claim test keeps exact-target and lease behavior without global queue calls', async () => {
  const sql = await readRepoFile('supabase/tests/local/order_validation_targeted_claim.local.sql');
  const normalized = sql.replace(/--[^\r\n]*/g, '');

  assert.match(normalized, /claim_amuhon_order_validation_job_for_attempt/i);
  assert.match(normalized, /declaredPageCount/i);
  assert.match(normalized, /LEASE RECLAIM/i);
  assert.match(normalized, /LEASE REUSE/i);
  assert.doesNotMatch(normalized, /claim_amuhon_order_validation_job\s*\(/i);
});

test('staging SQL tests retain their staging-only confirmation sentinels', async () => {
  const targeted = await readRepoFile('supabase/tests/order_validation_targeted_claim.test.sql');
  const assetCommit = await readRepoFile('supabase/tests/order_validation_asset_commit.test.sql');

  assert.match(targeted, /CHANGE_THIS_TO_CONFIRM_amuhon-staging/);
  assert.match(targeted, /confirmed_project <> 'amuhon-staging'/);
  assert.match(assetCommit, /CHANGE_THIS_TO_CONFIRM_amuhon-staging/);
  assert.match(assetCommit, /confirmed_project <> 'amuhon-staging'/);
});
