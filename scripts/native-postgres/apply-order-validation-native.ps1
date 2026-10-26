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
$expectedSystemMarker = 'amuhon-native-pg-isolated-v1'
$versions = @(
  '20261017000100_order_drafts',
  '20261020000100_order_asset_uploads',
  '20261020000200_order_asset_size_limit',
  '20261020000300_order_temp_uploads',
  '20261021000100_order_validation_jobs',
  '20261022000100_order_validation_asset_commit',
  '20261025000100_order_validation_targeted_claim'
)
$approvedHashes = @{
  '20261017000100_order_drafts' = '1942af227de4e7f823ef14e031c2501865980c79d4ea0679df2ea36c8f857f69'
  '20261020000100_order_asset_uploads' = '6ebe44db71d00407116ccde9bd35a6ade0611751bcaf046d6ec56c02ad3aa538'
  '20261020000200_order_asset_size_limit' = 'ca41c0aedcc83816588010bb7fc1d80767ac2543972c288a3194d8b03f6fdf33'
  '20261020000300_order_temp_uploads' = '5d2a079326b1749a1bc40ec3f7de616d6575d0c4ac50c449d01d63d27448044e'
  '20261021000100_order_validation_jobs' = '8f10bbe8cce4cb2d81a29ea6f02c66aadb38e8ad23be43c3b7d0c50938fcb995'
  '20261022000100_order_validation_asset_commit' = '28e0b23873f02030da1162d7006478305b3843b8ca6122e44e7494dd2e58de0d'
  '20261025000100_order_validation_targeted_claim' = '194b9d0b333556b8b2b31f3427866c0f826509267d4684b245eca2454fb789de'
}
$environmentNames = @(
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE',
  'PGSERVICE', 'PGSERVICEFILE', 'PGCONNECT_TIMEOUT', 'PGSSLMODE', 'PGTARGETSESSIONATTRS',
  'PGOPTIONS', 'PGAPPNAME', 'PGCLIENTENCODING', 'PGGSSENCMODE', 'PGCHANNELBINDING'
)
$oldEnvironment = @{}
$environmentCaptured = $false
$runDirectory = $null

