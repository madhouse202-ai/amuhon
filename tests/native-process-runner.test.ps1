$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $PSScriptRoot '..\scripts\native-postgres\native-process-runner.psm1'
if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) { throw 'Process runner module is missing.' }
Import-Module -Name $modulePath -Force -ErrorAction Stop

$mockExecutable = Join-Path ([IO.Path]::GetTempPath()) ('amuhon-native-exit-' + [Guid]::NewGuid().ToString('N') + '.exe')
$source = @'
using System;
public static class AmuhonNativeExitCodeProbe {
    public static int Main(string[] args) {
        int code;
        if (args.Length != 1 || !Int32.TryParse(args[0], out code) || code < 0 || code > 3) return 97;
        return code;
    }
}
'@

try {
  Add-Type -TypeDefinition $source -OutputAssembly $mockExecutable -OutputType ConsoleApplication -ErrorAction Stop | Out-Null
  if (-not (Test-Path -LiteralPath $mockExecutable -PathType Leaf)) {
    throw 'The process-only mock executable was not created.'
  }

  function Get-DirectMockProcessExitCode([string]$Executable, [string]$CommandLineArguments) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    $startInfo.Arguments = $CommandLineArguments
    $startInfo.UseShellExecute = $false

    $process = $null
    try {
      $process = [System.Diagnostics.Process]::Start($startInfo)
      if (-not $process.WaitForExit(10000)) {
        try { $process.Kill() } catch { }
        throw 'Direct mock process exceeded its fixed timeout.'
      }
      $process.Refresh()
      if (-not $process.HasExited) { throw 'Direct mock process did not report exit.' }
      return [int]$process.ExitCode
    } finally {
      if ($null -ne $process) {
        try {
          if (-not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit(5000) | Out-Null
          }
        } catch { }
        $process.Dispose()
      }
    }
  }

  foreach ($expectedCode in @(0, 1, 2, 3)) {
    $mockArguments = [string]$expectedCode
    $directCode = Get-DirectMockProcessExitCode -Executable $mockExecutable -CommandLineArguments $mockArguments
    if ($directCode -ne $expectedCode) {
      throw "Direct mock process returned $directCode; expected $expectedCode."
    }

    $actualCode = Invoke-NativeProcessWithTimeout -FilePath $mockExecutable -Arguments @($mockArguments) -TimeoutSeconds 10
    if ($actualCode -ne $expectedCode) {
      throw "Shared process runner returned $actualCode; expected $expectedCode."
    }
    if ($actualCode -ne $directCode) {
      throw "Shared process runner returned $actualCode; direct process returned $directCode."
    }

    if ($expectedCode -eq 0) {
      Assert-NativePsqlSuccess -ExitCode $actualCode
    } else {
      $rejected = $false
      try {
        Assert-NativePsqlSuccess -ExitCode $actualCode
      } catch {
        if ($_.Exception.Message -notmatch "exit code $expectedCode(?:\D|$)") {
          throw 'Nonzero exit diagnostic did not identify the numeric code safely.'
        }
        $rejected = $true
      }
      if (-not $rejected) { throw "Nonzero mock exit code $expectedCode was accepted." }
    }
    Write-Host "PASS mock process exit code $actualCode"
  }
} finally {
  if (Test-Path -LiteralPath $mockExecutable -PathType Leaf) {
    Remove-Item -LiteralPath $mockExecutable -Force
  }
}
