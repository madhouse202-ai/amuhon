$ErrorActionPreference = 'Stop'
$module = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\native-postgres\native-postgres-path-safety.psm1'
Import-Module -Name $module -Force -ErrorAction Stop

$expectedExecutable = 'C:\amuhon-native-pg\pgsql\bin\postgres.exe'
$expectedDataDirectory = 'C:\amuhon-native-pg\cluster'
$forwardSlashCommandLine = '"C:/amuhon-native-pg/pgsql/bin/postgres.exe" -D "C:/amuhon-native-pg/cluster"'
if (-not (Test-NativePostgresCommandLine $forwardSlashCommandLine $expectedExecutable $expectedDataDirectory)) {
  throw 'A valid command line with forward-slash paths was rejected.'
}
if (-not (Test-NativePostgresCommandLine '"c:\AMUHON-NATIVE-PG\pgsql\bin\postgres.exe" -D "C:\amuhon-native-pg\cluster"' $expectedExecutable $expectedDataDirectory)) {
  throw 'A valid command line with case variants was rejected.'
}

$invalidCommandLines = @(
  @{ Value = '"C:\other\postgres.exe" -D "C:\amuhon-native-pg\cluster"'; Name = 'wrong executable' },
  @{ Value = '"C:\amuhon-native-pg\pgsql\bin\postgres.exe.old" -D "C:\amuhon-native-pg\cluster"'; Name = 'executable path prefix' },
  @{ Value = '"C:\amuhon-native-pg\pgsql\bin\postgres.exe" -D "C:\amuhon-native-pg\cluster-old"'; Name = 'data directory path prefix' },
  @{ Value = '"C:\amuhon-native-pg\pgsql\bin\postgres.exe"'; Name = 'missing data option' },
  @{ Value = '"C:\amuhon-native-pg\pgsql\bin\postgres.exe" -D'; Name = 'missing data option value' },
  @{ Value = '"C:\amuhon-native-pg\pgsql\bin\postgres.exe" -D "C:\amuhon-native-pg\cluster" -D "C:\other"'; Name = 'duplicate data option' },
  @{ Value = '"C:\amuhon-native-pg\pgsql\bin\postgres.exe" -DC:\amuhon-native-pg\cluster'; Name = 'attached data option' },
  @{ Value = '"C:\amuhon-native-pg\pgsql\bin\postgres.exe" --pgdata="C:\amuhon-native-pg\cluster"'; Name = 'alternate data option' },
  @{ Value = '"C:\amuhon-native-pg\pgsql\bin\postgres.exe" -- -D "C:\amuhon-native-pg\cluster"'; Name = 'option terminator' },
  @{ Value = '"C:\amuhon-native-pg\pgsql\bin\postgres.exe" -D "\\server\share\cluster"'; Name = 'UNC data directory' }
)
foreach ($case in $invalidCommandLines) {
  if (Test-NativePostgresCommandLine $case.Value $expectedExecutable $expectedDataDirectory) {
    throw "The invalid process command line was accepted: $($case.Name)."
  }
}

$driveRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath((Get-Location).Path))
$canonicalRoot = Get-CanonicalPath $driveRoot
if (-not $canonicalRoot.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Drive root normalization did not preserve its trailing separator.'
}
if (-not (Test-CanonicalPathEqual $canonicalRoot (Get-CanonicalPath $canonicalRoot))) {
  throw 'Drive root normalization is not idempotent.'
}
if (-not (Test-PathIsInside ($driveRoot + 'native-test') $driveRoot)) {
  throw 'Drive-root containment check failed.'
}
Assert-NoReparsePath $driveRoot

$uncRejected = $false
try {
  [void](Assert-NativeLocalDrivePath '\\server\share\native')
} catch {
  $uncRejected = $true
}
if (-not $uncRejected) {
  throw 'UNC paths were not rejected.'
}

$relativeRejected = $false
try {
  [void](Assert-NativeLocalDrivePath 'relative\native')
} catch {
  $relativeRejected = $true
}
if (-not $relativeRejected) {
  throw 'Relative paths were not rejected.'
}

$driveRelativeRejected = $false
try {
  [void](Assert-NativeLocalDrivePath 'C:native\cluster')
} catch {
  $driveRelativeRejected = $true
}
if (-not $driveRelativeRejected) {
  throw 'Drive-relative paths were not rejected.'
}

