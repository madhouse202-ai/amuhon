Set-StrictMode -Version 2.0

function Invoke-NativeProcessWithTimeout([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 180) {
  if ([string]::IsNullOrWhiteSpace($FilePath) -or $TimeoutSeconds -lt 1) {
    throw [ArgumentException]::new('A process path and positive timeout are required.')
  }

  $process = $null
  try {
    # Use ProcessStartInfo directly: Windows PowerShell 5.1's Start-Process
    # returned an incorrect ExitCode in the process-only regression test.
    # Leave standard handles attached for interactive psql -W; never log args.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = [string]::Join(' ', $Arguments)
    $startInfo.UseShellExecute = $false
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) {
      throw [InvalidOperationException]::new('The native process could not be started.')
    }
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try { $process.Kill() } catch { }
      throw [TimeoutException]::new('The native process exceeded its fixed timeout and was terminated.')
    }
    $process.Refresh()
    if (-not $process.HasExited) {
      throw [InvalidOperationException]::new('The native process did not report an exited state after waiting.')
    }
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

function Assert-NativePsqlSuccess([int]$ExitCode) {
  if ($ExitCode -ne 0) {
    throw [InvalidOperationException]::new("psql returned exit code $ExitCode; operation failed. Reconcile database state with guarded Status before retrying.")
  }
}

Export-ModuleMember -Function Invoke-NativeProcessWithTimeout, Assert-NativePsqlSuccess
