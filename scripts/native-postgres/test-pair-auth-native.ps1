[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$nativeRoot = 'C:\amuhon-native-pg'
$expectedDatabase = 'amuhon_validation_native'
$expectedRole = 'postgres'
$expectedHost = '127.0.0.1'
$expectedPort = 55432
$expectedClusterName = 'amuhon-native-order-validation-v1'
$expectedEnvironmentMarker = 'amuhon-native-pg-isolated-v1'
$expectedApplicationName = 'amuhon-native-pair-auth-smoke'
$expectedPurpose = 'amuhon-native-order-validation-only'
$securePassword = $null

function Stop-NativePairAuth([string]$Message) {
  throw [InvalidOperationException]::new("Native Pair auth probe refused: $Message")
}

function ConvertTo-NativeAuthSqlLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

try {
  $pathSafetyModule = Join-Path $PSScriptRoot 'native-postgres-path-safety.psm1'
  $pairProcessModule = Join-Path $PSScriptRoot 'native-pair-process-runner.psm1'
  $preflight = Join-Path $PSScriptRoot 'test-order-validation-native.ps1'
  foreach ($requiredFile in @($pathSafetyModule, $pairProcessModule, $preflight)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
      Stop-NativePairAuth 'a required reviewed native helper is missing.'
    }
  }
  try {
    Import-Module -Name $pathSafetyModule -Force -ErrorAction Stop
    Import-Module -Name $pairProcessModule -Force -ErrorAction Stop
  } catch {
    Stop-NativePairAuth 'a required reviewed native helper could not be loaded.'
  }

  $rootPath = Assert-NativeLocalDrivePath $nativeRoot
  if (-not (Test-CanonicalPathEqual $rootPath $nativeRoot) -or
      (Test-PathIsInside $rootPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')))) -or
      -not (Test-Path -LiteralPath $rootPath -PathType Container)) {
    Stop-NativePairAuth 'the fixed NativeRoot is missing, redirected, or inside the repository.'
  }
  Assert-NoReparsePath $rootPath

  # The shared preflight checks the live process, PID, executable, owner,
  # cluster identity, exact pg_hba.conf rules, loopback listener, and DB identity.
  try {
    & $preflight -NativeRoot $rootPath -PreflightOnly
    if (-not $?) { Stop-NativePairAuth 'the shared native preflight failed.' }
  } catch {
    Stop-NativePairAuth 'the shared native preflight failed; no auth probe was started.'
  }

  $identityPath = Join-Path $rootPath 'identity\native-cluster.json'
  Assert-NoReparsePath $identityPath
  try { $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json } catch {
    Stop-NativePairAuth 'the reviewed native cluster identity file is unreadable.'
  }
  $dataDirectory = Join-Path $rootPath 'cluster'
  if ($identity.schemaVersion -ne 1 -or $identity.purpose -cne $expectedPurpose -or
      $identity.database -cne $expectedDatabase -or [int]$identity.port -ne $expectedPort -or
      $identity.clusterName -cne $expectedClusterName -or
      -not (Test-CanonicalPathEqual ([string]$identity.dataDirectory) $dataDirectory) -or
      [string]$identity.systemIdentifier -notmatch '^\d+$' -or
      -not [string]::Equals([string]$identity.osOwner,
        [Security.Principal.WindowsIdentity]::GetCurrent().Name,
        [StringComparison]::OrdinalIgnoreCase)) {
    Stop-NativePairAuth 'the fixed native identity record does not match this dedicated local cluster.'
  }

  $binaryDirectory = Get-NativeBinaryDirectory $rootPath
  $psqlPath = Join-Path $binaryDirectory 'psql.exe'
  if (-not (Test-Path -LiteralPath $psqlPath -PathType Leaf)) {
    Stop-NativePairAuth 'the fixed local psql executable is missing.'
  }
  Assert-NoReparsePath $psqlPath

  $expectedDataDirectorySql = ([string]$identity.dataDirectory).Replace('\', '/')
  $expectedConfigFileSql = (Join-Path $dataDirectory 'postgresql.conf').Replace('\', '/')
  $expectedHbaFileSql = (Join-Path $dataDirectory 'pg_hba.conf').Replace('\', '/')
  $systemIdentifier = [string]$identity.systemIdentifier
  $probeSql = @"
select case when
  current_database() is not distinct from 'amuhon_validation_native' and
  current_user is not distinct from 'postgres' and
  host(inet_server_addr()) is not distinct from '127.0.0.1' and
  host(inet_client_addr()) is not distinct from '127.0.0.1' and
  inet_server_port() is not distinct from 55432 and
  replace(current_setting('data_directory'), chr(92), '/') is not distinct from $(ConvertTo-NativeAuthSqlLiteral $expectedDataDirectorySql) and
  (select system_identifier::text from pg_catalog.pg_control_system()) is not distinct from '$systemIdentifier' and
  current_setting('cluster_name') is not distinct from 'amuhon-native-order-validation-v1' and
  current_setting('application_name') is not distinct from 'amuhon-native-pair-auth-smoke' and
  current_setting('app.amuhon_native_test_environment', true) is not distinct from 'amuhon-native-pg-isolated-v1' and
  current_setting('app.amuhon_native_system_identifier', true) is not distinct from '$systemIdentifier' and
  current_setting('listen_addresses') is not distinct from '127.0.0.1' and
  current_setting('port') is not distinct from '55432' and
  replace(current_setting('config_file'), chr(92), '/') is not distinct from $(ConvertTo-NativeAuthSqlLiteral $expectedConfigFileSql) and
  replace(current_setting('hba_file'), chr(92), '/') is not distinct from $(ConvertTo-NativeAuthSqlLiteral $expectedHbaFileSql)
then 'PASS' else 'FAIL' end;
"@
  $environment = @{
    PGCONNECT_TIMEOUT = '5'
    PGPASSFILE = 'NUL'
    PGAPPNAME = $expectedApplicationName
    PGOPTIONS = "-c app.amuhon_native_test_environment=$expectedEnvironmentMarker -c app.amuhon_native_system_identifier=$systemIdentifier -c statement_timeout=10000"
  }
  $arguments = @(
    '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
    '-h', $expectedHost, '-p', [string]$expectedPort,
    '-U', $expectedRole, '-d', $expectedDatabase, '-W',
    '-c', $probeSql
  )

  $securePassword = Read-Host -Prompt 'Enter the dedicated local PostgreSQL password (SecureString; memory only)' -AsSecureString
  $result = Invoke-NativePairAuthProbe -PsqlPath $psqlPath -Arguments $arguments `
    -EnvironmentOverrides $environment -Password $securePassword -TimeoutSeconds 15
  if ($result.ExitCode -ne 0 -or $result.Output.Trim() -cne 'PASS') {
    Stop-NativePairAuth 'psql authentication or the fixed read-only database identity check failed; no alternate authentication was attempted.'
  }
  Write-Host 'Native Pair psql authentication and read-only cluster identity check passed.'
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($null -ne $securePassword) { $securePassword.Dispose() }
}
