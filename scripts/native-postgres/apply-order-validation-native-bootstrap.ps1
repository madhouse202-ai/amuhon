[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$NativeRoot
)

$ErrorActionPreference = 'Stop'
$expectedPort = 55432
$expectedDatabase = 'amuhon_validation_native'
$expectedClusterName = 'amuhon-native-order-validation-v1'
$expectedApplicationName = 'amuhon-native-order-validation'
$expectedEnvironmentMarker = 'amuhon-native-pg-isolated-v1'
$environmentNames = @(
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE',
  'PGSERVICE', 'PGSERVICEFILE', 'PGCONNECT_TIMEOUT', 'PGSSLMODE', 'PGTARGETSESSIONATTRS',
  'PGOPTIONS', 'PGAPPNAME', 'PGCLIENTENCODING', 'PGGSSENCMODE', 'PGCHANNELBINDING'
)
$oldEnvironment = @{}
$environmentCaptured = $false
$runDirectory = $null

function Stop-NativeBootstrap([string]$Message) {
  throw [InvalidOperationException]::new("Native PostgreSQL bootstrap refused: $Message")
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
  $pathSafetyModule = Join-Path $PSScriptRoot 'native-postgres-path-safety.psm1'
  if (-not (Test-Path -LiteralPath $pathSafetyModule -PathType Leaf)) {
    Stop-NativeBootstrap 'native path-safety module is missing.'
  }
  Import-Module -Name $pathSafetyModule -Force -ErrorAction Stop

  $preflight = Join-Path $PSScriptRoot 'test-order-validation-native.ps1'
  if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) {
    Stop-NativeBootstrap 'the shared full cluster preflight script is missing.'
  }
  try {
    & $preflight -NativeRoot $NativeRoot -PreflightOnly
  } catch {
    Stop-NativeBootstrap 'the shared native cluster preflight failed.'
  }

  $rootPath = Assert-NativeLocalDrivePath $NativeRoot
  $repoRoot = Get-CanonicalPath (Join-Path $PSScriptRoot '..\..')
  if (Test-PathIsInside $rootPath $repoRoot) {
    Stop-NativeBootstrap 'native PostgreSQL files must remain outside the repository.'
  }
  $identityPath = Join-Path $rootPath 'identity\native-cluster.json'
  $dataDirectory = Join-Path $rootPath 'cluster'
  $binaryDirectory = Get-NativeBinaryDirectory $rootPath
  $logDirectory = Join-Path $rootPath 'logs'
  $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
  if ($identity.schemaVersion -ne 1 -or
      $identity.purpose -ne 'amuhon-native-order-validation-only' -or
      $identity.database -ne $expectedDatabase -or
      [int]$identity.port -ne $expectedPort -or
      $identity.clusterName -ne $expectedClusterName -or
      -not (Test-CanonicalPathEqual ([string]$identity.dataDirectory) $dataDirectory) -or
      [string]$identity.systemIdentifier -notmatch '^\d+$' -or
      -not [string]::Equals(
        [string]$identity.osOwner,
        [Security.Principal.WindowsIdentity]::GetCurrent().Name,
        [StringComparison]::OrdinalIgnoreCase
      )) {
    Stop-NativeBootstrap 'the identity record does not match the fixed native cluster.'
  }

  $bootstrapPath = Join-Path $repoRoot 'supabase\tests\native\bootstrap.sql'
  if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
    Stop-NativeBootstrap 'the native-only bootstrap SQL file is missing.'
  }
  $bootstrapBytes = [IO.File]::ReadAllBytes($bootstrapPath)
  $bootstrapText = [Text.Encoding]::UTF8.GetString($bootstrapBytes)
  $bootstrapNoncePlaceholder = '__NATIVE_BOOTSTRAP_NONCE__'
  if ([regex]::Matches($bootstrapText, [regex]::Escape($bootstrapNoncePlaceholder)).Count -ne 1) {
    Stop-NativeBootstrap 'bootstrap SQL must contain exactly one one-run nonce placeholder.'
  }
  $bootstrapMetaCommands = @(
    $bootstrapText -split '\r?\n' |
      Where-Object { $_ -match '^\s*\\' -and $_ -notmatch '^\s*\\set\s+ON_ERROR_STOP\s+on\s*$' }
  )
  if ($bootstrapMetaCommands.Count -gt 0 -or $bootstrapText -notmatch '(?im)^\s*\\set\s+ON_ERROR_STOP\s+on\s*$') {
    Stop-NativeBootstrap 'bootstrap SQL contains a missing or unsupported psql meta-command.'
  }
  if ($bootstrapText -match '(?im)^\s*(?:commit|rollback)\s*;') {
    Stop-NativeBootstrap 'bootstrap SQL contains an unexpected top-level transaction terminator.'
  }

  $runDirectory = Join-Path $logDirectory ('bootstrap-run-' + [guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($runDirectory)
  Assert-NoReparsePath $runDirectory
  if (-not (Test-PathIsInside $runDirectory $logDirectory) -or (Test-PathIsInside $runDirectory $repoRoot)) {
    Stop-NativeBootstrap 'the generated bootstrap snapshot directory is unsafe.'
  }
  $snapshotPath = Join-Path $runDirectory 'bootstrap.sql'
  $bootstrapNonce = [guid]::NewGuid().ToString('N')
  $bootstrapSnapshot = $bootstrapText.Replace($bootstrapNoncePlaceholder, $bootstrapNonce)
  if ($bootstrapSnapshot.Contains($bootstrapNoncePlaceholder)) {
    Stop-NativeBootstrap 'bootstrap nonce substitution was incomplete.'
  }
  [IO.File]::WriteAllBytes($snapshotPath, [Text.Encoding]::UTF8.GetBytes($bootstrapSnapshot))

  foreach ($name in $environmentNames) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $environmentCaptured = $true
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  [Environment]::SetEnvironmentVariable('PGCONNECT_TIMEOUT', '5', 'Process')
  [Environment]::SetEnvironmentVariable('PGPASSFILE', 'NUL', 'Process')
  [Environment]::SetEnvironmentVariable('PGAPPNAME', $expectedApplicationName, 'Process')
  [Environment]::SetEnvironmentVariable(
    'PGOPTIONS',
    "-c app.amuhon_native_test_environment=$expectedEnvironmentMarker -c app.amuhon_native_system_identifier=$($identity.systemIdentifier) -c app.amuhon_native_expected_data_directory=$(([IO.Path]::GetFullPath($dataDirectory)).Replace('\', '/')) -c app.amuhon_native_bootstrap_nonce=$bootstrapNonce -c statement_timeout=120000 -c lock_timeout=5000",
    'Process'
  )

  $psql = Join-Path $binaryDirectory 'psql.exe'
  $psqlArguments = @('-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-d', 'amuhon_validation_native', '-W', '-f', $snapshotPath)
  & $psql @psqlArguments
  if ($LASTEXITCODE -ne 0) {
    Stop-NativeBootstrap 'psql failed; the connection was closed and the bootstrap transaction rolled back.'
  }
  Write-Host 'The guarded native bootstrap completed. Its roles are cluster-global.'
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
