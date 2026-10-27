[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$NativeRoot,

  [switch]$PreflightOnly,

  [ValidateSet('targeted-claim', 'asset-commit', 'both')]
  [string]$Test = 'both'
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
$expectedEnvironmentMarker = 'amuhon-native-pg-isolated-v1'
$supportedMajorVersions = @(15, 16, 17, 18)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$environmentNames = @(
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE',
  'PGSERVICE', 'PGSERVICEFILE', 'PGCONNECT_TIMEOUT', 'PGSSLMODE', 'PGTARGETSESSIONATTRS',
  'PGOPTIONS', 'PGAPPNAME', 'PGCLIENTENCODING', 'PGGSSENCMODE', 'PGCHANNELBINDING'
)
$oldEnvironment = @{}
$environmentCaptured = $false

function Stop-NativeTest([string]$Message) {
  throw [InvalidOperationException]::new("Native PostgreSQL test refused: $Message")
}

function Invoke-Captured([string]$File, [string[]]$Arguments, [string]$FailureMessage) {
  $captured = @(& $File @Arguments 2>$null)
  if ($LASTEXITCODE -ne 0) { Stop-NativeTest $FailureMessage }
  return ,$captured
}

function Set-NativeClientEnvironment([string]$SystemIdentifier) {
  foreach ($name in $environmentNames) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  # Arm restoration before changing any process-wide environment value.
  $script:environmentCaptured = $true
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  [Environment]::SetEnvironmentVariable('PGCONNECT_TIMEOUT', '5', 'Process')
  # Prevent libpq from consulting the user's default %APPDATA%\postgresql\pgpass.conf.
  [Environment]::SetEnvironmentVariable('PGPASSFILE', 'NUL', 'Process')
  [Environment]::SetEnvironmentVariable('PGAPPNAME', $expectedApplicationName, 'Process')
  [Environment]::SetEnvironmentVariable(
    'PGOPTIONS',
    "-c app.amuhon_native_test_environment=$expectedEnvironmentMarker -c app.amuhon_native_system_identifier=$SystemIdentifier -c statement_timeout=120000 -c lock_timeout=5000",
    'Process'
  )
}

function Restore-NativeClientEnvironment {
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
  $rootPath = Assert-NativeLocalDrivePath $NativeRoot
  $driveRoot = [IO.Path]::GetPathRoot($rootPath)
  if ($rootPath.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-NativeTest 'NativeRoot cannot be the drive root.'
  }
  if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
    Stop-NativeTest 'NativeRoot must be an existing dedicated directory; this script does not create directories.'
  }
  if (Test-PathIsInside $rootPath $repoRoot) {
    Stop-NativeTest 'PostgreSQL binaries and data must remain outside the application repository.'
  }
  if ($rootPath -match '[\s|;"'']') {
    Stop-NativeTest 'NativeRoot must not contain whitespace or characters unsafe for the fixed process checks.'
  }
  Assert-NoReparsePath $rootPath

  $binaryDirectory = Get-NativeBinaryDirectory $rootPath
  $dataDirectory = Join-Path $rootPath 'cluster'
  $logDirectory = Join-Path $rootPath 'logs'
  $identityFile = Join-Path $rootPath 'identity\native-cluster.json'
  foreach ($directory in @($binaryDirectory, $dataDirectory, $logDirectory, (Split-Path -Parent $identityFile))) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
      Stop-NativeTest 'the expected bin, cluster, logs, or identity directory is missing.'
    }
    Assert-NoReparsePath $directory
    if (Test-PathIsInside $directory $repoRoot) {
      Stop-NativeTest 'a required PostgreSQL directory resolves inside the application repository.'
    }
  }
  if (-not (Test-Path -LiteralPath $identityFile -PathType Leaf)) {
    Stop-NativeTest 'the manually provisioned cluster identity file is missing.'
  }
  Assert-NoReparsePath $identityFile

  $postgresExe = Join-Path $binaryDirectory 'postgres.exe'
  $pgCtlExe = Join-Path $binaryDirectory 'pg_ctl.exe'
  $psqlExe = Join-Path $binaryDirectory 'psql.exe'
  $pgControlDataExe = Join-Path $binaryDirectory 'pg_controldata.exe'
  foreach ($executable in @($postgresExe, $pgCtlExe, $psqlExe, $pgControlDataExe)) {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
      Stop-NativeTest 'one or more required PostgreSQL executables are missing from the dedicated bin directory.'
    }
    Assert-NoReparsePath $executable
  }

  $identity = Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json
  if ($identity.schemaVersion -ne 1 -or
      $identity.purpose -ne 'amuhon-native-order-validation-only' -or
      $identity.database -ne $expectedDatabase -or
      [int]$identity.port -ne $expectedPort -or
      $identity.clusterName -ne $expectedClusterName -or
      [string]::IsNullOrWhiteSpace([string]$identity.systemIdentifier)) {
    Stop-NativeTest 'the identity file is not for this dedicated native validation cluster.'
  }
  if (-not ([string]$identity.systemIdentifier -match '^\d+$')) {
    Stop-NativeTest 'the expected PostgreSQL system identifier is malformed.'
  }
  if (-not (Test-CanonicalPathEqual ([string]$identity.dataDirectory) $dataDirectory)) {
    Stop-NativeTest 'the identity file data directory does not match the fixed cluster directory.'
  }
  $currentOwner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ([string]$identity.osOwner -ne $currentOwner) {
    Stop-NativeTest 'the current Windows user does not match the cluster owner recorded at provisioning.'
  }

  $versionText = (@(& $postgresExe --version 2>$null) -join ' ').Trim()
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch 'PostgreSQL\)\s+(\d+)\.') {
    Stop-NativeTest 'the PostgreSQL executable version could not be identified.'
  }
  $binaryMajor = [int]$Matches[1]
  $pgVersionFile = Join-Path $dataDirectory 'PG_VERSION'
  if (-not (Test-Path -LiteralPath $pgVersionFile -PathType Leaf)) {
    Stop-NativeTest 'the PostgreSQL cluster is not initialized.'
  }
  $clusterMajorText = (Get-Content -LiteralPath $pgVersionFile -Raw).Trim()
  if ($clusterMajorText -notmatch '^\d+$' -or [int]$clusterMajorText -ne $binaryMajor -or
      $binaryMajor -notin $supportedMajorVersions) {
    Stop-NativeTest 'the PostgreSQL binary and cluster major versions differ or are outside the reviewed supported range.'
  }

  $hbaFile = Join-Path $dataDirectory 'pg_hba.conf'
  if (-not (Test-Path -LiteralPath $hbaFile -PathType Leaf)) {
    Stop-NativeTest 'pg_hba.conf is missing from the dedicated data directory.'
  }
  Assert-NoReparsePath $hbaFile
  $hbaRules = @(
    Get-Content -LiteralPath $hbaFile |
      ForEach-Object { ($_ -replace '#.*$', '').Trim() } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      ForEach-Object { ($_ -split '\s+') -join ' ' }
  )
  if ($hbaRules.Count -ne 1 -or $hbaRules[0] -cne 'host all postgres 127.0.0.1/32 scram-sha-256') {
    Stop-NativeTest 'pg_hba.conf must contain only the reviewed IPv4-loopback SCRAM rule for postgres.'
  }

  $controlLines = Invoke-Captured $pgControlDataExe @('-D', $dataDirectory) 'pg_controldata could not inspect the expected cluster.'
  $controlText = $controlLines -join "`n"
  $systemIdMatch = [regex]::Match($controlText, '(?m)^Database system identifier:\s*(\d+)\s*$')
  if (-not $systemIdMatch.Success -or $systemIdMatch.Groups[1].Value -ne [string]$identity.systemIdentifier) {
    Stop-NativeTest 'pg_controldata system identifier does not match the reviewed cluster identity.'
  }

  $pidFile = Join-Path $dataDirectory 'postmaster.pid'
  if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    Stop-NativeTest 'the expected PostgreSQL cluster is not running; start it manually after review.'
  }
  $pidLines = @(Get-Content -LiteralPath $pidFile)
  if ($pidLines.Count -lt 6 -or $pidLines[0] -notmatch '^\d+$') {
    Stop-NativeTest 'postmaster.pid is incomplete or malformed.'
  }
  $serverPid = [int]$pidLines[0]
  if (-not (Test-CanonicalPathEqual $pidLines[1] $dataDirectory) -or
      [int]$pidLines[3] -ne $expectedPort -or $pidLines[5].Trim() -cne '127.0.0.1') {
    Stop-NativeTest 'postmaster.pid does not identify the fixed data directory, port, and loopback address.'
  }

  $statusLines = Invoke-Captured $pgCtlExe @('status', '-D', $dataDirectory) 'pg_ctl did not confirm the expected cluster is running.'
  $statusText = $statusLines -join ' '
  if ($statusText -notmatch "(?i)PID:\s*$serverPid\b") {
    Stop-NativeTest 'pg_ctl status reports a PID different from postmaster.pid.'
  }

  try {
    $processMatches = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction Stop)
    if ($processMatches.Count -ne 1) { Stop-NativeTest 'the PostgreSQL server process could not be uniquely identified.' }
    $serverProcess = $processMatches[0]
    $processCommandLine = [string]$serverProcess.CommandLine
    if (-not (Test-CanonicalPathEqual ([string]$serverProcess.ExecutablePath) $postgresExe) -or
        [string]::IsNullOrWhiteSpace($processCommandLine) -or
        $processCommandLine.IndexOf($dataDirectory, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      Stop-NativeTest 'the running PID executable or command line does not match this cluster.'
    }
    $ownerResult = Invoke-CimMethod -InputObject $serverProcess -MethodName GetOwner -ErrorAction Stop
    if ($ownerResult.ReturnValue -ne 0 -or
        ("{0}\{1}" -f $ownerResult.Domain, $ownerResult.User) -ine $currentOwner) {
      Stop-NativeTest 'the PostgreSQL server process owner is unknown or differs from the current Windows user.'
    }
    $serviceMatches = @(Get-CimInstance -ClassName Win32_Service -Filter "ProcessId = $serverPid" -ErrorAction Stop)
    if ($serviceMatches.Count -ne 0) {
      Stop-NativeTest 'the PostgreSQL process is registered as a Windows service; service-managed clusters are not accepted.'
    }
  } catch {
    if ($_.Exception.Message -like 'Native PostgreSQL test refused:*') { throw }
    Stop-NativeTest 'Windows process identity or service ownership could not be verified.'
  }

  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $expectedPort -ErrorAction Stop)
  if ($listeners.Count -ne 1 -or
      $listeners[0].LocalAddress -cne '127.0.0.1' -or
      [int]$listeners[0].OwningProcess -ne $serverPid) {
    Stop-NativeTest 'the fixed port is not owned only by this PostgreSQL PID on IPv4 loopback.'
  }

  $selectedFiles = switch ($Test) {
    'targeted-claim' { @((Join-Path $PSScriptRoot '..\..\supabase\tests\native\order_validation_targeted_claim.native.sql')) }
    'asset-commit' { @((Join-Path $PSScriptRoot '..\..\supabase\tests\native\order_validation_asset_commit.native.sql')) }
    default {
      @(
        (Join-Path $PSScriptRoot '..\..\supabase\tests\native\order_validation_targeted_claim.native.sql'),
        (Join-Path $PSScriptRoot '..\..\supabase\tests\native\order_validation_asset_commit.native.sql')
      )
    }
  }
  foreach ($sqlFile in $selectedFiles) {
    if (-not (Test-Path -LiteralPath $sqlFile -PathType Leaf)) {
      Stop-NativeTest 'a selected native-only SQL test file is missing.'
    }
  }

  Set-NativeClientEnvironment ([string]$identity.systemIdentifier)
  $probeSql = @"