function Stop-NativeMigration([string]$Message) {
  throw [InvalidOperationException]::new("Native PostgreSQL migration refused: $Message")
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
  $preflight = Join-Path $PSScriptRoot 'test-order-validation-native.ps1'
  if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) {
    Stop-NativeMigration 'the shared full cluster preflight script is missing.'
  }

  # The shared preflight checks the canonical data path, reparse points,
  # pg_controldata, PID, pg_ctl, executable, owner, service registration,
  # pg_hba.conf and the sole loopback listener. It executes no test SQL here.
  try {
    & $preflight -NativeRoot $NativeRoot -PreflightOnly
  } catch {
    Stop-NativeMigration 'the shared native cluster preflight failed.'
  }

  $rootPath = Assert-NativeLocalDrivePath $NativeRoot
  $repoRoot = Get-CanonicalPath (Join-Path $PSScriptRoot '..\..')
  if (Test-PathIsInside $rootPath $repoRoot) {
    Stop-NativeMigration 'native PostgreSQL files must remain outside the repository.'
  }
  $identityPath = Join-Path $rootPath 'identity\native-cluster.json'
  $dataDirectory = Join-Path $rootPath 'cluster'
  $binaryDirectory = Join-Path $rootPath 'bin'
  $logDirectory = Join-Path $rootPath 'logs'
  $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
  if ($identity.schemaVersion -ne 1 -or
      $identity.purpose -ne 'amuhon-native-order-validation-only' -or
      $identity.database -ne $expectedDatabase -or
      [int]$identity.port -ne $expectedPort -or
      $identity.clusterName -ne 'amuhon-native-order-validation-v1' -or
      -not (Test-CanonicalPathEqual ([string]$identity.dataDirectory) $dataDirectory) -or
      [string]$identity.systemIdentifier -notmatch '^\d+$' -or
      [string]$identity.osOwner -cne [Security.Principal.WindowsIdentity]::GetCurrent().Name) {
    Stop-NativeMigration 'the identity record does not match the fixed native cluster.'
  }

  $sources = @()
  foreach ($version in $versions) {
    $path = Join-Path $repoRoot ("supabase\migrations\{0}.sql" -f $version)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Stop-NativeMigration "fixed migration is missing: $version" }
    $bytes = [IO.File]::ReadAllBytes($path)
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    if ($text -match '(?im)^\s*\\' -or
        $text -match '(?im)^\s*(?:begin|commit|rollback)\s*;' -or
        $text -match '(?im)\b(?:create\s+(?:unique\s+)?index\s+concurrently|vacuum|cluster)\b') {
      Stop-NativeMigration "migration contains psql meta-commands or non-transactional SQL: $version"
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if (-not $approvedHashes.ContainsKey($version) -or $hash -cne $approvedHashes[$version]) {
      Stop-NativeMigration "approved SHA-256 mismatch for fixed migration: $version"
    }
    $sources += [pscustomobject]@{ Version = $version; Bytes = $bytes; Hash = $hash }
  }

  # Store immutable byte snapshots outside the repository. The ledger hashes
  # these exact bytes, and psql includes the snapshots in the same connection.
  $runDirectory = Join-Path $logDirectory ('migration-run-' + [guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($runDirectory)
  $runItem = Get-Item -LiteralPath $runDirectory -Force -ErrorAction Stop
  Assert-NoReparsePath $runDirectory
  if (($runItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      -not (Test-PathIsInside $runDirectory $logDirectory) -or
      (Test-PathIsInside $runDirectory $repoRoot)) {
    Stop-NativeMigration 'the generated migration snapshot directory is unsafe.'
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
  $lines.Add(@"
do `$native_initial_guard`$
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
   raise exception 'STOP: migration connection identity mismatch';
 end if;
 if exists (select 1 from pg_catalog.pg_database where datname not in ('postgres', 'template0', 'template1', 'amuhon_validation_native')) or
    not exists (select 1 from pg_catalog.pg_database where datname = 'amuhon_validation_native' and not datistemplate) then
   raise exception 'STOP: cluster database allowlist mismatch';
 end if;
 if exists (select 1 from pg_catalog.pg_roles where rolname !~ '^pg_' and rolname not in ('postgres', 'anon', 'authenticated', 'service_role')) then
   raise exception 'STOP: unexpected cluster-global role exists';
 end if;
 if exists (
      select 1 from pg_catalog.pg_roles
      where rolname in ('anon', 'authenticated', 'service_role')
        and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolbypassrls)
    ) or (select count(*) from pg_catalog.pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
   raise exception 'STOP: bootstrap application-role attributes differ from the isolated baseline';
 end if;
 if exists (select 1 from pg_catalog.pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'public', 'storage', 'native_test')) then
   raise exception 'STOP: unexpected user schema exists';
 end if;
 if pg_catalog.to_regclass('native_test.migration_history') is null or
    pg_catalog.to_regclass('storage.buckets') is null or
    pg_catalog.to_regclass('storage.objects') is null then
   raise exception 'STOP: native bootstrap is missing';
 end if;
 if exists (select 1 from native_test.migration_history) or
    exists (select 1 from pg_catalog.pg_class where relnamespace = 'public'::pg_catalog.regnamespace) or
    exists (select 1 from pg_catalog.pg_proc where pronamespace = 'public'::pg_catalog.regnamespace) or
    exists (select 1 from pg_catalog.pg_type where typnamespace = 'public'::pg_catalog.regnamespace and typname not like '\_%') or
    exists (select 1 from storage.buckets) or
     exists (select 1 from storage.objects) or
     exists (
       select 1 from pg_catalog.pg_class
       where relkind in ('r', 'p', 'v', 'm', 'f', 'S')
         and ((relnamespace = 'storage'::pg_catalog.regnamespace and relname not in ('buckets', 'objects')) or
              (relnamespace = 'native_test'::pg_catalog.regnamespace and relname <> 'migration_history'))
     ) or
     not exists (
       select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'storage' and c.relname = 'objects' and c.relrowsecurity
         and pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
     ) or
    exists (select 1 from pg_catalog.pg_policy where polrelid = 'storage.objects'::regclass) then
   raise exception 'STOP: target is already migrated, partial, or not pristine';
 end if;
end;
`$native_initial_guard`$;
"@)

  for ($i = 0; $i -lt $sources.Count; $i++) {
    $versionSql = ConvertTo-SqlLiteral $sources[$i].Version
    $hashSql = ConvertTo-SqlLiteral $sources[$i].Hash
    $tag = 'native_step_' + ($i + 1)
    $lines.Add(@"
do `$$tag`$
begin
 if (select count(*) from native_test.migration_history) <> $i then
   raise exception 'STOP: migration ledger is partial or out of order';
 end if;
 if exists (select 1 from native_test.migration_history where migration_version = $versionSql) then
   raise exception 'STOP: migration version already recorded';
 end if;
 if current_database() is distinct from 'amuhon_validation_native' or
    inet_server_addr() is distinct from inet '127.0.0.1' or
    inet_client_addr() is distinct from inet '127.0.0.1' or
    inet_server_port() is distinct from 55432 or
    (select system_identifier::text from pg_catalog.pg_control_system()) is distinct from $sqlSystem or
     replace(current_setting('data_directory'), chr(92), '/') is distinct from $sqlData then
   raise exception 'STOP: connection identity changed before migration step';
 end if;
end;
`$$tag`$;
"@)
    $lines.Add('\i ' + $includePaths[$i])
    $lines.Add("insert into native_test.migration_history (migration_version, sha256) values ($versionSql, $hashSql);")
  }

  $tuples = @()
  foreach ($source in $sources) {
    $tuples += '(' + (ConvertTo-SqlLiteral $source.Version) + ', ' + (ConvertTo-SqlLiteral $source.Hash) + ')'
  }
  $expectedPairs = $tuples -join ', '
  $lines.Add("do `$native_final_guard`$ begin if (select count(*) from native_test.migration_history) <> 7 or exists ((values $expectedPairs) except select migration_version, sha256 from native_test.migration_history) or exists (select migration_version, sha256 from native_test.migration_history except (values $expectedPairs)) then raise exception 'STOP: ledger differs from fixed seven-file batch'; end if; end; `$native_final_guard`$;")

  $wrapperPath = Join-Path $runDirectory 'apply-native-migrations.psql'
  [IO.File]::WriteAllLines($wrapperPath, $lines, [Text.UTF8Encoding]::new($false))

  foreach ($name in $environmentNames) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $environmentCaptured = $true
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  [Environment]::SetEnvironmentVariable('PGCONNECT_TIMEOUT', '5', 'Process')
  [Environment]::SetEnvironmentVariable('PGPASSFILE', 'NUL', 'Process')
  [Environment]::SetEnvironmentVariable('PGAPPNAME', 'amuhon-native-order-validation', 'Process')
  [Environment]::SetEnvironmentVariable(
    'PGOPTIONS',
    "-c app.amuhon_native_test_environment=$expectedSystemMarker -c app.amuhon_native_system_identifier=$($identity.systemIdentifier) -c statement_timeout=120000 -c lock_timeout=5000",
    'Process'
  )

  $psql = Join-Path $binaryDirectory 'psql.exe'
  $psqlArguments = @('-X', '-v', 'ON_ERROR_STOP=1', '-1', '-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-d', 'amuhon_validation_native', '-W', '-f', $wrapperPath)
  & $psql @psqlArguments
  if ($LASTEXITCODE -ne 0) {
    Stop-NativeMigration 'psql failed; the atomic batch rolled back. Do not manually apply or re-run individual files.'
  }
  Write-Host 'The fixed seven-migration batch completed atomically and was recorded in the native-only migration ledger.'
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

