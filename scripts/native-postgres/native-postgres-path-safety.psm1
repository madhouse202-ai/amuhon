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

function Test-NativePostgresCommandLine([string]$CommandLine, [string]$ExpectedExecutable, [string]$ExpectedDataDirectory) {
  if ([string]::IsNullOrWhiteSpace($CommandLine) -or
      [string]::IsNullOrWhiteSpace($ExpectedExecutable) -or
      [string]::IsNullOrWhiteSpace($ExpectedDataDirectory)) { return $false }

  # Parse native Windows arguments with the OS parser; never search the raw
  # command line or rewrite its separators globally.
  if (-not ('Amuhon.NativePostgres.Win32CommandLineParser' -as [type])) {
    $parserSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace Amuhon.NativePostgres {
  public static class Win32CommandLineParser {
    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Parse(string commandLine) {
      int count;
      IntPtr argv = CommandLineToArgvW(commandLine, out count);
      if (argv == IntPtr.Zero || count <= 0) throw new InvalidOperationException("Windows argument parsing failed.");
      try {
        var result = new List<string>(count);
        for (int i = 0; i < count; i++) result.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)));
        return result.ToArray();
      } finally { LocalFree(argv); }
    }
  }
}
'@
    try { Add-Type -TypeDefinition $parserSource -Language CSharp -ErrorAction Stop | Out-Null } catch { return $false }
  }

  try {
    $arguments = @([Amuhon.NativePostgres.Win32CommandLineParser]::Parse($CommandLine))
    if ($arguments.Count -lt 3 -or
        -not (Test-CanonicalPathEqual ([string]$arguments[0]) $ExpectedExecutable)) { return $false }
    $dataOptionIndexes = @()
    for ($i = 1; $i -lt $arguments.Count; $i++) {
      $argument = [string]$arguments[$i]
      if ([string]::Equals($argument, '-D', [StringComparison]::Ordinal)) {
        $dataOptionIndexes += $i
      } elseif ($argument -match '^(?i:-D.+|--pgdata(?:=.*)?)$' -or $argument -eq '--') {
        return $false
      }
    }
    if ($dataOptionIndexes.Count -ne 1) { return $false }
    $dataIndex = [int]$dataOptionIndexes[0]
    if (($dataIndex + 1) -ge $arguments.Count) { return $false }
    return Test-CanonicalPathEqual ([string]$arguments[$dataIndex + 1]) $ExpectedDataDirectory
  } catch { return $false }
}