select current_database(), current_user, coalesce(inet_server_addr()::text, ''),
       coalesce(inet_client_addr()::text, ''), inet_server_port(),
       current_setting('data_directory'),
       (select system_identifier::text from pg_catalog.pg_control_system()),
       current_setting('cluster_name'), current_setting('application_name'),
       current_setting('app.amuhon_native_test_environment', true),
       current_setting('app.amuhon_native_system_identifier', true),
       current_setting('listen_addresses'), current_setting('port'),
       current_setting('config_file'), current_setting('hba_file');
"@
  $probeArgs = @('-X', '-A', '-t', '-F', "`t", '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', "$expectedPort", '-U', $expectedRole, '-d', $expectedDatabase, '-W', '-c', $probeSql)
  $probeLines = @(& $psqlExe @probeArgs)
  if ($LASTEXITCODE -ne 0 -or $probeLines.Count -ne 1) {
    Stop-NativeTest 'the PostgreSQL identity probe failed or returned an unexpected result shape.'
  }
  $probeFields = $probeLines[0].Split("`t")
  if ($probeFields.Count -ne 15 -or
      $probeFields[0] -cne $expectedDatabase -or
      $probeFields[1] -cne $expectedRole -or
      $probeFields[2] -cne '127.0.0.1' -or
      $probeFields[3] -cne '127.0.0.1' -or
      [int]$probeFields[4] -ne $expectedPort -or
      -not (Test-CanonicalPathEqual $probeFields[5] $dataDirectory) -or
      $probeFields[6] -cne [string]$identity.systemIdentifier -or
      $probeFields[7] -cne $expectedClusterName -or
      $probeFields[8] -cne $expectedApplicationName -or
      $probeFields[9] -cne $expectedEnvironmentMarker -or
      $probeFields[10] -cne [string]$identity.systemIdentifier -or
      $probeFields[11] -cne '127.0.0.1' -or
      [int]$probeFields[12] -ne $expectedPort -or
      -not (Test-CanonicalPathEqual $probeFields[13] (Join-Path $dataDirectory 'postgresql.conf')) -or
      -not (Test-CanonicalPathEqual $probeFields[14] $hbaFile)) {
    Stop-NativeTest 'the database-reported identity, network, configuration, or cluster ID does not match the expected native cluster.'
  }

  if ($PreflightOnly) {
    Write-Host 'Native PostgreSQL preflight completed; no test SQL was executed.'
  } else {
    foreach ($sqlFile in $selectedFiles) {
      Write-Host "Running native PostgreSQL SQL test: $(Split-Path -Leaf $sqlFile)"
      $testArgs = @('-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', "$expectedPort", '-U', $expectedRole, '-d', $expectedDatabase, '-W', '-f', $sqlFile)
      & $psqlExe @testArgs
      if ($LASTEXITCODE -ne 0) {
        Stop-NativeTest 'psql reported a SQL test failure. Its connection is closed so PostgreSQL rolls back the open transaction.'
      }
    }
    Write-Host 'Selected native PostgreSQL SQL tests completed successfully.'
  }
} catch {
  Write-Error $_.Exception.Message
  if ($PreflightOnly) { throw }
  exit 1
} finally {
  Restore-NativeClientEnvironment
}
