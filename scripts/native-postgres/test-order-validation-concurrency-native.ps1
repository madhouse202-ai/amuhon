[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$NativeRoot,

  [Parameter(Mandatory = $true)]
  [ValidateSet('Prepare', 'Hold', 'Probe', 'ClaimAfterUnlock', 'Status', 'Diagnose', 'Cleanup')]
  [string]$Action,

  [ValidateSet('order', 'attempt', 'job')]
  [string]$LockKind,

  [string]$RunId,

  [switch]$ConfirmSyntheticCleanup
)

$ErrorActionPreference = 'Stop'
$processRunnerModule = Join-Path $PSScriptRoot 'native-process-runner.psm1'
if (-not (Test-Path -LiteralPath $processRunnerModule -PathType Leaf)) {
  throw [InvalidOperationException]::new('Native process-runner module is missing; no preflight or SQL was run.')
}
try {
  Import-Module -Name $processRunnerModule -Force -ErrorAction Stop
} catch {
  throw [InvalidOperationException]::new('Native process-runner module could not be loaded; no preflight or SQL was run.')
}
$pathSafetyModule = Join-Path $PSScriptRoot 'native-postgres-path-safety.psm1'
if (-not (Test-Path -LiteralPath $pathSafetyModule -PathType Leaf)) {
  throw [InvalidOperationException]::new('Native path-safety module is missing; no preflight or SQL was run.')
}
try {
  Import-Module -Name $pathSafetyModule -Force -ErrorAction Stop
} catch {
  throw [InvalidOperationException]::new('Native path-safety module could not be loaded; no preflight or SQL was run.')
}
$expectedPort = 55432
$expectedDatabase = 'amuhon_validation_native'
$expectedRole = 'postgres'
$expectedClusterName = 'amuhon-native-order-validation-v1'
$expectedEnvironmentMarker = 'amuhon-native-pg-isolated-v1'
$environmentNames = @(
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE',
  'PGSERVICE', 'PGSERVICEFILE', 'PGCONNECT_TIMEOUT', 'PGSSLMODE', 'PGTARGETSESSIONATTRS',
  'PGOPTIONS', 'PGAPPNAME', 'PGCLIENTENCODING', 'PGGSSENCMODE', 'PGCHANNELBINDING'
)
$oldEnvironment = @{}
$environmentCaptured = $false

function Stop-NativeConcurrency([string]$Message) {
  throw [InvalidOperationException]::new("Native PostgreSQL concurrency test refused: $Message")
}

function Restore-NativeConcurrencyEnvironment {
  if (-not $script:environmentCaptured) { return }
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process')
  }
  $script:environmentCaptured = $false
}

function Set-NativeConcurrencyEnvironment([string]$SystemIdentifier, [string]$Run, [string]$ApplicationName) {
  foreach ($name in $environmentNames) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $script:environmentCaptured = $true
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  [Environment]::SetEnvironmentVariable('PGCONNECT_TIMEOUT', '5', 'Process')
  [Environment]::SetEnvironmentVariable('PGPASSFILE', 'NUL', 'Process')
  [Environment]::SetEnvironmentVariable('PGAPPNAME', $ApplicationName, 'Process')
  [Environment]::SetEnvironmentVariable(
    'PGOPTIONS',
    "-c app.amuhon_native_test_environment=$expectedEnvironmentMarker -c app.amuhon_native_system_identifier=$SystemIdentifier -c app.amuhon_native_concurrency_run=$Run -c statement_timeout=160000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=150000",
    'Process'
  )
}

function Invoke-GuardedPreflight([string]$Root) {
  $preflight = Join-Path $PSScriptRoot 'test-order-validation-native.ps1'
  if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) { Stop-NativeConcurrency 'the reviewed shared preflight is missing.' }
  & $preflight -NativeRoot $Root -PreflightOnly
  if (-not $?) { Stop-NativeConcurrency 'the shared live-cluster preflight failed.' }
}