function Test-NativeBootstrapTransactionStructure([string]$Sql) {
  if ([string]::IsNullOrWhiteSpace($Sql)) { return $false }
  # The wrapper separately rejects every psql command except this exact
  # setting. Remove it before lexing SQL statement boundaries.
  $sqlText = [regex]::Replace($Sql, '(?im)^\s*\\set\s+ON_ERROR_STOP\s+on\s*$', '')
  $statements = New-Object 'System.Collections.Generic.List[string]'
  $statement = New-Object System.Text.StringBuilder
  $length = $sqlText.Length
  $index = 0

  while ($index -lt $length) {
    $character = $sqlText[$index]
    $next = if (($index + 1) -lt $length) { $sqlText[$index + 1] } else { [char]0 }

    if ($character -eq '-' -and $next -eq '-') {
      [void]$statement.Append('  ')
      $index += 2
      while ($index -lt $length -and $sqlText[$index] -ne "`n" -and $sqlText[$index] -ne "`r") {
        [void]$statement.Append(' ')
        $index++
      }
      continue
    }

    if ($character -eq '/' -and $next -eq '*') {
      $depth = 1
      [void]$statement.Append('  ')
      $index += 2
      while ($index -lt $length -and $depth -gt 0) {
        $commentNext = if (($index + 1) -lt $length) { $sqlText[$index + 1] } else { [char]0 }
        if ($sqlText[$index] -eq '/' -and $commentNext -eq '*') {
          $depth++
          [void]$statement.Append('  ')
          $index += 2
        } elseif ($sqlText[$index] -eq '*' -and $commentNext -eq '/') {
          $depth--
          [void]$statement.Append('  ')
          $index += 2
        } else {
          [void]$statement.Append(' ')
          $index++
        }
      }
      if ($depth -ne 0) { return $false }
      continue
    }

    if ($character -eq "'" -or $character -eq '"') {
      $quote = $character
      $isString = $quote -eq "'"
      [void]$statement.Append(' ')
      $index++
      $closed = $false
      while ($index -lt $length) {
        $quotedCharacter = $sqlText[$index]
        if ($isString -and $quotedCharacter -eq '\') {
          # Do not guess whether this is an escape string or standard string.
          return $false
        }
        if ($quotedCharacter -eq $quote) {
          if (($index + 1) -lt $length -and $sqlText[$index + 1] -eq $quote) {
            [void]$statement.Append('  ')
            $index += 2
          } else {
            [void]$statement.Append(' ')
            $index++
            $closed = $true
            break
          }
        } else {
          [void]$statement.Append(' ')
          $index++
        }
      }
      if (-not $closed) { return $false }
      continue
    }

    if ($character -eq '$') {
      $canStartDollarQuote = $true
      if ($index -gt 0) {
        $previousCharacter = [string]$sqlText[$index - 1]
        if ([regex]::IsMatch($previousCharacter, '[\p{L}\p{N}\p{M}_$]')) {
          # PostgreSQL treats a dollar sign adjacent to an identifier as part
          # of that identifier, not as the start of a dollar-quoted string.
          $canStartDollarQuote = $false
        }
      }
      $dollarMatch = if ($canStartDollarQuote) {
        [regex]::Match($sqlText.Substring($index), '^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$')
      } else {
        [System.Text.RegularExpressions.Match]::Empty
      }
      if ($dollarMatch.Success) {
        $tag = $dollarMatch.Value
        $closingIndex = $sqlText.IndexOf($tag, $index + $tag.Length, [StringComparison]::Ordinal)
        if ($closingIndex -lt 0) { return $false }
        $afterTag = $closingIndex + $tag.Length
        while ($index -lt $afterTag) {
          [void]$statement.Append(' ')
          $index++
        }
        continue
      }
    }

    if ($character -eq ';') {
      $completedStatement = $statement.ToString().Trim()
      if ([string]::IsNullOrWhiteSpace($completedStatement)) { return $false }
      $statements.Add($completedStatement)
      [void]$statement.Clear()
      $index++
      continue
    }

    [void]$statement.Append($character)
    $index++
  }

  if (-not [string]::IsNullOrWhiteSpace($statement.ToString())) { return $false }
  if ($statements.Count -lt 2) { return $false }

  $normalized = @(
    foreach ($item in $statements) {
      ([regex]::Replace($item, '\s+', ' ')).Trim()
    }
  )
  if (-not [string]::Equals($normalized[0], 'begin', [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($normalized[$normalized.Count - 1], 'commit', [StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  $transactionControlPattern = '^(?i:begin|start\s+transaction|commit|end|rollback|abort|savepoint|release(?:\s+savepoint)?|prepare\s+transaction)\b'
  for ($statementIndex = 0; $statementIndex -lt $normalized.Count; $statementIndex++) {
    if ($normalized[$statementIndex] -match $transactionControlPattern) {
      if (($statementIndex -eq 0 -and $normalized[$statementIndex] -ieq 'begin') -or
          ($statementIndex -eq ($normalized.Count - 1) -and $normalized[$statementIndex] -ieq 'commit')) {
        continue
      }
      return $false
    }
  }
  return $true
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

Export-ModuleMember -Function Get-CanonicalPath, Assert-NativeLocalDrivePath, Get-NativeBinaryDirectory, Test-NativePgHbaRules, Assert-NativeSystemIdentifier, Test-CanonicalPathEqual, Test-NativePostgresCommandLine, Test-NativeBootstrapTransactionStructure, Test-PathIsInside, Assert-NoReparsePath
