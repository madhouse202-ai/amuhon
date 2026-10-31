import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const readBytes = (path) => readFile(new URL(path, import.meta.url));

function maskSqlCommentsAndLiterals(source) {
  const output = [...source];
  let index = 0;
  let blockDepth = 0;
  let quote = null;
  let dollarTag = null;
  let lineComment = false;
  const blank = (at) => {
    if (output[at] !== '\n' && output[at] !== '\r') output[at] = ' ';
  };

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      blank(index);
      if (current === '\n') lineComment = false;
      index++;
      continue;
    }
    if (blockDepth > 0) {
      if (current === '/' && next === '*') {
        blank(index); blank(index + 1); blockDepth++; index += 2; continue;
      }
      if (current === '*' && next === '/') {
        blank(index); blank(index + 1); blockDepth--; index += 2; continue;
      }
      blank(index++);
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        for (let offset = 0; offset < dollarTag.length; offset++) blank(index + offset);
        index += dollarTag.length;
        dollarTag = null;
      } else blank(index++);
      continue;
    }
    if (quote) {
      blank(index);
      if (current === quote) {
        if (next === quote) { blank(index + 1); index += 2; continue; }
        quote = null;
      } else if (current === '\\' && quote === "'") {
        // PostgreSQL string-escape rules depend on prefixes and session GUCs.
        // This static boundary checker refuses such input instead of guessing.
        assert.fail('backslash in SQL string makes transaction-boundary parsing ambiguous');
      }
      index++;
      continue;
    }
    if (current === '-' && next === '-') { blank(index); blank(index + 1); lineComment = true; index += 2; continue; }
    if (current === '/' && next === '*') { blank(index); blank(index + 1); blockDepth = 1; index += 2; continue; }
    if (current === "'" || current === '"') { blank(index); quote = current; index++; continue; }
    const dollarMatch = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (dollarMatch) {
      dollarTag = dollarMatch[0];
      for (let offset = 0; offset < dollarTag.length; offset++) blank(index + offset);
      index += dollarTag.length;
      continue;
    }
    index++;
  }
  assert.equal(blockDepth, 0, 'unterminated SQL block comment');
  assert.equal(quote, null, 'unterminated SQL quote');
  assert.equal(dollarTag, null, 'unterminated SQL dollar quote');
  return output.join('');
}

function getSqlStatements(source, { allowOnlyOnErrorStop = true } = {}) {
  if (allowOnlyOnErrorStop) {
    for (const line of source.split(/\r?\n/)) {
      if (/^\s*\\/.test(line) && !/^\s*\\set\s+ON_ERROR_STOP\s+on\s*$/i.test(line)) {
        assert.fail(`disallowed psql meta-command: ${line.trim().split(/\s+/)[0]}`);
      }
    }
    const setCommands = source.split(/\r?\n/).filter((line) => /^\s*\\set\s+ON_ERROR_STOP\s+on\s*$/i.test(line));
    assert.equal(setCommands.length, 1, 'expected exactly one approved psql setting');
  }

  const sqlWithoutPsql = source.split(/\r?\n/)
    .filter((line) => !/^\s*\\set\s+ON_ERROR_STOP\s+on\s*$/i.test(line))
    .join('\n');
  const masked = maskSqlCommentsAndLiterals(sqlWithoutPsql);
  const statements = [];
  let start = 0;
  for (let index = 0; index < masked.length; index++) {
    if (masked[index] === ';') {
      statements.push(masked.slice(start, index).trim());
      start = index + 1;
    }
  }
  const trailing = masked.slice(start).trim();
  if (trailing) assert.fail('executable SQL exists after the final semicolon');
  return statements.filter(Boolean);
}

function assertRollbackOnly(source) {
  const statements = getSqlStatements(source);
  assert.match(statements[0] ?? '', /^begin\s+isolation\s+level\s+read\s+committed$/i);
  assert.match(statements.at(-1) ?? '', /^rollback$/i);
  return statements;
}

