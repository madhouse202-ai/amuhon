[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$NativeRoot
)

$ErrorActionPreference = 'Stop'
$pathSafetyModule = Join-Path $PSScriptRoot 'native-postgres-path-safety.psm1'
if (-not (Test-Path -LiteralPath $pathSafetyModule -PathType Leaf)) {
  throw [InvalidOperationException]::new('Native path-safety module is missing.')
}
Import-Module -Name $pathSafetyModule -Force -ErrorAction Stop

$expectedPort = 55432
$expectedDatabase = 'amuhon_validation_native'
$expectedRole = 'postgres'
$expectedClusterName = 'amuhon-native-order-validation-v1'
$expectedApplicationName = 'amuhon-native-order-validation'
$expectedSystemMarker = 'amuhon-native-pg-isolated-v1'
$versions = @(
  '20261103000100_order_stripe_checkout',
  '20261103000200_order_admin_fulfillment'
)
$baseline = @(
  [pscustomobject]@{ Version = '20261017000100_order_drafts'; Hash = '1942af227de4e7f823ef14e031c2501865980c79d4ea0679df2ea36c8f857f69' },
  [pscustomobject]@{ Version = '20261020000100_order_asset_uploads'; Hash = '6ebe44db71d00407116ccde9bd35a6ade0611751bcaf046d6ec56c02ad3aa538' },
  [pscustomobject]@{ Version = '20261020000200_order_asset_size_limit'; Hash = 'ca41c0aedcc83816588010bb7fc1d80767ac2543972c288a3194d8b03f6fdf33' },
  [pscustomobject]@{ Version = '20261020000300_order_temp_uploads'; Hash = '5d2a079326b1749a1bc40ec3f7de616d6575d0c4ac50c449d01d63d27448044e' },
  [pscustomobject]@{ Version = '20261021000100_order_validation_jobs'; Hash = '8f10bbe8cce4cb2d81a29ea6f02c66aadb38e8ad23be43c3b7d0c50938fcb995' },
  [pscustomobject]@{ Version = '20261022000100_order_validation_asset_commit'; Hash = '28e0b23873f02030da1162d7006478305b3843b8ca6122e44e7494dd2e58de0d' },
  [pscustomobject]@{ Version = '20261025000100_order_validation_targeted_claim'; Hash = '194b9d0b333556b8b2b31f3427866c0f826509267d4684b245eca2454fb789de' }
)
$approvedHashes = @{
  '20261103000100_order_stripe_checkout' = 'c450a88a4a7728b13719e8cead3971384a30f45160e72369d589492c7c6fcd39'
  '20261103000200_order_admin_fulfillment' = '8e7f87ccf26b156af960c809c358a3c99dc1414f690d8ce3bd63b6a9116a6b25'
}
$environmentNames = @(
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE',
  'PGSERVICE', 'PGSERVICEFILE', 'PGCONNECT_TIMEOUT', 'PGSSLMODE', 'PGTARGETSESSIONATTRS',
  'PGOPTIONS', 'PGAPPNAME', 'PGCLIENTENCODING', 'PGGSSENCMODE', 'PGCHANNELBINDING'
)
$oldEnvironment = @{}
$environmentCaptured = $false
$runDirectory = $null

function Stop-NativeCheckoutMigration([string]$Message) {
  throw [InvalidOperationException]::new("Native checkout migration refused: $Message")
}

