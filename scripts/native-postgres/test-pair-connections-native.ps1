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
$expectedPurpose = 'amuhon-native-order-validation-only'
$securePassword = $null

function Stop-NativePairConnections([string]$Message) {
  throw [InvalidOperationException]::new("Native Pair connection check refused: $Message")
}

function ConvertTo-NativeConnectionSqlLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

try {
  $pathSafetyModule = Join-Path $PSScriptRoot 'native-postgres-path-safety.psm1'
  $processModule = Join-Path $PSScriptRoot 'native-pair-process-runner.psm1'
  $preflight = Join-Path $PSScriptRoot 'test-order-validation-native.ps1'
  foreach ($requiredFile in @($pathSafetyModule, $processModule, $preflight)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
      Stop-NativePairConnections 'a required reviewed native helper is missing.'
    }
  }
  try {
    Import-Module -Name $pathSafetyModule -Force -ErrorAction Stop
    Import-Module -Name $processModule -Force -ErrorAction Stop
  } catch {
    Stop-NativePairConnections 'a required reviewed native helper could not be loaded.'
  }

  $rootPath = Assert-NativeLocalDrivePath $nativeRoot
  $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  if (-not (Test-CanonicalPathEqual $rootPath $nativeRoot) -or
      (Test-PathIsInside $rootPath $repoRoot) -or
      -not (Test-Path -LiteralPath $rootPath -PathType Container)) {
    Stop-NativePairConnections 'the fixed NativeRoot is missing, redirected, or inside the repository.'
  }
  Assert-NoReparsePath $rootPath

  # This fixed shared preflight checks the already-running local cluster and database identity.
  try {
    & $preflight -NativeRoot $rootPath -PreflightOnly
    if (-not $?) { Stop-NativePairConnections 'the shared native preflight failed.' }
  } catch {
    Stop-NativePairConnections 'the shared native preflight failed; no paired psql process was started.'
  }

  $identityPath = Join-Path $rootPath 'identity\native-cluster.json'
  Assert-NoReparsePath $identityPath
  try { $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json } catch {
    Stop-NativePairConnections 'the reviewed native cluster identity file is unreadable.'
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
    Stop-NativePairConnections 'the fixed native identity record does not match this dedicated local cluster.'
  }

  $binaryDirectory = Get-NativeBinaryDirectory $rootPath
  $psqlPath = Join-Path $binaryDirectory 'psql.exe'
  if (-not (Test-Path -LiteralPath $psqlPath -PathType Leaf)) {
    Stop-NativePairConnections 'the fixed local psql executable is missing.'
  }
  Assert-NoReparsePath $psqlPath

  $runMarker = [Guid]::NewGuid().ToString('N')
  $systemIdentifier = [string]$identity.systemIdentifier
  $dataDirectorySql = ([string]$identity.dataDirectory).Replace('\', '/')
  $configFileSql = (Join-Path $dataDirectory 'postgresql.conf').Replace('\', '/')
  $hbaFileSql = (Join-Path $dataDirectory 'pg_hba.conf').Replace('\', '/')
  $firstApplicationName = 'amuhon-pair-connect-' + $runMarker.Substring(0, 16) + '-a'
  $secondApplicationName = 'amuhon-pair-connect-' + $runMarker.Substring(0, 16) + '-b'

  $sqlTemplate = @'
select case when
  current_database() is not distinct from '__DATABASE__' and
  current_user is not distinct from '__ROLE__' and
  host(inet_server_addr()) is not distinct from '__HOST__' and
  host(inet_client_addr()) is not distinct from '__HOST__' and
  inet_server_port() is not distinct from __PORT__ and
  lower(replace(current_setting('data_directory'), chr(92), '/')) is not distinct from lower('__DATA_DIRECTORY__') and
  (select system_identifier::text from pg_catalog.pg_control_system()) is not distinct from '__SYSTEM_IDENTIFIER__' and
  current_setting('cluster_name') is not distinct from '__CLUSTER_NAME__' and
  current_setting('application_name') is not distinct from '__APPLICATION_NAME__' and
  current_setting('app.amuhon_native_test_environment', true) is not distinct from '__ENVIRONMENT_MARKER__' and
  current_setting('app.amuhon_native_system_identifier', true) is not distinct from '__SYSTEM_IDENTIFIER__' and
  current_setting('app.amuhon_native_pair_connection_run', true) is not distinct from '__RUN_MARKER__' and
  current_setting('listen_addresses') is not distinct from '127.0.0.1' and
  current_setting('port') is not distinct from '55432' and
  lower(replace(current_setting('config_file'), chr(92), '/')) is not distinct from lower('__CONFIG_FILE__') and
  lower(replace(current_setting('hba_file'), chr(92), '/')) is not distinct from lower('__HBA_FILE__')
then 'PASS' else 'FAIL' end;
'@
  $commonReplacements = @{
    '__DATABASE__' = $expectedDatabase
    '__ROLE__' = $expectedRole
    '__HOST__' = $expectedHost
    '__PORT__' = [string]$expectedPort
    '__DATA_DIRECTORY__' = ConvertTo-NativeConnectionSqlLiteral $dataDirectorySql
    '__SYSTEM_IDENTIFIER__' = $systemIdentifier
    '__CLUSTER_NAME__' = $expectedClusterName
    '__ENVIRONMENT_MARKER__' = $expectedEnvironmentMarker
    '__RUN_MARKER__' = $runMarker
    '__CONFIG_FILE__' = ConvertTo-NativeConnectionSqlLiteral $configFileSql
    '__HBA_FILE__' = ConvertTo-NativeConnectionSqlLiteral $hbaFileSql
  }
  function New-FixedIdentityQuery([string]$ApplicationName, [hashtable]$Replacements) {
    $query = $sqlTemplate
    foreach ($key in $Replacements.Keys) { $query = $query.Replace($key, [string]$Replacements[$key]) }
    $query = $query.Replace('__APPLICATION_NAME__', (ConvertTo-NativeConnectionSqlLiteral $ApplicationName))
    if ($query -match '__[A-Z0-9_]+__') { Stop-NativePairConnections 'the fixed identity SELECT has an unresolved placeholder.' }
    return $query
  }

  $firstQuery = New-FixedIdentityQuery $firstApplicationName $commonReplacements
  $secondQuery = New-FixedIdentityQuery $secondApplicationName $commonReplacements
  $fixedPsqlArguments = @('-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
    '-h', $expectedHost, '-p', [string]$expectedPort, '-U', $expectedRole, '-d', $expectedDatabase, '-W')
  $baseEnvironment = @{
    PGCONNECT_TIMEOUT = '5'
    PGPASSFILE = 'NUL'
  }
  $firstEnvironment = @{} + $baseEnvironment
  $firstEnvironment['PGAPPNAME'] = $firstApplicationName
  $firstEnvironment['PGOPTIONS'] = "-c app.amuhon_native_test_environment=$expectedEnvironmentMarker -c app.amuhon_native_system_identifier=$systemIdentifier -c app.amuhon_native_pair_connection_run=$runMarker -c statement_timeout=10000"
  $secondEnvironment = @{} + $baseEnvironment
  $secondEnvironment['PGAPPNAME'] = $secondApplicationName
  $secondEnvironment['PGOPTIONS'] = $firstEnvironment['PGOPTIONS']

  $securePassword = Read-Host -Prompt 'Enter the dedicated local PostgreSQL password (SecureString; memory only)' -AsSecureString
  $result = Invoke-NativePairReadOnlyIdentityChecks `
    -PsqlPath $psqlPath `
    -FirstArguments @($fixedPsqlArguments + @('-c', $firstQuery)) `
    -FirstEnvironment $firstEnvironment `
    -SecondArguments @($fixedPsqlArguments + @('-c', $secondQuery)) `
    -SecondEnvironment $secondEnvironment `
    -Password $securePassword `
    -TimeoutSeconds 30

  foreach ($connection in @($result.First, $result.Second)) {
    if ($null -eq $connection) { continue }
    Write-Host ('Connection {0}: exit={1}; result={2}; password_sent_at_utc={3}; output_drained={4}; process_closed={5}; stdout_chars={6}; stderr_chars={7}; stdout_truncated={8}; stderr_truncated={9}; termination_attempted={10}; termination_succeeded={11}' -f `
      $connection.Name, $connection.ExitCode, $connection.IdentityResult, $connection.PasswordSentAtUtc,
      $connection.OutputDrained, $connection.ProcessClosed, $connection.StdOutCharacters,
      $connection.StdErrCharacters, $connection.StdOutTruncated, $connection.StdErrTruncated,
      $connection.TerminationAttempted, $connection.TerminationSucceeded)
  }
  if ($result.TimedOut) { Stop-NativePairConnections 'the fixed two-client authentication check timed out; no retry or alternate authentication was attempted.' }
  if (-not $result.ProcessesClosed) { Stop-NativePairConnections 'both local client processes could not be confirmed closed.' }
  if ($result.StartupOrInputFailure) { Stop-NativePairConnections 'a local client could not start or its in-memory input write failed.' }
  if ($result.ChildFailure) { Stop-NativePairConnections 'a local client returned a nonzero exit code; its peer was stopped and no fallback was attempted.' }
  if (-not $result.Passed) { Stop-NativePairConnections 'both local psql sessions did not return exit code 0 and exact PASS with fully drained output.' }
  Write-Host 'Both fixed local psql sessions authenticated and passed their read-only identity SELECT.'
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($null -ne $securePassword) { $securePassword.Dispose() }
}