test('native runner pins target and does not manage PostgreSQL lifecycle', async () => {
  const runner = await read('../scripts/native-postgres/test-order-validation-native.ps1');
  const pathModule = await read('../scripts/native-postgres/native-postgres-path-safety.psm1');
  assert.match(runner, /\$expectedPort = 55432/);
  assert.match(runner, /\$expectedDatabase = 'amuhon_validation_native'/);
  assert.match(runner, /'-h', '127\.0\.0\.1'/);
  assert.doesNotMatch(runner, /param\s*\([^)]*(?:DatabaseUrl|ConnectionString|DbUrl)/is);
  assert.doesNotMatch(runner, /(?:^|[;&|]\s*)(?:initdb|createdb|dropdb|pg_ctl\s+(?:start|stop|register|unregister)|supabase\s+db\s+(?:reset|push|pull)|(?:drop|truncate)\s+(?:database|table))/im);
  assert.match(runner, /'-X'/);
  assert.match(runner, /'ON_ERROR_STOP=1'/);
  assert.match(runner, /'-W'/);
  assert.ok(runner.includes("SetEnvironmentVariable('PGPASSFILE', 'NUL'"));
  assert.match(runner, /pg_controldata/);
  assert.match(runner, /Assert-NativeSystemIdentifier \$controlLines \(\[string\]\$identity\.systemIdentifier\)/);
  assert.doesNotMatch(runner, /Database system identifier:\\s\*/);
  assert.match(runner, /pg_control_system\(\)/);
  assert.match(runner, /Get-NetTCPConnection/);
  assert.match(runner, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(runner, /GetOwner/);
  assert.match(runner, /Test-NativePgHbaRules \(Get-Content -LiteralPath \$hbaFile\)/);
  assert.match(runner, /pg_hba\.conf must contain only the four reviewed rules in the exact required order/);
  assert.match(pathModule, /function Test-NativePgHbaRules[\s\S]*?host postgres postgres 127\.0\.0\.1\/32 scram-sha-256[\s\S]*?host amuhon_validation_native postgres 127\.0\.0\.1\/32 scram-sha-256[\s\S]*?host all all 127\.0\.0\.1\/32 reject[\s\S]*?host all all ::1\/128 reject/);
  assert.match(pathModule, /activeRules\[\$i\][\s\S]*?Ordinal/);
  assert.match(pathModule, /function Assert-NativeSystemIdentifier[\s\S]*?Database system identifier\|\\u30C7[\s\S]*?identifierLines\.Count -ne 1[\s\S]*?StringComparison\]::Ordinal/);
  assert.match(runner, /app\.amuhon_native_test_environment/);
  assert.match(runner, /app\.amuhon_native_system_identifier/);
  assert.match(runner, /Test-PathIsInside \$rootPath \$repoRoot/);
  assert.match(pathModule, /function Test-CanonicalPathEqual[\s\S]*?OrdinalIgnoreCase/);
  assert.match(runner, /\$script:environmentCaptured = \$true[\s\S]*?SetEnvironmentVariable\(\$name, \$null/);
  assert.match(runner, /finally\s*\{[\s\S]*Restore-NativeClientEnvironment/);
  assert.match(runner, /Assert-NativeLocalDrivePath \$NativeRoot/);
  assert.match(runner, /Import-Module -Name \$pathSafetyModule/);
  assert.match(pathModule, /GetPathRoot\(\$fullPath\)/);
  assert.match(pathModule, /expandedPath -notmatch '\^\[A-Za-z\]:\[\\\\\/\]'/);
  assert.match(pathModule, /if \(\$fullPath\.Equals\(\$rootPath/);
  assert.match(pathModule, /if \(\$currentPath\.Equals\(\$rootPath[\s\S]*?break/);
  assert.match(pathModule, /UNC and device paths are not accepted/);
  assert.match(pathModule, /Test-PathIsInside[\s\S]*OrdinalIgnoreCase/);
  assert.ok(pathModule.includes("return Join-Path $canonicalRoot 'pgsql\\bin'"));
  assert.match(pathModule, /Export-ModuleMember[^\r\n]*Get-NativeBinaryDirectory/);
  assert.match(runner, /Get-NativeBinaryDirectory \$rootPath/);
  assert.doesNotMatch(runner, /Join-Path \$rootPath 'bin'/);
});

test('migration runner is fixed, gated, ordered, atomic, and refuses partial reapplication', async () => {
  const runner = await read('../scripts/native-postgres/apply-order-validation-native.ps1');
  const pathModule = await read('../scripts/native-postgres/native-postgres-path-safety.psm1');
  const versions = [
    '20261017000100_order_drafts',
    '20261020000100_order_asset_uploads',
    '20261020000200_order_asset_size_limit',
    '20261020000300_order_temp_uploads',
    '20261021000100_order_validation_jobs',
    '20261022000100_order_validation_asset_commit',
    '20261025000100_order_validation_targeted_claim',
  ];
  const declared = [...runner.matchAll(/^\s*'((?:2026)[0-9]+_[a-z0-9_]+)'\s*,?\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(declared, versions);
  assert.match(runner, /Get-NativeBinaryDirectory \$rootPath/);
  assert.doesNotMatch(runner, /Join-Path \$rootPath 'bin'/);
  assert.match(runner, /test-order-validation-native\.ps1'\s*\n\s*if[\s\S]*?-PreflightOnly/);
  assert.match(runner, /'-1'/);
  assert.match(runner, /'-h', '127\.0\.0\.1'/);
  assert.match(runner, /'-p', '55432'/);
  assert.match(runner, /'-d', 'amuhon_validation_native'/);
  assert.match(runner, /'-W'/);
  assert.match(runner, /-not \[string\]::Equals\([\s\S]*\[string\]\$identity\.osOwner[\s\S]*\[StringComparison\]::OrdinalIgnoreCase[\s\S]*\)/);
  assert.doesNotMatch(runner, /\[string\]\$identity\.osOwner\s+-cne\b/);
  assert.match(runner, /migration_history/);
  assert.match(runner, /sha256/);
  assert.match(runner, /migration ledger is partial or out of order/);
  assert.match(runner, /already migrated, partial, or not pristine/);
  assert.match(runner, /exists \(select 1 from storage\.objects\)/);
  assert.match(runner, /relrowsecurity/);
  assert.match(runner, /replace\(current_setting\('data_directory'\), chr\(92\), '\/'\)/);
  assert.match(pathModule, /OrdinalIgnoreCase/);
  assert.match(runner, /rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolbypassrls/);
  assert.match(runner, /unexpected user schema exists/);
  assert.match(runner, /cluster database allowlist mismatch/);
  assert.doesNotMatch(runner, /\$DatabaseUrl|\$ConnectionString|\$DbUrl|\$Host\b|\$Port\b/i);
  assert.doesNotMatch(runner, /SetEnvironmentVariable\(\s*'PGPASSWORD'\s*,\s*[^n]/i);
  assert.doesNotMatch(runner, /supabase\s+db\s+(?:push|reset)|\b(?:initdb|createdb|dropdb)\b/i);
  assert.match(runner, /finally\s*\{[\s\S]*Restore-NativeEnvironment/);
  const hashEntries = [...runner.matchAll(/^\s*'([^']+)'\s*=\s*'([a-f0-9]{64})'\s*$/gm)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(hashEntries.map(([version]) => version), versions);
  assert.ok(runner.indexOf('approved SHA-256 mismatch') < runner.indexOf('& $psql @psqlArguments'), 'pinned hashes are checked before SQL execution');
  for (const [version, expectedHash] of hashEntries) {
    const bytes = await readBytes(`../supabase/migrations/${version}.sql`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, `${version} pinned digest`);
    const source = bytes.toString('utf8');
    assert.doesNotMatch(source, /^\s*\\/m, `${version} has no psql meta-command`);
    assert.doesNotMatch(source, /^\s*(?:begin|commit|rollback)\s*;/im, `${version} has no transaction control`);
    assert.doesNotMatch(source, /\b(?:create\s+(?:unique\s+)?index\s+concurrently|vacuum|cluster)\b/i, `${version} has no known non-transactional command`);
  }
  const doc = await read('../docs/ORDER_VALIDATION_NATIVE_POSTGRES_TESTS.md');
  for (const [version, expectedHash] of hashEntries) {
    assert.ok(doc.includes(`| \`${version}.sql\` | \`${expectedHash}\` |`), `${version} documented digest`);
  }
});

test('bootstrap wrapper requires shared live preflight and a fixed local target', async () => {
  const runner = await read('../scripts/native-postgres/apply-order-validation-native-bootstrap.ps1');
  assert.match(runner, /test-order-validation-native\.ps1'[\s\S]*?-PreflightOnly/);
  assert.match(runner, /Get-NativeBinaryDirectory \$rootPath/);
  assert.doesNotMatch(runner, /Join-Path \$rootPath 'bin'/);
  assert.match(runner, /Assert-NativeLocalDrivePath \$NativeRoot/);
  assert.match(runner, /'-h', '127\.0\.0\.1'/);
  assert.match(runner, /'-p', '55432'/);
  assert.match(runner, /'-d', 'amuhon_validation_native'/);
  assert.match(runner, /'-W'/);
  assert.match(runner, /-not \[string\]::Equals\([\s\S]*\[string\]\$identity\.osOwner[\s\S]*\[StringComparison\]::OrdinalIgnoreCase[\s\S]*\)/);
  assert.doesNotMatch(runner, /\[string\]\$identity\.osOwner\s+-cne\b/);
  assert.match(runner, /PGHOSTADDR/);
  assert.match(runner, /PGSERVICEFILE/);
  assert.match(runner, /PGPASSWORD/);
  assert.match(runner, /'-X', '-v', 'ON_ERROR_STOP=1'/);
  assert.match(runner, /__NATIVE_BOOTSTRAP_NONCE__/);
  assert.match(runner, /\[guid\]::NewGuid\(\)\.ToString\('N'\)/);
  assert.match(runner, /Test-NativeBootstrapTransactionStructure \$bootstrapText/);
  assert.doesNotMatch(runner, /\$bootstrapText -match .*commit\|rollback/s);
  assert.match(runner, /finally\s*\{[\s\S]*Restore-NativeEnvironment/);
  assert.doesNotMatch(runner, /\$DatabaseUrl|\$ConnectionString|\$DbUrl|\$Host\b|\$Port\b/i);
  const bootstrapSql = await read('../supabase/tests/native/bootstrap.sql');
  assert.match(bootstrapSql, /current_setting\('app\.amuhon_native_expected_data_directory'/);
  assert.match(bootstrapSql, /current_setting\('app\.amuhon_native_bootstrap_nonce'[\s\S]*'__NATIVE_BOOTSTRAP_NONCE__'/);
  assert.doesNotMatch(runner, /-d',\s*\$baselineDatabase/);
  const docs = await read('../docs/ORDER_VALIDATION_NATIVE_POSTGRES_TESTS.md');
  assert.match(docs, /apply-order-validation-native-bootstrap\.ps1/);
  assert.doesNotMatch(docs, /psql[^\r\n]*bootstrap\.sql/i);
});

test('bootstrap rejects non-fresh catalog objects and checks its trusted data-directory marker', async () => {
  const sql = await read('../supabase/tests/native/bootstrap.sql');
  assert.match(sql, /current_setting\('app\.amuhon_native_expected_data_directory'[\s\S]*replace\(current_setting\('data_directory'/);
  assert.match(sql, /pg_catalog\.pg_type[\s\S]*typnamespace = 'public'/);
  assert.match(sql, /datname not in \('postgres', 'template0', 'template1', 'amuhon_validation_native'\)/);
  assert.match(sql, /rolname !~ '\^pg_' and rolname <> 'postgres'/);
  assert.match(sql, /nspname not in \('information_schema', 'public'\)/);
});

test('native PowerShell path unit test covers drive roots and rejects UNC/relative paths', async () => {
  const psTest = await read('../tests/native-postgres-path-safety.test.ps1');
  assert.match(psTest, /GetPathRoot/);
  assert.match(psTest, /Get-CanonicalPath \$driveRoot/);
  assert.match(psTest, /Assert-NoReparsePath \$driveRoot/);
  assert.match(psTest, /\\\\server\\share\\native/);
  assert.match(psTest, /relative\\native/);
  assert.match(psTest, /C:native\\cluster/);
  assert.match(psTest, /Get-NativeBinaryDirectory \$nativeRoot/);
  assert.ok(psTest.includes("'C:\\amuhon-native-pg\\pgsql\\bin'"));
  assert.ok(psTest.includes('legacy NativeRoot\\bin'));
  const pathModule = await read('../scripts/native-postgres/native-postgres-path-safety.psm1');
  assert.ok(pathModule.includes("return Join-Path $canonicalRoot 'pgsql\\bin'"));
});

test('all native wrappers use only the reviewed pgsql\\bin layout', async () => {
  const files = [
    '../scripts/native-postgres/test-order-validation-native.ps1',
    '../scripts/native-postgres/apply-order-validation-native-bootstrap.ps1',
    '../scripts/native-postgres/apply-order-validation-native.ps1',
  ];
  for (const file of files) {
    const source = await read(file);
    assert.match(source, /Get-NativeBinaryDirectory \$rootPath/, file);
    assert.doesNotMatch(source, /Join-Path \$rootPath 'bin'/, file);
  }
  const docs = await read('../docs/ORDER_VALIDATION_NATIVE_POSTGRES_TESTS.md');
  assert.ok(docs.includes('pgsql\\bin'));
  assert.match(docs, /do not fall back to the former `NativeRoot\\bin` layout/i);
});

test('native bootstrap is guarded, isolated, and explicitly mocks Storage only', async () => {
  const sql = await read('../supabase/tests/native/bootstrap.sql');
  assert.match(sql, /begin;/i);
  assert.match(sql, /commit;/i);
  assert.match(sql, /current_database\(\).*amuhon_validation_native/s);
  assert.match(sql, /inet_server_port\(\).*55432/s);
  assert.match(sql, /pg_control_system\(\)/);
  assert.match(sql, /create schema storage/i);
  assert.match(sql, /Mock schema only.*not Supabase Storage/s);
  assert.match(sql, /if exists \(select 1 from pg_catalog\.pg_roles/s);
  assert.match(sql, /public schema is not empty/s);
  assert.match(sql, /must never be applied to amuhon or amuhon-staging/i);
});

for (const file of [
  '../supabase/tests/native/order_validation_targeted_claim.native.sql',
  '../supabase/tests/native/order_validation_asset_commit.native.sql',
]) {
  test(`${file} is synthetic, rollback-only, and avoids global/external operations`, async () => {
    const sql = await read(file);
    const statements = assertRollbackOnly(sql);
    assert.match(sql, /begin isolation level read committed;/i);
    assert.match(sql, /\brollback\s*;\s*$/i);
    assert.match(statements[0], /^begin\s+isolation\s+level\s+read\s+committed$/i);
    assert.match(statements.at(-1), /^rollback$/i);
    assert.ok(statements.length >= 4, 'test contains explicit guarded setup and assertions');
    assert.match(sql, /current_database\(\).*amuhon_validation_native/s);
    assert.match(sql, /inet_server_port\(\).*55432/s);
    assert.match(sql, /pg_control_system\(\)/);
    assert.match(sql, /app\.amuhon_native_test_environment/);
    assert.match(sql, /app\.amuhon_native_system_identifier/);
    assert.doesNotMatch(sql, /claim_amuhon_order_validation_job\s*\(/i);
    assert.doesNotMatch(sql, /claim_expired_amuhon_order_temp_upload_attempts|claim_amuhon_order_temp_upload_attempt_cleanup|finish_amuhon_order_temp_upload_cleanup/i);
    assert.doesNotMatch(sql, /storage\.(?:objects|buckets)|storage\.from/i);
    assert.doesNotMatch(sql, /\b(?:delete\s+from|truncate|drop\s+(?:table|schema|function))\b/i);
    assert.doesNotMatch(sql, /\bcommit\s*;/i);
  });
}

test('targeted claim expiry outcomes are read in statements after the mutating RPC', async () => {
  const sql = await read('../supabase/tests/native/order_validation_targeted_claim.native.sql');
  for (const [orderId, attemptId, expectedCode, marker] of [
    ['order_expired_attempt', 'attempt_expired', 'attempt_expired', 'ATTEMPT EXPIRY'],
    ['order_expired_upload_lease', 'attempt_expired_upload', 'attempt_expired', 'UPLOAD LEASE'],
    ['order_max_attempts', 'attempt_max_attempts', 'processing_timeout', 'ATTEMPT LIMIT'],
  ]) {
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const check = new RegExp(
      `result\\s*:=\\s*public\\.claim_amuhon_order_validation_job_for_attempt\\(${orderId},\\s*${attemptId},\\s*300\\);\\s*` +
      `if\\s+result\\s+is\\s+not\\s+null\\s+then[\\s\\S]*?\\[${escapedMarker} RESULT\\][\\s\\S]*?end if;\\s*` +
      `select\\s+j\\.state,\\s*j\\.error_code\\s+into\\s+observed_job_state,\\s*observed_error_code[\\s\\S]*?` +
      `where\\s+j\\.attempt_id\\s*=\\s*${attemptId};\\s*` +
      `if\\s+not\\s+found\\s+then[\\s\\S]*?\\[${escapedMarker} ROW\\][\\s\\S]*?end if;\\s*` +
      `if\\s+observed_job_state\\s+is\\s+distinct\\s+from\\s+'failed'\\s+or\\s+observed_error_code\\s+is\\s+distinct\\s+from\\s+'${expectedCode}'\\s+then`,
      'i',
    );
    assert.match(sql, check, `${marker} RPC result and persisted state are checked separately`);
  }
});

test('native SQL tests reject executable content outside the rollback transaction and unauthorized psql commands', () => {
  assert.throws(() => getSqlStatements('\\connect amuhon-staging\n\\set ON_ERROR_STOP on\nbegin; rollback;'), /disallowed psql meta-command/);
  assert.throws(() => assertRollbackOnly('\\set ON_ERROR_STOP on\nselect 1; begin; rollback;'));
  assert.throws(() => assertRollbackOnly('\\set ON_ERROR_STOP on\nbegin isolation level read committed; rollback; select 2;'));
  assert.throws(() => getSqlStatements('\\connect staging\n\\set ON_ERROR_STOP on\nbegin; rollback;'), /disallowed psql meta-command/);
  assert.throws(() => getSqlStatements('\\set ON_ERROR_STOP on\nbegin; rollback;\n\\! whoami'), /disallowed psql meta-command/);
  assert.throws(() => assertRollbackOnly("\\set ON_ERROR_STOP on\nbegin isolation level read committed; select E'\\\\\\\''; rollback;"), /backslash in SQL string/);
});

test('native PostgreSQL process identity parses argv and matches executable and one exact -D path', async () => {
  const helper = await read('../scripts/native-postgres/native-postgres-path-safety.psm1');
  const runner = await read('../scripts/native-postgres/test-order-validation-native.ps1');
  assert.match(helper, /CommandLineToArgvW/);
  assert.match(helper, /arguments\[0\]/);
  assert.match(helper, /dataOptionIndexes\.Count\s+-ne\s+1/);
  assert.match(helper, /Test-CanonicalPathEqual\s+\(\[string\]\$arguments\[\$dataIndex \+ 1\]\)\s+\$ExpectedDataDirectory/);
  assert.match(runner, /Test-NativePostgresCommandLine\s+\$processCommandLine\s+\$postgresExe\s+\$dataDirectory/);
  assert.doesNotMatch(runner, /processCommandLine\.IndexOf\(/);
});

test('database identity probe compares the IPv4 host portion without weakening the exact loopback check', async () => {
  const runner = await read('../scripts/native-postgres/test-order-validation-native.ps1');
  assert.match(runner, /coalesce\(host\(inet_server_addr\(\)\), ''\)/);
  assert.match(runner, /coalesce\(host\(inet_client_addr\(\)\), ''\)/);
  assert.match(runner, /\$probeFields\[2\] -cne '127\.0\.0\.1'/);
  assert.match(runner, /\$probeFields\[3\] -cne '127\.0\.0\.1'/);
  assert.doesNotMatch(runner, /inet_(?:server|client)_addr\(\)::text/);
});

test('asset commit test disambiguates PL/pgSQL variables from column names', async () => {
  const sql = await read('../supabase/tests/native/order_validation_asset_commit.native.sql');
  assert.match(sql, /where j\.attempt_id = v_attempt_id/);
  assert.doesNotMatch(sql, /where\s+attempt_id\s*=\s*attempt_id\b/i);
  assert.doesNotMatch(sql, /where\s+id\s*=\s*order_id\b/i);
});

test('concurrency is documented but deliberately not automated in a single-session SQL file', async () => {
  const doc = await read('../supabase/tests/native/order_validation_concurrency.native.md');
  assert.match(doc, /guarded wrapper/i);
  assert.match(doc, /two PowerShell windows/i);
  assert.match(doc, /SKIP LOCKED/i);
  assert.match(doc, /synthetic/i);
});

test('concurrency harness is isolated from ordinary tests and pins every connection', async () => {
  const runner = await read('../scripts/native-postgres/test-order-validation-concurrency-native.ps1');
  const processRunner = await read('../scripts/native-postgres/native-process-runner.psm1');
  const ordinaryRunner = await read('../scripts/native-postgres/test-order-validation-native.ps1');
  assert.match(runner, /ValidateSet\('Prepare', 'Hold', 'Probe', 'ClaimAfterUnlock', 'Status', 'Diagnose', 'Cleanup'\)/);
  assert.match(runner, /ValidateSet\('order', 'attempt', 'job'\)/);
  assert.match(runner, /Invoke-GuardedPreflight \$rootPath/);
  assert.match(runner, /-PreflightOnly/);
  assert.match(runner, /'-h', '127\.0\.0\.1', '-p', '55432', '-U', 'postgres', '-d', 'amuhon_validation_native'/);
  assert.match(runner, /PGHOSTADDR/);
  assert.match(runner, /SetEnvironmentVariable\('PGPASSFILE', 'NUL'/);
  assert.match(runner, /'PGPASSWORD'/);
  assert.match(runner, /SetEnvironmentVariable\(\$name, \$null, 'Process'\)/);
  assert.match(runner, /finally\s*\{\s*Restore-NativeConcurrencyEnvironment/s);
  assert.match(runner, /Import-Module -Name \$processRunnerModule -Force -ErrorAction Stop/);
  assert.match(runner, /Invoke-NativeProcessWithTimeout -FilePath \$PsqlExe -Arguments \$Arguments -TimeoutSeconds \$TimeoutSeconds/);
  assert.match(processRunner, /New-Object System\.Diagnostics\.ProcessStartInfo/);
  assert.match(processRunner, /\$startInfo\.FileName = \$FilePath/);
  assert.match(processRunner, /\$startInfo\.Arguments = \[string\]::Join\(' ', \$Arguments\)/);
  assert.match(processRunner, /\$startInfo\.UseShellExecute = \$false/);
  assert.match(processRunner, /\[System\.Diagnostics\.Process\]::Start\(\$startInfo\)/);
  assert.doesNotMatch(processRunner, /^\s*\$process\s*=\s*Start-Process\b/m);
  assert.match(processRunner, /WaitForExit\(\$TimeoutSeconds \* 1000\)/);
  assert.match(processRunner, /\.Refresh\(\)/);
  assert.match(processRunner, /\[int\]\$process\.ExitCode/);
  assert.match(processRunner, /if \(\$ExitCode -ne 0\)/);
  assert.match(processRunner, /psql returned exit code \$ExitCode/);
  assert.doesNotMatch(processRunner, /\$LASTEXITCODE/);
  assert.doesNotMatch(processRunner, /PGPASSWORD|PGHOSTADDR|postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(processRunner, /Write-(?:Host|Output|Error).*\$Arguments/i);
  assert.match(runner, /schemaVersion = 1; runId = \$runId/);
  assert.match(runner, /NewGuid\(\)\.ToString\('N'\)/);
  assert.match(runner, /30-minute run window/);
  assert.match(runner, /'preparing', 'ready', 'claimed', 'needs_review', 'cleaned'/);
  assert.match(runner, /'Status', 'Diagnose', 'Cleanup'/);
  assert.match(runner, /'Diagnose'\s*\{\s*'order_validation_concurrency_diagnose\.native\.sql'\s*\}/);
  assert.match(runner, /if \(\$Action -notin @\('Status', 'Diagnose'\)\)/);
  assert.match(runner, /Read-only cleanup-condition diagnosis completed/);
  assert.match(ordinaryRunner, /ValidateSet\('targeted-claim', 'asset-commit', 'both'\)/);
  assert.doesNotMatch(ordinaryRunner, /concurrency-native|order_validation_concurrency/);
  assert.doesNotMatch(runner, /param\s*\([^)]*(?:DatabaseUrl|ConnectionString|SqlFile|Host|Port)\b/is);
  assert.doesNotMatch(runner, /PGPASSWORD\s*=|PGPASSWORD=/i);
  assert.doesNotMatch(runner, /(?:claim_amuhon_order_validation_job\s*\(|claim_expired_amuhon|cleanup_amuhon|storage\.objects|storage\.from)/i);
});

test('mock exit-code PowerShell test is process-only and covers zero plus nonzero codes', async () => {
  const mockTest = await read('../tests/native-process-runner.test.ps1');
  assert.match(mockTest, /Add-Type[\s\S]*OutputType ConsoleApplication/);
  assert.match(mockTest, /amuhon-native-exit-/);
  assert.match(mockTest, /public static int Main\(string\[\] args\)/);
  assert.match(mockTest, /Get-DirectMockProcessExitCode/);
  assert.match(mockTest, /System\.Diagnostics\.ProcessStartInfo/);
  assert.match(mockTest, /\.Arguments = \$CommandLineArguments/);
  assert.match(mockTest, /\$mockArguments = \[string\]\$expectedCode/);
  assert.match(mockTest, /Arguments @\(\$mockArguments\)/);
  assert.match(mockTest, /\$actualCode -ne \$directCode/);
  assert.match(mockTest, /Remove-Item -LiteralPath \$mockExecutable -Force/);
  assert.match(mockTest, /\@\(0, 1, 2, 3\)/);
  assert.doesNotMatch(mockTest, /cmd\.exe|ComSpec|psql\.exe|amuhon_validation_native|127\.0\.0\.1|supabase/i);
  assert.doesNotMatch(mockTest, /(?:NativeRoot|PGPASSWORD|DATABASE_URL|service_role)/i);
});

test('concurrency runner loads and validates shared path-safety helpers before using them', async () => {
  const runner = await read('../scripts/native-postgres/test-order-validation-concurrency-native.ps1');
  const moduleSource = await read('../scripts/native-postgres/native-postgres-path-safety.psm1');
  const importIndex = runner.indexOf('Import-Module -Name $pathSafetyModule -Force -ErrorAction Stop');
  const firstHelperUse = runner.indexOf('$rootPath = Assert-NativeLocalDrivePath $NativeRoot');
  assert.ok(importIndex > 0 && importIndex < firstHelperUse, 'module import precedes the first shared-helper call');
  assert.match(runner, /native-postgres-path-safety\.psm1/);
  assert.match(runner, /if \(-not \(Test-Path -LiteralPath \$pathSafetyModule -PathType Leaf\)\)/);
  assert.match(runner, /Native path-safety module is missing; no preflight or SQL was run/);
  assert.match(runner, /catch \{\s*throw \[InvalidOperationException\]::new\('Native path-safety module could not be loaded; no preflight or SQL was run\.'\)\s*\}/s);
  for (const helper of [
    'Assert-NativeLocalDrivePath',
    'Test-PathIsInside',
    'Assert-NoReparsePath',
    'Get-NativeBinaryDirectory',
    'Test-CanonicalPathEqual',
  ]) {
    assert.match(moduleSource, new RegExp(`function ${helper}\\b`), `${helper} is defined in the shared module`);
    assert.match(moduleSource, new RegExp(`Export-ModuleMember[\\s\\S]*\\b${helper}\\b`), `${helper} is exported`);
  }
});

test('concurrency SQL uses fixed identity guards, bounded sessions, and exact synthetic scope', async () => {
  const files = {
    setup: '../supabase/tests/native/order_validation_concurrency_setup.native.sql',
    lock: '../supabase/tests/native/order_validation_concurrency_lock.native.sql',
    probe: '../supabase/tests/native/order_validation_concurrency_probe.native.sql',
    claim: '../supabase/tests/native/order_validation_concurrency_claim.native.sql',
    status: '../supabase/tests/native/order_validation_concurrency_status.native.sql',
    diagnose: '../supabase/tests/native/order_validation_concurrency_diagnose.native.sql',
    cleanup: '../supabase/tests/native/order_validation_concurrency_cleanup.native.sql',
  };
  const sql = {};
  for (const [key, path] of Object.entries(files)) {
    sql[key] = await read(path);
    assert.doesNotMatch(sql[key], /[^\S\r\n]+$/m, `${key} has no trailing whitespace`);
    getSqlStatements(sql[key]);
    assert.match(sql[key], /current_database\(\).*amuhon_validation_native/s, key);
    assert.match(sql[key], /inet_server_port\(\).*55432/s, key);
    assert.match(sql[key], /host\(inet_server_addr\(\)\).*127\.0\.0\.1/s, key);
    assert.match(sql[key], /host\(inet_client_addr\(\)\).*127\.0\.0\.1/s, key);
    assert.match(sql[key], /pg_control_system\(\)/, key);
    assert.match(sql[key], /current_setting\('app\.amuhon_native_concurrency_run'.*__RUN_ID__/s, key);
    assert.doesNotMatch(sql[key], /claim_amuhon_order_validation_job\s*\(/i, key);
    assert.doesNotMatch(sql[key], /claim_expired_amuhon|claim_amuhon_order_temp_upload_attempt_cleanup|finish_amuhon_order_temp_upload_cleanup/i, key);
    assert.doesNotMatch(sql[key], /storage\.(?:objects|buckets)|storage\.from/i, key);
  }
  const setupStatements = getSqlStatements(sql.setup);
  const lockStatements = getSqlStatements(sql.lock);
  const probeStatements = getSqlStatements(sql.probe);
  const claimStatements = getSqlStatements(sql.claim);
  const diagnoseStatements = getSqlStatements(sql.diagnose);
  const cleanupStatements = getSqlStatements(sql.cleanup);
  assert.match(setupStatements[0], /^do\b/i, 'setup identifies the database before beginning its write transaction');
  assert.match(setupStatements[1], /^begin$/i);
  assert.match(setupStatements.at(-1), /^commit$/i);
  assert.match(setupStatements[3], /pg_advisory_xact_lock\(20261031, 405\)/i);
  assert.match(setupStatements.slice(1, -1).join(';'), /insert into public\.amuhon_orders/i);
  assert.match(lockStatements[0], /^begin$/i);
  assert.match(lockStatements.at(-1), /^rollback$/i);
  assert.match(lockStatements.at(-2), /^select pg_catalog\.pg_sleep\(120\)$/i);
  assert.ok(lockStatements.indexOf('begin') < lockStatements.indexOf('select pg_catalog.pg_sleep(120)'));
  assert.match(lockStatements[3], /^do\b/i, 'holder validates identity and acquires the row lock before waiting');
  assert.match(sql.lock, /for update/);
  assert.match(sql.lock, /pg_sleep\(120\)/i);
  assert.match(probeStatements[0], /^begin isolation level read committed$/i);
  assert.match(probeStatements.at(-1), /^commit$/i, 'successful probe commits only its synthetic evidence marker');
  assert.match(sql.probe, /claim_amuhon_order_validation_job_for_attempt\s*\(/i);
  assert.match(sql.probe, /\[NO FALLBACK\]/);
  assert.match(sql.probe, /application_name = '__HOLDER_APP_NAME__'/);
  assert.match(sql.probe, /xact_start is not null/);
  assert.match(sql.probe, /select pid into holder_pid/i);
  assert.match(sql.probe, /pg_catalog\.pg_locks[\s\S]*rowsharelock/i);
  assert.doesNotMatch(sql.probe, /query\s+ilike\s+'%pg_sleep/i, 'holder detection does not depend on truncated query text');
  assert.match(sql.probe, /for update nowait/i, 'probe proves the requested row is actually locked');
  assert.match(sql.probe, /\[ROW LOCK NOT HELD\]/);
  assert.match(sql.probe, /native_lock_probes/);
  assert.match(sql.probe, /update public\.amuhon_orders[\s\S]*__DECOY_ORDER_ID__[\s\S]*__RUN_ID__/i);
  assert.match(sql.probe, /get diagnostics updated_rows = row_count/i);
  assert.match(claimStatements[0], /^begin isolation level read committed$/i);
  assert.match(claimStatements.at(-1), /^commit$/i);
  assert.match(sql.claim, /\[DOUBLE CLAIM\]/);
  assert.match(sql.claim, /\[PROBE EVIDENCE\]/);
  assert.match(sql.claim, /jsonb_array_length\(o\.book_snapshot->'native_lock_probes'\) = 3/);
  assert.match(sql.claim, /@> '\["order", "attempt", "job"\]'::jsonb/);
  assert.match(cleanupStatements[0], /^do\b/i, 'cleanup identifies the database before beginning its write transaction');
  assert.match(cleanupStatements[1], /^begin$/i);
  assert.match(cleanupStatements.at(-1), /^commit$/i);
  assert.match(cleanupStatements[3], /pg_advisory_xact_lock\(20261031, 405\)/i);
  const cleanupDoBlocks = [...sql.cleanup.matchAll(/\bdo\s+(\$[A-Za-z_][A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/gi)]
    .map((match) => ({ tag: match[1], body: match[2] }));
  assert.deepEqual(cleanupDoBlocks.map(({ tag }) => tag), [
    '$native_concurrency_cleanup$',
    '$native_concurrency_cleanup_fixture$',
    '$native_cleanup_verify$',
  ], 'cleanup DO-block boundaries use the expected unique dollar tags');
  const [cleanupIdentityGuard, cleanupFixtureGuard] = cleanupDoBlocks.map(({ body }) => body);
  const cleanupCountVariables = [
    'order_count',
    'valid_order_count',
    'attempt_count',
    'valid_attempt_count',
    'job_count',
    'valid_job_count',
  ];
  assert.doesNotMatch(cleanupIdentityGuard, /\bdeclare\b/i);
  assert.doesNotMatch(cleanupIdentityGuard, /\b(?:order_count|valid_order_count|attempt_count|valid_attempt_count|job_count|valid_job_count)\s+integer\s*;/i,
    'identity guard has no fixture-local declarations');
  assert.match(cleanupFixtureGuard, /^\s*declare\b/i,
    'fixture checks declare their own PL/pgSQL variables in the block that uses them');
  for (const variable of cleanupCountVariables) {
    assert.match(cleanupFixtureGuard, new RegExp(`\\b${variable}\\s+integer\\s*;`, 'i'), `${variable} is declared in fixture block`);
  }
  assert.match(cleanupFixtureGuard, /into\s+order_count\s*,\s*valid_order_count/i);
  assert.match(cleanupFixtureGuard, /into\s+attempt_count\s*,\s*valid_attempt_count/i);
  assert.match(cleanupFixtureGuard, /into\s+job_count\s*,\s*valid_job_count/i);
  assert.match(cleanupFixtureGuard, /if\s+order_count\s+not\s+in/i, 'fixture validation uses the block-local counts');
  assert.match(sql.setup, /identity guard failed/);
  assert.match(sql.cleanup, /identity guard failed/);
  assert.match(cleanupStatements.join(';'), /delete from public\.amuhon_order_validation_jobs[\s\S]*delete from public\.amuhon_order_temp_upload_attempts[\s\S]*delete from public\.amuhon_orders/i);
  const deletes = cleanupStatements.filter((statement) => /^delete\s+from\b/i.test(statement));
  assert.equal(deletes.length, 3, 'cleanup contains only the three exact fixture-table deletes');
  const rawCleanup = sql.cleanup;
  assert.match(rawCleanup, /delete from public\.amuhon_order_validation_jobs where attempt_id = any\(array\['__TARGET_ATTEMPT_ID__', '__DECOY_ATTEMPT_ID__'\]/i);
  assert.match(rawCleanup, /delete from public\.amuhon_order_temp_upload_attempts where[\s\S]*__TARGET_ATTEMPT_ID__[\s\S]*__TARGET_ORDER_ID__[\s\S]*__DECOY_ATTEMPT_ID__[\s\S]*__DECOY_ORDER_ID__/i);
  assert.match(rawCleanup, /delete from public\.amuhon_orders where[\s\S]*customer->>'native_test_run'\s*=\s*'__RUN_ID__'/i);
  assert.match(sql.cleanup, /native_test_run/);
  assert.match(sql.cleanup, /\[\s*TARGET_ORDER_ID__|__TARGET_ORDER_ID__/);
  assert.doesNotMatch(sql.setup + sql.lock + sql.probe + sql.claim + sql.status, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+(?:table|schema|function|database)\b/i);
  assert.doesNotMatch(sql.cleanup, /\b(?:drop|truncate)\b/i);
  assert.match(sql.lock, /for update/);
  assert.match(sql.status, /fixture_not_present/);
  assert.match(sql.status, /fixture_in_progress/);
  assert.match(sql.status, /cleanup_completed/);
  assert.match(sql.status, /fixture_inconsistent_stop/);
  assert.match(sql.status, /__MANIFEST_STATUS__/);
  assert.match(diagnoseStatements[0], /^do\b/i, 'diagnose identifies the connection before opening its read-only transaction');
  assert.match(diagnoseStatements[1], /^begin read only$/i);
  assert.match(diagnoseStatements.at(-1), /^rollback$/i);
  assert.match(sql.diagnose, /other_client_sessions_absent/);
  assert.match(sql.diagnose, /native_connection_identity_guard/);
  assert.match(sql.diagnose, /order_rows_match_cleanup_predicate/);
  assert.match(sql.diagnose, /attempt_rows_match_cleanup_predicate/);
  assert.match(sql.diagnose, /job_rows_match_cleanup_predicate/);
  assert.match(sql.diagnose, /all_cleanup_preconditions_pass/);
  assert.match(sql.diagnose, /pg_catalog\.pg_stat_activity/);
  assert.match(sql.diagnose, /pg_catalog\.pg_locks/);
  assert.match(sql.diagnose, /l\.classid::text = '20261031' and l\.objid::text = '405' and l\.objsubid = 2/);
  assert.match(sql.diagnose, /body_pdf_storage_path is null and o\.cover_png_storage_path is null/i);
  assert.match(sql.diagnose, /a\.state = 'issued'[\s\S]*body\.pdf[\s\S]*cover\.png/i);
  assert.match(sql.diagnose, /j\.state = 'queued'[\s\S]*j\.attempt_count between 1 and 5[\s\S]*j\.lease_expires_at is not null/i);
  assert.doesNotMatch(sql.diagnose, /pg_advisory_(?:xact_)?lock\s*\(|\binsert\s+into\b|\bupdate\b|\bdelete\s+from\b|\btruncate\b|\bdrop\b|cleanup_.*rpc|storage\.(?:objects|buckets)|storage\.from/i);
  const diagnoseTopLevel = getSqlStatements(sql.diagnose);
  assert.equal(diagnoseTopLevel.filter((statement) => /^\s*(?:insert|update|delete|truncate|drop)\b/i.test(statement)).length, 0);
  const statusRunner = await read('../scripts/native-postgres/test-order-validation-concurrency-native.ps1');
  assert.match(statusRunner, /'__MANIFEST_STATUS__'\s*=/);
  assert.match(statusRunner, /Read fixture_status and row counts above/);
  assert.match(statusRunner, /if \(\$Action -notin @\('Status', 'Diagnose'\)\)[\s\S]*Write-Manifest/);
  assert.match(statusRunner, /'Diagnose'\s*\{\s*'order_validation_concurrency_diagnose\.native\.sql'\s*\}/);
  assert.doesNotMatch(statusRunner, /completedLocks\)\.Count\s*-ne\s*3/, 'editable manifest cannot authorize skipping SQL evidence');
});