$nativeRoot = 'C:\amuhon-native-pg'
$expectedBinaryDirectory = 'C:\amuhon-native-pg\pgsql\bin'
if (-not (Test-CanonicalPathEqual (Get-NativeBinaryDirectory $nativeRoot) $expectedBinaryDirectory)) {
  throw 'Native PostgreSQL binary directory did not resolve to NativeRoot\pgsql\bin.'
}
if ((Get-NativeBinaryDirectory $nativeRoot) -eq (Join-Path $nativeRoot 'bin')) {
  throw 'Native PostgreSQL binary resolver fell back to the legacy NativeRoot\bin layout.'
}

$expectedHbaRules = @(
  'host postgres postgres 127.0.0.1/32 scram-sha-256',
  'host amuhon_validation_native postgres 127.0.0.1/32 scram-sha-256',
  'host all all 127.0.0.1/32 reject',
  'host all all ::1/128 reject'
)
if (-not (Test-NativePgHbaRules $expectedHbaRules)) {
  throw 'The exact reviewed pg_hba.conf rule set was not accepted.'
}
if (Test-NativePgHbaRules @($expectedHbaRules[1], $expectedHbaRules[0], $expectedHbaRules[2], $expectedHbaRules[3])) {
  throw 'Reordered pg_hba.conf rules were accepted.'
}
if (Test-NativePgHbaRules @($expectedHbaRules + 'host all all 0.0.0.0/0 trust')) {
  throw 'An extra permissive pg_hba.conf rule was accepted.'
}
if (Test-NativePgHbaRules @($expectedHbaRules[0], 'include ''extra.conf''', $expectedHbaRules[1], $expectedHbaRules[2], $expectedHbaRules[3])) {
  throw 'A pg_hba.conf include directive was accepted.'
}
if (Test-NativePgHbaRules @($expectedHbaRules[0], $expectedHbaRules[1], $expectedHbaRules[2], $expectedHbaRules[3], 'local all all trust')) {
  throw 'An extra local-socket authentication rule was accepted.'
}
if (-not (Test-NativePgHbaRules @('# approved config', '', ($expectedHbaRules[0] + ' # bootstrap database'), $expectedHbaRules[1], $expectedHbaRules[2], $expectedHbaRules[3]))) {
  throw 'Comments or blank lines changed the active pg_hba.conf rules unexpectedly.'
}

$expectedSystemIdentifier = '7701314913455684496'
$japaneseIdentifierLabel = -join @([char]0x30C7, [char]0x30FC, [char]0x30BF, [char]0x30D9, [char]0x30FC, [char]0x30B9, [char]0x30B7, [char]0x30B9, [char]0x30C6, [char]0x30E0, [char]0x8B58, [char]0x5225, [char]0x5B50)
$japaneseIdentifierLine = $japaneseIdentifierLabel + ': ' + $expectedSystemIdentifier
$englishIdentifierLine = 'Database system identifier: ' + $expectedSystemIdentifier
if ((Assert-NativeSystemIdentifier @($japaneseIdentifierLine) $expectedSystemIdentifier) -cne $expectedSystemIdentifier) {
  throw 'The Japanese pg_controldata system-identifier line was not recognized.'
}
if ((Assert-NativeSystemIdentifier @($englishIdentifierLine) $expectedSystemIdentifier) -cne $expectedSystemIdentifier) {
  throw 'The English pg_controldata system-identifier line was not recognized.'
}

$invalidIdentifierCases = @(
  @{ Lines = @('Database system identifier: 7701314913455684496'); Expected = '7701314913455684497'; Name = 'mismatch' },
  @{ Lines = @($japaneseIdentifierLine, $englishIdentifierLine); Expected = $expectedSystemIdentifier; Name = 'duplicate recognized labels' },
  @{ Lines = @('garbled-label: 7701314913455684496'); Expected = $expectedSystemIdentifier; Name = 'unrecognized or garbled label' },
  @{ Lines = @($japaneseIdentifierLabel + ': 7701314913455684496 extra'); Expected = $expectedSystemIdentifier; Name = 'malformed value line' },
  @{ Lines = @(); Expected = $expectedSystemIdentifier; Name = 'missing label' }
)
foreach ($case in $invalidIdentifierCases) {
  $rejected = $false
  try {
    $null = Assert-NativeSystemIdentifier $case.Lines $case.Expected
  } catch {
    $rejected = $true
  }
  if (-not $rejected) {
    throw "The invalid system-identifier case was accepted: $($case.Name)."
  }
}

Write-Output 'Native path-safety PowerShell tests passed.'
