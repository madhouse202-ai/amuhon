Set-StrictMode -Version 2.0

function Get-CanonicalPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw [ArgumentException]::new('A path is required.')
  }
  if ($Path.StartsWith('\\', [StringComparison]::Ordinal)) {
    throw [ArgumentException]::new('UNC and device paths are not accepted.')
  }
  try {
    $expandedPath = [Environment]::ExpandEnvironmentVariables($Path)
    if ($expandedPath -notmatch '^[A-Za-z]:[\\/]') {
      throw [ArgumentException]::new('Only fully qualified local Windows drive paths are accepted.')
    }
    $fullPath = [IO.Path]::GetFullPath($expandedPath)
    if ($fullPath.StartsWith('\\', [StringComparison]::Ordinal) -or
        $fullPath.StartsWith('//', [StringComparison]::Ordinal)) {
      throw [ArgumentException]::new('UNC and device paths are not accepted.')
    }
    $rootPath = [IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($rootPath)) {
      throw [ArgumentException]::new('The path has no filesystem root.')
    }
    if ($fullPath.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
      return $rootPath
    }
    return $fullPath.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
  } catch {
    throw [ArgumentException]::new('A required path could not be normalized.')
  }
}

function Assert-NativeLocalDrivePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]') {
    throw [ArgumentException]::new('Only fully qualified local Windows drive paths are accepted.')
  }
  $canonicalPath = Get-CanonicalPath $Path
  if ($canonicalPath -notmatch '^[A-Za-z]:\\') {
    throw [ArgumentException]::new('Only fully qualified local Windows drive paths are accepted.')
  }
  return $canonicalPath
}

function Get-NativeBinaryDirectory([string]$NativeRoot) {
  $canonicalRoot = Assert-NativeLocalDrivePath $NativeRoot
  return Join-Path $canonicalRoot 'pgsql\bin'
}

function Test-NativePgHbaRules([string[]]$Lines) {
  $expectedRules = @(
    'host postgres postgres 127.0.0.1/32 scram-sha-256',
    'host amuhon_validation_native postgres 127.0.0.1/32 scram-sha-256',
    'host all all 127.0.0.1/32 reject',
    'host all all ::1/128 reject'
  )
  $activeRules = @(
    foreach ($line in $Lines) {
      if ($null -eq $line) { continue }
      $normalized = ($line -replace '#.*$', '').Trim()
      if (-not [string]::IsNullOrWhiteSpace($normalized)) {
        ($normalized -split '\s+') -join ' '
      }
    }
  )
  if ($activeRules.Count -ne $expectedRules.Count) { return $false }
  for ($i = 0; $i -lt $expectedRules.Count; $i++) {
    if (-not [string]::Equals($activeRules[$i], $expectedRules[$i], [StringComparison]::Ordinal)) {
      return $false
    }
  }
  return $true
}

function Assert-NativeSystemIdentifier([string[]]$Lines, [string]$Expected) {
  if ([string]::IsNullOrWhiteSpace($Expected) -or $Expected -notmatch '^[0-9]+$') {
    throw [IO.InvalidDataException]::new('The expected PostgreSQL system identifier is malformed.')
  }

  # Keep this source ASCII-only for Windows PowerShell 5.1. The second label is
  # the Unicode spelling emitted by Japanese pg_controldata installations.
  $labelPattern = '^[ \t]*(?:Database system identifier|\u30C7\u30FC\u30BF\u30D9\u30FC\u30B9\u30B7\u30B9\u30C6\u30E0\u8B58\u5225\u5B50)[ \t]*:'
  $valuePattern = '^[ \t]*(?:Database system identifier|\u30C7\u30FC\u30BF\u30D9\u30FC\u30B9\u30B7\u30B9\u30C6\u30E0\u8B58\u5225\u5B50)[ \t]*:[ \t]*([0-9]+)[ \t]*\r?$'
  $identifierLines = @(
    foreach ($line in $Lines) {
      if ($null -ne $line -and [regex]::IsMatch([string]$line, $labelPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
        [string]$line
      }
    }
  )
  if ($identifierLines.Count -ne 1) {
    throw [IO.InvalidDataException]::new('pg_controldata must contain exactly one recognized system-identifier line.')
  }

  $valueMatch = [regex]::Match($identifierLines[0], $valuePattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if (-not $valueMatch.Success) {
    throw [IO.InvalidDataException]::new('The pg_controldata system-identifier line is malformed.')
  }
  if (-not [string]::Equals($valueMatch.Groups[1].Value, $Expected, [StringComparison]::Ordinal)) {
    throw [IO.InvalidDataException]::new('The pg_controldata system identifier does not match the expected value.')
  }
  return $valueMatch.Groups[1].Value
}

function Test-CanonicalPathEqual([string]$Left, [string]$Right) {
  return (Get-CanonicalPath $Left).Equals(
    (Get-CanonicalPath $Right),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Test-PathIsInside([string]$Path, [string]$Parent) {
  $canonicalPath = Get-CanonicalPath $Path
  $canonicalParent = Get-CanonicalPath $Parent
  if ($canonicalPath.Equals($canonicalParent, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  $prefix = if ($canonicalParent.EndsWith([string][IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) {
    $canonicalParent
  } else {
    $canonicalParent + [IO.Path]::DirectorySeparatorChar
  }
  return $canonicalPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePath([string]$Path) {
  $currentPath = Get-CanonicalPath $Path
  $rootPath = [IO.Path]::GetPathRoot($currentPath)
  if ([string]::IsNullOrWhiteSpace($rootPath)) {
    throw [ArgumentException]::new('The path has no filesystem root.')
  }
  while ($true) {
    $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw [InvalidOperationException]::new('A required path includes a symbolic link, junction, or other reparse point.')
    }
    if ($currentPath.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $parentPath = Split-Path -Parent $currentPath
    if ([string]::IsNullOrWhiteSpace($parentPath)) {
      throw [InvalidOperationException]::new('The path ancestry ended before its filesystem root.')
    }
    $canonicalParent = Get-CanonicalPath $parentPath
    if ($canonicalParent.Equals($currentPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw [InvalidOperationException]::new('The path ancestry did not make progress.')
    }
    $currentPath = $canonicalParent
  }
}

Export-ModuleMember -Function Get-CanonicalPath, Assert-NativeLocalDrivePath, Get-NativeBinaryDirectory, Test-NativePgHbaRules, Assert-NativeSystemIdentifier, Test-CanonicalPathEqual, Test-PathIsInside, Assert-NoReparsePath