function ConvertTo-SqlLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Restore-NativeEnvironment {
  if (-not $script:environmentCaptured) { return }
  $restoreFailures = [Collections.Generic.List[string]]::new()
  foreach ($name in $environmentNames) {
    try {
      [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process')
    } catch {
      $restoreFailures.Add($name)
    }
  }
  $script:environmentCaptured = $false
  if ($restoreFailures.Count -gt 0) {
    throw [InvalidOperationException]::new('Could not restore process environment variables: ' + ($restoreFailures -join ', '))
  }
}

try {
  $rootPath = $null
  $rootMatchesFixedPath = $false
  try {
    $rootPath = Assert-NativeLocalDrivePath $NativeRoot
    $rootMatchesFixedPath = Test-CanonicalPathEqual $rootPath 'C:\amuhon-native-pg'
    if ($rootMatchesFixedPath) { Assert-NoReparsePath $rootPath }
  } catch {
    $rootMatchesFixedPath = $false
  }
  if (-not $rootMatchesFixedPath) {
    Stop-NativeCheckoutMigration 'NativeRoot must resolve exactly to C:\amuhon-native-pg and contain no reparse points.'
  }

  $preflight = Join-Path $PSScriptRoot 'test-order-validation-native.ps1'
  if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) {
    Stop-NativeCheckoutMigration 'the shared full cluster preflight script is missing.'
  }
  try {
    & $preflight -NativeRoot $rootPath -PreflightOnly
  } catch {
    Stop-NativeCheckoutMigration 'the shared native cluster preflight failed.'
  }

  $repoRoot = Get-CanonicalPath (Join-Path $PSScriptRoot '..\..')
  if (Test-PathIsInside $rootPath $repoRoot) {
    Stop-NativeCheckoutMigration 'native PostgreSQL files must remain outside the repository.'
  }
  $identityPath = Join-Path $rootPath 'identity\native-cluster.json'
  $dataDirectory = Join-Path $rootPath 'cluster'
  $binaryDirectory = Get-NativeBinaryDirectory $rootPath
  $logDirectory = Join-Path $rootPath 'logs'
  foreach ($path in @($identityPath, $dataDirectory, $binaryDirectory, $logDirectory)) {
    if (-not (Test-Path -LiteralPath $path)) { Stop-NativeCheckoutMigration 'a required native cluster path is missing.' }
    Assert-NoReparsePath $path
  }
  $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
  $currentOwner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ($identity.schemaVersion -ne 1 -or
      $identity.purpose -ne 'amuhon-native-order-validation-only' -or
      $identity.database -ne $expectedDatabase -or
      [int]$identity.port -ne $expectedPort -or
      $identity.clusterName -ne $expectedClusterName -or
      -not (Test-CanonicalPathEqual ([string]$identity.dataDirectory) $dataDirectory) -or
      [string]$identity.systemIdentifier -notmatch '^\d+$' -or
      -not [string]::Equals([string]$identity.osOwner, $currentOwner, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-NativeCheckoutMigration 'the identity record does not match the fixed native cluster.'
  }

  $psql = Join-Path $binaryDirectory 'psql.exe'
  if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) { Stop-NativeCheckoutMigration 'the fixed native psql executable is missing.' }
  Assert-NoReparsePath $psql

  foreach ($entry in $baseline) {
    $baselinePath = Join-Path $repoRoot ("supabase\migrations\{0}.sql" -f $entry.Version)
    if (-not (Test-Path -LiteralPath $baselinePath -PathType Leaf)) {
      Stop-NativeCheckoutMigration "approved baseline migration is missing: $($entry.Version)"
    }
    $baselineBytes = [IO.File]::ReadAllBytes($baselinePath)
    $baselineSha = [Security.Cryptography.SHA256]::Create()
    try { $baselineHash = ([BitConverter]::ToString($baselineSha.ComputeHash($baselineBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $baselineSha.Dispose() }
    if ($baselineHash -cne $entry.Hash) {
      Stop-NativeCheckoutMigration "approved baseline SHA-256 mismatch: $($entry.Version)"
    }
  }

  $sources = @()
  foreach ($version in $versions) {
    $path = Join-Path $repoRoot ("supabase\migrations\{0}.sql" -f $version)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Stop-NativeCheckoutMigration "fixed migration is missing: $version" }
    $bytes = [IO.File]::ReadAllBytes($path)
    $sqlText = [Text.Encoding]::UTF8.GetString($bytes)
    if ($sqlText -match '(?im)^\s*\\' -or
        $sqlText -match '(?im)^\s*(?:begin|commit|rollback)\s*;' -or
        $sqlText -match '(?im)\b(?:create\s+(?:unique\s+)?index\s+concurrently|vacuum|cluster)\b') {
      Stop-NativeCheckoutMigration "migration is not compatible with the guarded single transaction: $version"
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if (-not $approvedHashes.ContainsKey($version) -or $hash -cne $approvedHashes[$version]) {
      Stop-NativeCheckoutMigration "approved SHA-256 mismatch for fixed migration: $version"
    }
    $sources += [pscustomobject]@{ Version = $version; Bytes = $bytes; Hash = $hash }
  }

  $runDirectory = Join-Path $logDirectory ('checkout-migration-run-' + [guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($runDirectory)
  Assert-NoReparsePath $runDirectory
  if (-not (Test-PathIsInside $runDirectory $logDirectory) -or (Test-PathIsInside $runDirectory $repoRoot)) {
    Stop-NativeCheckoutMigration 'the generated migration snapshot directory is unsafe.'
  }
  $includePaths = @()
  for ($i = 0; $i -lt $sources.Count; $i++) {
    $snapshot = Join-Path $runDirectory ('{0:D2}.sql' -f ($i + 1))
    [IO.File]::WriteAllBytes($snapshot, $sources[$i].Bytes)
    $includePaths += $snapshot.Replace('\', '/')
  }

  $sqlData = ConvertTo-SqlLiteral ([IO.Path]::GetFullPath($dataDirectory).Replace('\', '/'))
  $sqlSystem = ConvertTo-SqlLiteral ([string]$identity.systemIdentifier)
  $lines = [Collections.Generic.List[string]]::new()
  $lines.Add('\set ON_ERROR_STOP on')
  $baselineTuples = @()
  foreach ($entry in $baseline) {
    $baselineTuples += '(' + (ConvertTo-SqlLiteral $entry.Version) + ', ' + (ConvertTo-SqlLiteral $entry.Hash) + ')'
  }
  $baselineValues = $baselineTuples -join ', '
  $lines.Add(@"
do `$native_checkout_preapply_guard`$
begin
 if current_database() is distinct from 'amuhon_validation_native' or
    current_user is distinct from 'postgres' or
    inet_server_addr() is distinct from inet '127.0.0.1' or
    inet_client_addr() is distinct from inet '127.0.0.1' or
    inet_server_port() is distinct from 55432 or
    current_setting('cluster_name') is distinct from 'amuhon-native-order-validation-v1' or
    current_setting('application_name') is distinct from 'amuhon-native-order-validation' or
    current_setting('app.amuhon_native_test_environment', true) is distinct from 'amuhon-native-pg-isolated-v1' or
    current_setting('app.amuhon_native_system_identifier', true) is distinct from
      (select system_identifier::text from pg_catalog.pg_control_system()) or
    (select system_identifier::text from pg_catalog.pg_control_system()) is distinct from $sqlSystem or
    replace(current_setting('data_directory'), chr(92), '/') is distinct from $sqlData or
    current_setting('listen_addresses') is distinct from '127.0.0.1' or
    current_setting('port') is distinct from '55432' then
   raise exception 'STOP: native checkout migration connection identity mismatch';
 end if;
 if exists (select 1 from pg_catalog.pg_database where datname not in ('postgres', 'template0', 'template1', 'amuhon_validation_native')) or
    not exists (select 1 from pg_catalog.pg_database where datname = 'amuhon_validation_native' and not datistemplate) then
   raise exception 'STOP: cluster database allowlist mismatch';
 end if;
 if exists (select 1 from pg_catalog.pg_roles where rolname !~ '^pg_' and rolname not in ('postgres', 'anon', 'authenticated', 'service_role')) or
    (select count(*) from pg_catalog.pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 or
    exists (select 1 from pg_catalog.pg_roles where rolname in ('anon', 'authenticated', 'service_role') and
      (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolbypassrls)) then
   raise exception 'STOP: cluster roles differ from the isolated bootstrap baseline';
 end if;
 if exists (select 1 from pg_catalog.pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'public', 'storage', 'native_test')) then
   raise exception 'STOP: unexpected user schema exists';
 end if;
 if pg_catalog.to_regclass('native_test.migration_history') is null or
    not exists (select 1 from native_test.migration_history where migration_version is not null) then
   raise exception 'STOP: the seven-migration native baseline is missing';
 end if;
 if pg_catalog.to_regclass('native_test.checkout_migration_history') is not null then
   raise exception 'STOP: the checkout migration ledger already exists; prior or partial application requires review';
 end if;
 if (select count(*) from native_test.migration_history) <> 7 or
    exists ((values $baselineValues) except select migration_version, sha256 from native_test.migration_history) or
    exists (select migration_version, sha256 from native_test.migration_history except (values $baselineValues)) then
   raise exception 'STOP: migration ledger is not exactly the approved seven-file baseline';
 end if;
 if exists (select 1 from public.amuhon_orders) then
   raise exception 'STOP: native order table must be empty before the checkout migrations';
 end if;
 if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.amuhon_orders'::regclass and not attisdropped and
      attname = any (array['stripe_checkout_attempt_id','stripe_checkout_started_at','stripe_checkout_session_id','stripe_checkout_url','stripe_checkout_expires_at','printer_submission_status','printer_submitted_at','printer_submitted_by']::name[])) or
    pg_catalog.to_regclass('public.amuhon_stripe_webhook_events') is not null or
    exists (select 1 from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname in (
      'get_amuhon_order_checkout_status','begin_amuhon_order_checkout','record_amuhon_order_checkout_session',
      'apply_amuhon_stripe_checkout_paid','get_amuhon_admin_order_list','get_amuhon_admin_order_detail',
      'get_amuhon_admin_order_asset','mark_amuhon_order_printer_submitted')) or
    exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.amuhon_orders'::regclass and conname in (
      'amuhon_orders_checkout_attempt_pair','amuhon_orders_checkout_session_expiry_pair',
      'amuhon_orders_checkout_url_requires_session','amuhon_orders_stripe_payment_uidx',
      'amuhon_orders_printer_submission_status','amuhon_orders_printer_submission_audit_pair')) or
    pg_catalog.to_regclass('public.amuhon_orders_stripe_checkout_session_uidx') is not null or
    pg_catalog.to_regclass('public.amuhon_orders_stripe_payment_uidx') is not null then
   raise exception 'STOP: checkout/admin schema objects already exist; partial or prior application requires review';
 end if;
end;
`$native_checkout_preapply_guard`$;
"@)

  $ledgerVersions = $versions | ForEach-Object { ConvertTo-SqlLiteral $_ }
  $ledgerVersionList = $ledgerVersions -join ', '
  $lines.Add(('create table native_test.checkout_migration_history (migration_version text primary key check (migration_version in ({0})), sha256 text not null check (sha256 ~ ''^[a-f0-9]{{64}}$''), applied_at timestamptz not null default clock_timestamp());' -f $ledgerVersionList))

  for ($i = 0; $i -lt $sources.Count; $i++) {
    $versionSql = ConvertTo-SqlLiteral $sources[$i].Version
    $hashSql = ConvertTo-SqlLiteral $sources[$i].Hash
    $lines.Add("\i " + $includePaths[$i])
    $lines.Add("insert into native_test.checkout_migration_history (migration_version, sha256) values ($versionSql, $hashSql);")
  }
  $appendTuples = @()
  foreach ($source in $sources) {
    $appendTuples += '(' + (ConvertTo-SqlLiteral $source.Version) + ', ' + (ConvertTo-SqlLiteral $source.Hash) + ')'
  }
  $appendValues = $appendTuples -join ', '
  $lines.Add("do `$native_checkout_final_guard`$ begin if (select count(*) from native_test.migration_history) <> 7 or exists ((values $baselineValues) except select migration_version, sha256 from native_test.migration_history) or exists (select migration_version, sha256 from native_test.migration_history except (values $baselineValues)) or (select count(*) from native_test.checkout_migration_history) <> 2 or exists ((values $appendValues) except select migration_version, sha256 from native_test.checkout_migration_history) or exists (select migration_version, sha256 from native_test.checkout_migration_history except (values $appendValues)) then raise exception 'STOP: final native migration ledgers do not match the approved seven-plus-two files'; end if; end; `$native_checkout_final_guard`$;")

  $wrapperPath = Join-Path $runDirectory 'apply-native-checkout-migrations.psql'
  [IO.File]::WriteAllLines($wrapperPath, $lines, [Text.UTF8Encoding]::new($false))

  foreach ($name in $environmentNames) { $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  $environmentCaptured = $true
  foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  [Environment]::SetEnvironmentVariable('PGCONNECT_TIMEOUT', '5', 'Process')
  [Environment]::SetEnvironmentVariable('PGPASSFILE', 'NUL', 'Process')
  [Environment]::SetEnvironmentVariable('PGAPPNAME', $expectedApplicationName, 'Process')
  [Environment]::SetEnvironmentVariable('PGOPTIONS',
    "-c app.amuhon_native_test_environment=$expectedSystemMarker -c app.amuhon_native_system_identifier=$($identity.systemIdentifier) -c statement_timeout=120000 -c lock_timeout=5000", 'Process')

  $psqlArguments = @('-X', '-v', 'ON_ERROR_STOP=1', '-1', '-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-d', 'amuhon_validation_native', '-W', '-f', $wrapperPath)
  & $psql @psqlArguments
  if ($LASTEXITCODE -ne 0) {
    Stop-NativeCheckoutMigration 'psql failed; do not assume success or rerun. SQL errors roll back the -1 transaction; if the client result is uncertain, review the ledgers and schema read-only first.'
  }
  Write-Host 'The two approved checkout/admin migrations completed in one transaction and were recorded in the native-only ledger.'
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  try {
    Restore-NativeEnvironment
  } finally {
    if ($runDirectory -and (Test-Path -LiteralPath $runDirectory -PathType Container)) {
      Remove-Item -LiteralPath $runDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
