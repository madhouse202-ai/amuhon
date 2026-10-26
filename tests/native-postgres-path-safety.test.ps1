$ErrorActionPreference = 'Stop'
$module = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\native-postgres\native-postgres-path-safety.psm1'
Import-Module -Name $module -Force -ErrorAction Stop

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

Write-Output 'Native path-safety PowerShell tests passed.'
