[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SupabaseWorkdir,

  [ValidateSet('targeted-claim', 'asset-commit', 'both')]
  [string]$Test = 'both'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$defaultDbPort = 54322
$expectedDbName = 'postgres'
$expectedDbUser = 'postgres'
$expectedAppName = 'amuhon-local-order-validation'
$expectedTestMarker = 'amuhon-local-isolated-v1'

function Stop-Safely([string]$Message) {
  throw "Local SQL test refused: $Message"
}

function Invoke-Captured([string]$File, [string[]]$Arguments) {
  $captured = @(& $File @Arguments 2>$null)
  if ($LASTEXITCODE -ne 0) {
    Stop-Safely "a required local inspection command failed ($([IO.Path]::GetFileName($File)))."
  }
  return ,$captured
}

try {
  $workdir = (Resolve-Path -LiteralPath $SupabaseWorkdir).Path
  $repoPrefix = $repoRoot.TrimEnd('\') + '\'
  if ($workdir.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $workdir.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Safely 'Supabase workdir must be a disposable directory outside the repository.'
  }

  $configPath = Join-Path $workdir 'supabase\config.toml'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Stop-Safely 'the supplied disposable workdir has no supabase/config.toml.'
  }
  $config = Get-Content -LiteralPath $configPath -Raw
  $projectMatches = [regex]::Matches($config, '(?m)^\s*project_id\s*=\s*"([a-zA-Z0-9_-]+)"\s*$')
  if ($projectMatches.Count -ne 1) {
    Stop-Safely 'could not uniquely identify the local Supabase project from config.toml.'
  }
  $projectId = $projectMatches[0].Groups[1].Value
  if ($projectId -notmatch '^amuhon-local(?:[-_][a-zA-Z0-9_-]+)?$' -or
      $projectId -match '(?i)staging|prod') {
    Stop-Safely 'project_id must be an explicit amuhon-local-* identifier.'
  }

  # The repository is not linked to a cloud project. Refuse a linked workdir.
  $linkedRefPath = Join-Path $workdir 'supabase\.temp\project-ref'
  if (Test-Path -LiteralPath $linkedRefPath) {
    Stop-Safely 'the Supabase workdir contains a linked project reference.'
  }

  if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
    Stop-Safely 'Supabase CLI is not installed or not on PATH.'
  }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-Safely 'Docker CLI is not installed or not on PATH.'
  }
  $psql = Get-Command psql -ErrorAction SilentlyContinue
  if (-not $psql) {
    Stop-Safely 'psql is not installed or not on PATH.'
  }

  # Supabase CLI status output contains local keys. Keep it in memory only;
  # never emit it, include it in an exception, or write it to a file.
  $statusLines = Invoke-Captured 'supabase' @('status', '--workdir', $workdir, '--env', '--output-format', 'text')
  $dbUrlLines = @($statusLines | Where-Object { $_ -match '^\s*DB_URL=' })
  if ($dbUrlLines.Count -ne 1) {
    Stop-Safely 'local CLI status did not provide exactly one DB_URL.'
  }
  $dbUrlText = ($dbUrlLines[0] -replace '^\s*DB_URL=', '').Trim().Trim('"').Trim("'")
  $dbUri = $null
  if (-not [Uri]::TryCreate($dbUrlText, [UriKind]::Absolute, [ref]$dbUri) -or
      $dbUri.Scheme -notin @('postgres', 'postgresql') -or
      $dbUri.Host -notin @('127.0.0.1', 'localhost', '::1') -or
      $dbUri.Port -ne $defaultDbPort -or
      $dbUri.AbsolutePath.Trim('/') -ne $expectedDbName -or
      [Uri]::UnescapeDataString($dbUri.UserInfo.Split(':')[0]) -ne $expectedDbUser) {
    Stop-Safely 'CLI-reported DB endpoint does not match the fixed local database target.'
  }
  $dbUrlText = $null
  $dbUri = $null
  $statusLines = $null

  # The port must map only to this project's running Supabase DB container and
  # be published on loopback. Any ambiguous or LAN/public binding is rejected.
  $containerLines = Invoke-Captured 'docker' @('ps', '--filter', "name=^/supabase_db_$projectId$", '--format', '{{.ID}}|{{.Names}}')
  $containerLines = @($containerLines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($containerLines.Count -ne 1) {
    Stop-Safely 'could not identify exactly one running database container for the configured local project.'
  }
  $containerParts = $containerLines[0].Split('|', 2)
  if ($containerParts.Count -ne 2 -or $containerParts[1].TrimStart('/') -ne "supabase_db_$projectId") {
    Stop-Safely 'the running database container name is ambiguous.'
  }
  $identityLines = Invoke-Captured 'docker' @('inspect', '--format', '{{.Config.Image}}|{{json .Config.Labels}}', $containerParts[0])
  $identity = ($identityLines -join '').Split('|', 2)
  if ($identity.Count -ne 2 -or
      ($identity[0] -notlike 'public.ecr.aws/supabase/postgres:*' -and $identity[0] -notlike 'supabase/postgres:*')) {
    Stop-Safely 'the database container is not an identified Supabase Postgres image.'
  }
  $labels = $null
  try { $labels = $identity[1] | ConvertFrom-Json } catch { Stop-Safely 'Docker returned unreadable database container labels.' }
  if ($labels.'com.docker.compose.service' -ne 'db') {
    Stop-Safely 'the container is not identified as the local Supabase database service.'
  }
  $portJsonLines = Invoke-Captured 'docker' @('inspect', '--format', '{{json .NetworkSettings.Ports}}', $containerParts[0])
  $portJson = $portJsonLines -join ''
  $portMap = $null
  try { $portMap = $portJson | ConvertFrom-Json } catch { Stop-Safely 'Docker returned an unreadable port mapping.' }
  $published = @($portMap.'5432/tcp')
  if ($published.Count -ne 1 -or $published[0].HostPort -ne "$defaultDbPort" -or
      $published[0].HostIp -notin @('127.0.0.1', '::1')) {
    Stop-Safely 'database port is not mapped exactly once to the default port on loopback.'
  }

  # Check the listening process as an additional defense against a local proxy
  # or port-forward. Unknown ownership is a hard stop.
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $defaultDbPort -ErrorAction Stop)
  if ($listeners.Count -lt 1) {
    Stop-Safely 'the expected local database port has no listener.'
  }
  $allowedOwners = @('com.docker.backend', 'docker-proxy', 'wslhost', 'wslrelay')
  foreach ($listener in $listeners) {
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if (-not $owner -or $owner.ProcessName -notin $allowedOwners) {
      Stop-Safely 'the database port listener is not an identified Docker Desktop forwarding process.'
    }
  }

  $sqlFiles = switch ($Test) {
    'targeted-claim' { @((Join-Path $repoRoot 'supabase\tests\local\order_validation_targeted_claim.local.sql')) }
    'asset-commit' { @((Join-Path $repoRoot 'supabase\tests\local\order_validation_asset_commit.local.sql')) }
    default {
      @(
        (Join-Path $repoRoot 'supabase\tests\local\order_validation_targeted_claim.local.sql'),
        (Join-Path $repoRoot 'supabase\tests\local\order_validation_asset_commit.local.sql')
      )
    }
  }
  foreach ($sqlFile in $sqlFiles) {
    if (-not (Test-Path -LiteralPath $sqlFile -PathType Leaf)) {
      Stop-Safely 'a selected local-only SQL test file is missing.'
    }
  }

  # Pin libpq routing/auth-related environment variables for this child only.
  $variableNames = @('PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGCONNECT_TIMEOUT', 'PGSSLMODE', 'PGTARGETSESSIONATTRS', 'PGOPTIONS', 'PGAPPNAME')
  $oldEnvironment = @{}
  foreach ($name in $variableNames) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  [Environment]::SetEnvironmentVariable('PGCONNECT_TIMEOUT', '5', 'Process')
  [Environment]::SetEnvironmentVariable('PGOPTIONS', "-c app.amuhon_test_environment=$expectedTestMarker -c statement_timeout=120000 -c lock_timeout=5000", 'Process')
  [Environment]::SetEnvironmentVariable('PGAPPNAME', $expectedAppName, 'Process')
  try {
    foreach ($sqlFile in $sqlFiles) {
      Write-Host "Running isolated local SQL test: $(Split-Path -Leaf $sqlFile)"
      & $psql.Source -X -v ON_ERROR_STOP=1 -h '127.0.0.1' -p "$defaultDbPort" -U $expectedDbUser -d $expectedDbName -W -f $sqlFile
      if ($LASTEXITCODE -ne 0) {
        Stop-Safely 'psql reported a test failure; its process was closed so PostgreSQL rolls back the open transaction.'
      }
    }
  }
  finally {
    foreach ($name in $variableNames) {
      [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process')
    }
  }

  Write-Host 'Selected local SQL tests completed successfully.'
}
catch {
  # Never print captured CLI/DB URLs, keys, passwords, or raw command errors.
  Write-Error $_.Exception.Message
  exit 1
}