function Invoke-GuardedPsql([string]$PsqlExe, [string[]]$Arguments, [int]$TimeoutSeconds = 180) {
  try {
    $exitCode = Invoke-NativeProcessWithTimeout -FilePath $PsqlExe -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds
  } catch [TimeoutException] {
    Stop-NativeConcurrency 'psql exceeded the fixed operation timeout; its connection was terminated.'
  }
  Assert-NativePsqlSuccess -ExitCode $exitCode
}

function Write-Manifest([string]$Path, [object]$Value) {
  $json = ConvertTo-Json -InputObject $Value -Depth 5
  [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

function Read-Manifest([string]$Path, [string]$ExpectedRunId, [string]$ExpectedSystemIdentifier, [string]$ExpectedDataDirectory) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Stop-NativeConcurrency 'the run manifest does not exist.' }
  Assert-NoReparsePath $Path
  try { $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { Stop-NativeConcurrency 'the run manifest is unreadable.' }
  if ($value.schemaVersion -ne 1 -or $value.runId -cne $ExpectedRunId -or
      $value.systemIdentifier -cne $ExpectedSystemIdentifier -or
      $value.database -cne $expectedDatabase -or [int]$value.port -ne $expectedPort -or
      $value.status -notin @('preparing', 'ready', 'claimed', 'needs_review', 'cleaned')) {
    Stop-NativeConcurrency 'the run manifest identity or status is invalid.'
  }
  if ([string]$value.systemIdentifier -notmatch '^\d+$' -or
      -not (Test-CanonicalPathEqual ([string]$value.dataDirectory) $ExpectedDataDirectory)) {
    Stop-NativeConcurrency 'the manifest cluster path or system identifier is invalid.'
  }
  foreach ($idName in @('targetOrderId', 'decoyOrderId', 'targetAttemptId', 'decoyAttemptId',
                        'targetIdempotencyId', 'decoyIdempotencyId', 'uploadLeaseId', 'decoyUploadLeaseId')) {
    $parsedId = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$value.$idName, 'D', [ref]$parsedId)) {
      Stop-NativeConcurrency 'the manifest contains a malformed synthetic identifier.'
    }
  }
  $allowedCompletedLocks = @('order', 'attempt', 'job')
  if (@($value.completedLocks | Where-Object { $_ -notin $allowedCompletedLocks }).Count -gt 0 -or
      @($value.completedLocks | Select-Object -Unique).Count -ne @($value.completedLocks).Count) {
    Stop-NativeConcurrency 'the manifest lock-probe history is invalid.'
  }
  return $value
}

function Invoke-Template([string]$TemplateName, [object]$Manifest, [string]$RootPath, [string]$PsqlExe, [string]$ActionName, [string]$TemplateLockKind = '') {
  $templatePath = Join-Path $PSScriptRoot ("..\..\supabase\tests\native\$TemplateName")
  if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) { Stop-NativeConcurrency 'a fixed concurrency SQL template is missing.' }
  $runDirectory = Join-Path $RootPath ("logs\order-validation-concurrency\runs\" + $Manifest.runId)
  if (-not (Test-Path -LiteralPath $runDirectory -PathType Container)) { Stop-NativeConcurrency 'the recorded run directory is missing.' }
  Assert-NoReparsePath $runDirectory
  $appName = if ($ActionName -eq 'Hold') {
    "amuhon-c-$($Manifest.runId.Substring(0, 12))-$TemplateLockKind"
  } elseif ($ActionName -eq 'Probe') {
    "amuhon-c-$($Manifest.runId.Substring(0, 12))-probe-$TemplateLockKind"
  } else {
    "amuhon-c-$($Manifest.runId.Substring(0, 12))-$($ActionName.ToLowerInvariant())"
  }
  $dataDirectorySql = ([string]$Manifest.dataDirectory).Replace('\', '/').Replace("'", "''")
  $replacements = @{
    '__DATA_DIRECTORY__' = $dataDirectorySql
    '__SYSTEM_IDENTIFIER__' = [string]$Manifest.systemIdentifier
    '__APP_NAME__' = $appName
    '__RUN_ID__' = [string]$Manifest.runId
    '__RUN_ID_SHORT__' = $Manifest.runId.Substring(0, 12)
    '__LOCK_KIND__' = $TemplateLockKind
    '__MANIFEST_STATUS__' = [string]$Manifest.status
    '__TARGET_ORDER_ID__' = [string]$Manifest.targetOrderId
    '__DECOY_ORDER_ID__' = [string]$Manifest.decoyOrderId
    '__TARGET_ATTEMPT_ID__' = [string]$Manifest.targetAttemptId
    '__DECOY_ATTEMPT_ID__' = [string]$Manifest.decoyAttemptId
    '__TARGET_IDEMPOTENCY_ID__' = [string]$Manifest.targetIdempotencyId
    '__DECOY_IDEMPOTENCY_ID__' = [string]$Manifest.decoyIdempotencyId
    '__UPLOAD_LEASE_ID__' = [string]$Manifest.uploadLeaseId
    '__DECOY_UPLOAD_LEASE_ID__' = [string]$Manifest.decoyUploadLeaseId
  }
  if ($TemplateName -eq 'order_validation_concurrency_probe.native.sql' -or
      $TemplateName -eq 'order_validation_concurrency_claim.native.sql') {
    $replacements['__HOLDER_APP_NAME__'] = "amuhon-c-$($Manifest.runId.Substring(0, 12))-$TemplateLockKind"
  }
  $text = [IO.File]::ReadAllText($templatePath)
  foreach ($key in $replacements.Keys) { $text = $text.Replace($key, [string]$replacements[$key]) }
  if ($text -match '__[A-Z0-9_]+__') { Stop-NativeConcurrency 'a fixed SQL template contains an unresolved placeholder.' }
  $snapshot = Join-Path $runDirectory ($ActionName.ToLowerInvariant() + $(if ($TemplateLockKind) { "-$TemplateLockKind" } else { '' }) + '.sql')
  [IO.File]::WriteAllText($snapshot, $text, (New-Object Text.UTF8Encoding($false)))
  Assert-NoReparsePath $snapshot
  Set-NativeConcurrencyEnvironment ([string]$Manifest.systemIdentifier) ([string]$Manifest.runId) $appName
  try {
    $arguments = @('-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-d', 'amuhon_validation_native', '-W', '-f', $snapshot)
    Invoke-GuardedPsql $PsqlExe $arguments
  } finally {
    Restore-NativeConcurrencyEnvironment
  }
  return $appName
}

try {
  $rootPath = Assert-NativeLocalDrivePath $NativeRoot
  if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { Stop-NativeConcurrency 'NativeRoot must be an existing dedicated local directory.' }
  $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
  if (Test-PathIsInside $rootPath $repoRoot) { Stop-NativeConcurrency 'native PostgreSQL files must remain outside the repository.' }
  Assert-NoReparsePath $rootPath
  $binaryDirectory = Get-NativeBinaryDirectory $rootPath
  $psqlExe = Join-Path $binaryDirectory 'psql.exe'
  if (-not (Test-Path -LiteralPath $psqlExe -PathType Leaf)) { Stop-NativeConcurrency 'the fixed psql.exe is missing.' }
  $logs = Join-Path $rootPath 'logs'
  if (-not (Test-Path -LiteralPath $logs -PathType Container)) { Stop-NativeConcurrency 'the pre-provisioned logs directory is missing.' }
  Assert-NoReparsePath $logs
  $runsRoot = Join-Path $logs 'order-validation-concurrency\runs'
  if (-not (Test-Path -LiteralPath $runsRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $runsRoot -Force | Out-Null
  }
  Assert-NoReparsePath $runsRoot

  if ($Action -eq 'Prepare') {
    if ($RunId) { Stop-NativeConcurrency 'RunId is generated by the wrapper and cannot be supplied to Prepare.' }
    Invoke-GuardedPreflight $rootPath
    foreach ($oldRunDirectory in @(Get-ChildItem -LiteralPath $runsRoot -Directory -ErrorAction Stop)) {
      $oldManifestPath = Join-Path $oldRunDirectory.FullName 'manifest.json'
      Assert-NoReparsePath $oldRunDirectory.FullName
      if (-not (Test-Path -LiteralPath $oldManifestPath -PathType Leaf)) {
        Stop-NativeConcurrency 'a prior run directory has no manifest; inspect it manually before preparing another fixture.'
      }
      try { $oldManifest = Get-Content -LiteralPath $oldManifestPath -Raw | ConvertFrom-Json } catch {
        Stop-NativeConcurrency 'a prior run manifest is unreadable; inspect it manually before preparing another fixture.'
      }
      if ($oldManifest.status -ne 'cleaned') {
        Stop-NativeConcurrency 'a prior concurrency fixture is not marked cleaned; inspect its status and clean only its exact synthetic IDs.'
      }
    }
    $identityFile = Join-Path $rootPath 'identity\native-cluster.json'
    $identity = Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json
    $runId = [guid]::NewGuid().ToString('N')
    $runDirectory = Join-Path $runsRoot $runId
    New-Item -ItemType Directory -Path $runDirectory | Out-Null
    Assert-NoReparsePath $runDirectory
    $manifest = [ordered]@{
      schemaVersion = 1; runId = $runId; status = 'preparing'; database = $expectedDatabase; port = $expectedPort
      systemIdentifier = [string]$identity.systemIdentifier; dataDirectory = [string]$identity.dataDirectory
      targetOrderId = [guid]::NewGuid().ToString(); decoyOrderId = [guid]::NewGuid().ToString()
      targetAttemptId = [guid]::NewGuid().ToString(); decoyAttemptId = [guid]::NewGuid().ToString()
      targetIdempotencyId = [guid]::NewGuid().ToString(); decoyIdempotencyId = [guid]::NewGuid().ToString()
      uploadLeaseId = [guid]::NewGuid().ToString(); decoyUploadLeaseId = [guid]::NewGuid().ToString()
      completedLocks = @(); createdAt = [DateTime]::UtcNow.ToString('o'); lastAction = 'Prepare'
    }
    $manifestPath = Join-Path $runDirectory 'manifest.json'
    Write-Manifest $manifestPath $manifest
    try {
      $null = Invoke-Template 'order_validation_concurrency_setup.native.sql' $manifest $rootPath $psqlExe 'Prepare'
      $manifest.status = 'ready'; Write-Manifest $manifestPath $manifest
    } catch {
      $manifest.status = 'needs_review'; Write-Manifest $manifestPath $manifest
      throw
    }
    Write-Host "Synthetic concurrency fixture prepared. RunId: $runId"
    Write-Host 'The fixture is committed only so a second local session can see it. Run one lock/probe pair per lock kind, then ClaimAfterUnlock and Cleanup.'
    return
  }

  if ([string]::IsNullOrWhiteSpace($RunId) -or $RunId -notmatch '^[a-fA-F0-9]{32}$') {
    Stop-NativeConcurrency 'a generated 32-character RunId is required for this action.'
  }
  if (($Action -in @('Hold', 'Probe')) -and [string]::IsNullOrWhiteSpace($LockKind)) {
    Stop-NativeConcurrency 'Hold and Probe require one fixed LockKind: order, attempt, or job.'
  }
  if (($Action -notin @('Hold', 'Probe')) -and $LockKind) { Stop-NativeConcurrency 'LockKind is accepted only for Hold and Probe.' }
  if ($Action -eq 'Cleanup' -and -not $ConfirmSyntheticCleanup) {
    Stop-NativeConcurrency 'Cleanup requires the explicit -ConfirmSyntheticCleanup switch.'
  }
  if ($Action -ne 'Cleanup' -and $ConfirmSyntheticCleanup) { Stop-NativeConcurrency 'the cleanup confirmation switch is valid only for Cleanup.' }

  Invoke-GuardedPreflight $rootPath
  $runDirectory = Join-Path $runsRoot $RunId.ToLowerInvariant()
  $manifestPath = Join-Path $runDirectory 'manifest.json'
  $identityFile = Join-Path $rootPath 'identity\native-cluster.json'
  $identity = Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json
  $manifest = Read-Manifest $manifestPath $RunId.ToLowerInvariant() ([string]$identity.systemIdentifier) ([string]$identity.dataDirectory)
  $createdAt = [DateTime]::Parse([string]$manifest.createdAt).ToUniversalTime()
  if (([DateTime]::UtcNow - $createdAt).TotalMinutes -gt 30 -and $Action -notin @('Status', 'Diagnose', 'Cleanup')) {
    Stop-NativeConcurrency 'the fixed 30-minute run window expired; inspect status and use guarded cleanup only.'
  }
  $template = switch ($Action) {
    'Hold' { 'order_validation_concurrency_lock.native.sql' }
    'Probe' { 'order_validation_concurrency_probe.native.sql' }
    'ClaimAfterUnlock' { 'order_validation_concurrency_claim.native.sql' }
    'Status' { 'order_validation_concurrency_status.native.sql' }
    'Diagnose' { 'order_validation_concurrency_diagnose.native.sql' }
    'Cleanup' { 'order_validation_concurrency_cleanup.native.sql' }
  }
  if ($Action -eq 'Hold' -and $manifest.status -ne 'ready') { Stop-NativeConcurrency 'fixture is not in a state that permits lock testing.' }
  if ($Action -eq 'Probe' -and $manifest.status -ne 'ready') { Stop-NativeConcurrency 'fixture is not in a state that permits probe testing.' }
  if ($Action -eq 'Probe' -and @($manifest.completedLocks) -contains $LockKind) {
    Stop-NativeConcurrency 'this lock kind has already been recorded as passed.'
  }
  if ($Action -eq 'ClaimAfterUnlock' -and $manifest.status -ne 'ready') { Stop-NativeConcurrency 'ClaimAfterUnlock requires a ready fixture and released holder session.' }
  # The manifest is editable local JSON and is not proof that probes ran.
  # ClaimAfterUnlock SQL independently requires committed per-run evidence
  # written by each successful Probe to the exact synthetic decoy order.
  if ($Action -eq 'Cleanup' -and $manifest.status -notin @('preparing', 'ready', 'claimed', 'needs_review', 'cleaned')) { Stop-NativeConcurrency 'fixture status does not permit exact cleanup.' }
  $null = Invoke-Template $template $manifest $rootPath $psqlExe $Action $LockKind
  if ($Action -eq 'Probe') {
    $completedLocks = @($manifest.completedLocks)
    $manifest.completedLocks = @($completedLocks + $LockKind)
  }
  if ($Action -eq 'ClaimAfterUnlock') { $manifest.status = 'claimed' }
  if ($Action -eq 'Cleanup') { $manifest.status = 'cleaned' }
  if ($Action -notin @('Status', 'Diagnose')) {
    $manifest.lastAction = $Action
    Write-Manifest $manifestPath $manifest
  }
  if ($Action -eq 'Status') {
    Write-Host "Status query completed for this RunId (manifest status: $($manifest.status)). Read fixture_status and row counts above; the database evidence is authoritative for present fixtures."
  }
  elseif ($Action -eq 'Diagnose') { Write-Host 'Read-only cleanup-condition diagnosis completed; it does not acquire locks, change fixtures, or guarantee Cleanup will succeed.' }
  elseif ($Action -eq 'Cleanup') { Write-Host 'Exact synthetic fixture cleanup committed; the manifest is retained as a non-secret audit record.' }
  else { Write-Host "Synthetic concurrency action completed: $Action $LockKind" }
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  Restore-NativeConcurrencyEnvironment
}
