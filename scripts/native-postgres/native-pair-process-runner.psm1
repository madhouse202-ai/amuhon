Set-StrictMode -Version 2.0

if (-not ('Amuhon.NativePairBoundedCapture' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Amuhon {
  public sealed class NativePairBoundedCapture {
    private readonly object gate = new object();
    private readonly StringBuilder tail = new StringBuilder();
    private readonly int maximumCharacters;
    private long totalCharacters;

    public NativePairBoundedCapture(int maximumCharacters) {
      if (maximumCharacters < 256) throw new ArgumentOutOfRangeException("maximumCharacters");
      this.maximumCharacters = maximumCharacters;
    }

    public Task Start(TextReader reader) {
      if (reader == null) throw new ArgumentNullException("reader");
      return Task.Factory.StartNew(() => {
        char[] chunk = new char[4096];
        int count;
        while ((count = reader.Read(chunk, 0, chunk.Length)) > 0) Append(chunk, count);
      }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    private void Append(char[] chunk, int count) {
      lock (gate) {
        totalCharacters += count;
        int excess = tail.Length + count - maximumCharacters;
        if (excess > 0) {
          if (excess >= tail.Length) tail.Clear();
          else tail.Remove(0, excess);
          int skip = Math.Max(0, count - maximumCharacters);
          tail.Append(chunk, skip, count - skip);
        } else {
          tail.Append(chunk, 0, count);
        }
      }
    }

    public string Snapshot() { lock (gate) return tail.ToString(); }
    public long TotalCharacters { get { lock (gate) return totalCharacters; } }
    public bool Truncated { get { lock (gate) return totalCharacters > tail.Length; } }
  }
}
'@ -ErrorAction Stop | Out-Null
}

if (-not ('Amuhon.NativePairSecureInput' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Threading;
using System.Threading.Tasks;

namespace Amuhon {
  public static class NativePairSecureInput {
    public static Task WriteAndCloseAsync(Process process, SecureString password) {
      if (process == null) throw new ArgumentNullException("process");
      if (password == null || password.Length == 0) throw new ArgumentException("A non-empty in-memory password is required.", "password");
      IntPtr pointer = IntPtr.Zero;
      char[] characters = new char[password.Length];
      try {
        pointer = Marshal.SecureStringToGlobalAllocUnicode(password);
        Marshal.Copy(pointer, characters, 0, characters.Length);
      } finally {
        if (pointer != IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(pointer);
      }
      try {
        return Task.Factory.StartNew(() => {
          try {
            using (TextWriter writer = process.StandardInput) {
              writer.Write(characters, 0, characters.Length);
              writer.WriteLine();
              writer.Flush();
            }
          } finally {
            Array.Clear(characters, 0, characters.Length);
          }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
      } catch {
        Array.Clear(characters, 0, characters.Length);
        throw;
      }
    }
  }
}
'@ -ErrorAction Stop | Out-Null
}

$script:NativePairLibpqEnvironmentNames = @(
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE',
  'PGSERVICE', 'PGSERVICEFILE', 'PGCONNECT_TIMEOUT', 'PGSSLMODE', 'PGTARGETSESSIONATTRS',
  'PGOPTIONS', 'PGAPPNAME', 'PGCLIENTENCODING', 'PGGSSENCMODE', 'PGCHANNELBINDING'
)

function ConvertTo-NativeWindowsArgument([string]$Value) {
  if ($null -eq $Value) { throw [ArgumentNullException]::new('Value') }
  $builder = New-Object Text.StringBuilder
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $slashes++; continue }
    if ($character -eq '"') {
      if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes + 1))) }
      else { [void]$builder.Append('\') }
      [void]$builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function New-NativePairStartInfo(
  [string]$FilePath,
  [string[]]$Arguments,
  [System.Collections.IDictionary]$EnvironmentOverrides
) {
  if ([string]::IsNullOrWhiteSpace($FilePath) -or $null -eq $Arguments -or $null -eq $EnvironmentOverrides) {
    throw [ArgumentException]::new('Fixed process inputs are required.')
  }
  $allowedOverrides = @('PGCONNECT_TIMEOUT', 'PGPASSFILE', 'PGOPTIONS', 'PGAPPNAME')
  foreach ($name in $EnvironmentOverrides.Keys) {
    if ($name -notin $allowedOverrides) {
      throw [ArgumentException]::new('An unapproved libpq environment override was rejected.')
    }
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = [string]::Join(' ', @($Arguments | ForEach-Object { ConvertTo-NativeWindowsArgument ([string]$_) }))
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $inheritedLibpqNames = @($startInfo.EnvironmentVariables.Keys | Where-Object { ([string]$_).StartsWith('PG', [StringComparison]::OrdinalIgnoreCase) })
  foreach ($name in $inheritedLibpqNames) {
    [void]$startInfo.EnvironmentVariables.Remove([string]$name)
  }
  foreach ($name in $EnvironmentOverrides.Keys) {
    $startInfo.EnvironmentVariables[[string]$name] = [string]$EnvironmentOverrides[$name]
  }
  return $startInfo
}

function Write-NativeSecurePasswordToProcess([System.Diagnostics.Process]$Process, [Security.SecureString]$Password) {
  if ($null -eq $Process -or $null -eq $Password -or $Password.Length -eq 0) {
    throw [ArgumentException]::new('A non-empty in-memory password is required.')
  }
  $pointer = [IntPtr]::Zero
  $characters = New-Object char[] $Password.Length
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Password)
    [Runtime.InteropServices.Marshal]::Copy($pointer, $characters, 0, $characters.Length)
    $writer = $Process.StandardInput
    $writer.Write($characters, 0, $characters.Length)
    $writer.WriteLine()
    $writer.Flush()
    $writer.Dispose()
  } catch {
    try { if (-not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit(5000) | Out-Null } } catch { }
    throw [InvalidOperationException]::new('The in-memory credential could not be sent to the local client process.')
  } finally {
    [Array]::Clear($characters, 0, $characters.Length)
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer)
    }
  }
}

function Start-NativePairProcess(
  [string]$FilePath,
  [string[]]$Arguments,
  [System.Collections.IDictionary]$EnvironmentOverrides,
  [Security.SecureString]$Password
) {
  $process = $null
  try {
    $startInfo = New-NativePairStartInfo $FilePath $Arguments $EnvironmentOverrides
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw [InvalidOperationException]::new('The fixed local client process did not start.') }
    Write-NativeSecurePasswordToProcess $process $Password
    return $process
  } catch {
    if ($null -ne $process) {
      try { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit(5000) | Out-Null } } catch { }
      $process.Dispose()
    }
    throw
  }
}

function Invoke-NativePairAuthProbe(
  [string]$PsqlPath,
  [string[]]$Arguments,
  [System.Collections.IDictionary]$EnvironmentOverrides,
  [Security.SecureString]$Password,
  [int]$TimeoutSeconds = 15
) {
  if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 30) {
    throw [ArgumentOutOfRangeException]::new('TimeoutSeconds', 'The read-only auth probe timeout must be between 1 and 30 seconds.')
  }
  $process = $null
  $outputTask = $null
  try {
    $startInfo = New-NativePairStartInfo $PsqlPath $Arguments $EnvironmentOverrides
    $startInfo.RedirectStandardOutput = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw [InvalidOperationException]::new('The fixed local client process did not start.') }
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    Write-NativeSecurePasswordToProcess $process $Password
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      [void](Stop-NativePairProcess $process)
      throw [TimeoutException]::new('The read-only local authentication probe exceeded its fixed timeout and was terminated.')
    }
    $process.Refresh()
    if (-not $process.HasExited) {
      throw [InvalidOperationException]::new('The read-only local client did not report an exited state after waiting.')
    }
    $output = $outputTask.GetAwaiter().GetResult()
    return [pscustomobject]@{
      ExitCode = [int]$process.ExitCode
      Output = [string]$output
    }
  } finally {
    $closed = Stop-NativePairProcess $process
    if ($null -ne $process) { $process.Dispose() }
    if (-not $closed) {
      throw [InvalidOperationException]::new('The read-only local client could not be confirmed closed.')
    }
  }
}

function Stop-NativePairProcess([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return $true }
  try {
    $Process.Refresh()
    if (-not $Process.HasExited) {
      $Process.Kill()
      if (-not $Process.WaitForExit(10000)) { return $false }
    }
    $Process.Refresh()
    return [bool]$Process.HasExited
  } catch {
    return $false
  }
}

function Start-NativePairObservedProcess(
  [string]$Name,
  [string]$FilePath,
  [string[]]$Arguments,
  [System.Collections.IDictionary]$EnvironmentOverrides,
  [Security.SecureString]$Password
) {
  $process = $null
  $record = [pscustomobject]@{
    Name = $Name
    StartRequestedAtUtc = [DateTime]::UtcNow.ToString('o')
    StartedAtUtc = $null
    PasswordSentAtUtc = $null
    EndedAtUtc = $null
    ExitCode = $null
    WasRunningAtTimeout = $false
    TerminationAttempted = $false
    TerminationSucceeded = $null
    ProcessClosed = $false
    OutputDrained = $false
    Process = $null
    StdOutCapture = $null
    StdErrCapture = $null
    StdOutTask = $null
    StdErrTask = $null
  }
  try {
    $startInfo = New-NativePairStartInfo $FilePath $Arguments $EnvironmentOverrides
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw [InvalidOperationException]::new('The fixed local pair client did not start.') }
    $record.Process = $process
    $record.StartedAtUtc = [DateTime]::UtcNow.ToString('o')
    $record.StdOutCapture = [Amuhon.NativePairBoundedCapture]::new(8192)
    $record.StdErrCapture = [Amuhon.NativePairBoundedCapture]::new(8192)
    $record.StdOutTask = $record.StdOutCapture.Start($process.StandardOutput)
    $record.StdErrTask = $record.StdErrCapture.Start($process.StandardError)
    Write-NativeSecurePasswordToProcess $process $Password
    $record.PasswordSentAtUtc = [DateTime]::UtcNow.ToString('o')
    return $record
  } catch {
    if ($null -ne $process) {
      [void](Stop-NativePairProcess $process)
      $process.Dispose()
    }
    throw
  }
}

function Complete-NativePairObservedProcess([object]$Record) {
  if ($null -eq $Record -or $null -eq $Record.Process) { return }
  if ($null -ne $Record.EndedAtUtc) { return }
  $Record.Process.Refresh()
  if (-not $Record.Process.HasExited) { return }
  $Record.EndedAtUtc = [DateTime]::UtcNow.ToString('o')
  $Record.ExitCode = [int]$Record.Process.ExitCode
  $Record.ProcessClosed = [bool]$Record.Process.HasExited
  $Record.Process.WaitForExit()
  $stdoutDrained = $Record.StdOutTask.Wait(5000)
  $stderrDrained = $Record.StdErrTask.Wait(5000)
  $Record.OutputDrained = [bool]($stdoutDrained -and $stderrDrained)
}

function Get-NativePairProcessDiagnostic([object]$Record) {
  if ($null -eq $Record) { return $null }
  $stdout = if ($null -ne $Record.StdOutCapture) { $Record.StdOutCapture.Snapshot() } else { '' }
  $stderr = if ($null -ne $Record.StdErrCapture) { $Record.StdErrCapture.Snapshot() } else { '' }
  $combined = $stderr + "`n" + $stdout
  $sqlState = $null
  $lineNumber = $null
  $context = $null
  $stateMatch = [regex]::Match($combined, '(?im)^\s*SQL state:\s*([0-9A-Z]{5})\s*$')
  if ($stateMatch.Success) { $sqlState = $stateMatch.Groups[1].Value.ToUpperInvariant() }
  $lineMatch = [regex]::Match($combined, '(?im)^\s*psql:.*:(\d+):\s*(?:ERROR|FATAL):')
  if ($lineMatch.Success) { $lineNumber = [int]$lineMatch.Groups[1].Value }
  $contextMatch = [regex]::Match($combined, '(?im)^\s*CONTEXT:\s*PL/pgSQL function [A-Za-z0-9_ ]+ line (\d+) at ([A-Za-z_ ]+)\s*$')
  if ($contextMatch.Success) { $context = 'PL/pgSQL line {0} at {1}' -f $contextMatch.Groups[1].Value, $contextMatch.Groups[2].Value.Trim() }
  $lastStatus = $null
  $statusMatches = [regex]::Matches($stdout, '(?im)^\s*(BEGIN|SET|DO|COMMIT|ROLLBACK|SELECT\s+\d+|UPDATE\s+\d+)\s*$')
  if ($statusMatches.Count -gt 0) { $lastStatus = $statusMatches[$statusMatches.Count - 1].Groups[1].Value.ToUpperInvariant() }
  $expectedFinalStatus = if ($Record.Name -eq 'Hold') { 'ROLLBACK' } elseif ($Record.Name -eq 'Probe') { 'COMMIT' } else { '' }
  $holdReadyMarker = $null
  if ($Record.Name -eq 'Hold') { $holdReadyMarker = [bool]($combined -match 'PAIR_HOLDER_READY') }
  $probeStage = '未到達または観測不能'
  if ($Record.Name -eq 'Probe') {
    $probeStages = @(
      'SQL_FILE_STARTED',
      'IDENTITY_GUARD_PASSED',
      'TRANSACTION_STARTED',
      'HOLDER_DETECTED',
      'SKIP_LOCKED_VALIDATION_COMPLETED',
      'COMMIT_ACKNOWLEDGED'
    )
    $latestStageRank = -1
    foreach ($stream in @($stdout, $stderr)) {
      $stageMatches = [regex]::Matches($stream, 'PAIR_PROBE_STAGE:(SQL_FILE_STARTED|IDENTITY_GUARD_PASSED|TRANSACTION_STARTED|HOLDER_DETECTED|SKIP_LOCKED_VALIDATION_COMPLETED|COMMIT_ACKNOWLEDGED)')
      foreach ($stageMatch in $stageMatches) {
        $stageName = $stageMatch.Groups[1].Value
        $stageRank = [Array]::IndexOf($probeStages, $stageName)
        if ($stageRank -gt $latestStageRank) {
          $latestStageRank = $stageRank
          $probeStage = $stageName
        }
      }
    }
  }
  return [pscustomobject]@{
    Name = $Record.Name
    StartRequestedAtUtc = $Record.StartRequestedAtUtc
    StartedAtUtc = $Record.StartedAtUtc
    PasswordSentAtUtc = $Record.PasswordSentAtUtc
    EndedAtUtc = $Record.EndedAtUtc
    ExitCode = $Record.ExitCode
    WasRunningAtTimeout = [bool]$Record.WasRunningAtTimeout
    TerminationAttempted = [bool]$Record.TerminationAttempted
    TerminationSucceeded = $Record.TerminationSucceeded
    ProcessClosed = [bool]$Record.ProcessClosed
    OutputDrained = [bool]$Record.OutputDrained
    StdOutCharacters = if ($null -ne $Record.StdOutCapture) { [long]$Record.StdOutCapture.TotalCharacters } else { 0L }
    StdErrCharacters = if ($null -ne $Record.StdErrCapture) { [long]$Record.StdErrCapture.TotalCharacters } else { 0L }
    StdOutTailCharacters = if ($null -ne $Record.StdOutCapture) { [int]$Record.StdOutCapture.Snapshot().Length } else { 0 }
    StdErrTailCharacters = if ($null -ne $Record.StdErrCapture) { [int]$Record.StdErrCapture.Snapshot().Length } else { 0 }
    StdOutTruncated = if ($null -ne $Record.StdOutCapture) { [bool]$Record.StdOutCapture.Truncated } else { $false }
    StdErrTruncated = if ($null -ne $Record.StdErrCapture) { [bool]$Record.StdErrCapture.Truncated } else { $false }
    LastCompletedPsqlStatus = $lastStatus
    SqlState = $sqlState
    PsqlScriptLine = $lineNumber
    PlpgsqlContext = $context
    HoldReadyNoticeSeen = $holdReadyMarker
    ProbeStage = $probeStage
    # A forced client exit does not prove the PostgreSQL backend has completed rollback.
    DatabaseTransactionEndConfirmed = [bool]($Record.ProcessClosed -and $Record.ExitCode -eq 0 -and
      -not $Record.WasRunningAtTimeout -and $lastStatus -ceq $expectedFinalStatus)
  }
}

function Invoke-NativePairProcesses(
  [string]$PsqlPath,
  [string[]]$HoldArguments,
  [System.Collections.IDictionary]$HoldEnvironment,
  [string[]]$ProbeArguments,
  [System.Collections.IDictionary]$ProbeEnvironment,
  [Security.SecureString]$Password,
  [int]$TimeoutSeconds = 180
) {
  if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 180) {
    throw [ArgumentOutOfRangeException]::new('TimeoutSeconds', 'The pair timeout must be between 1 and 180 seconds.')
  }
  $hold = $null
  $probe = $null
  $timedOut = $false
  $timedOutProcesses = @()
  $started = [Diagnostics.Stopwatch]::StartNew()
  try {
    $hold = Start-NativePairObservedProcess 'Hold' $PsqlPath $HoldArguments $HoldEnvironment $Password
    $probe = Start-NativePairObservedProcess 'Probe' $PsqlPath $ProbeArguments $ProbeEnvironment $Password

    while ($true) {
      $hold.Process.Refresh()
      $probe.Process.Refresh()
      Complete-NativePairObservedProcess $hold
      Complete-NativePairObservedProcess $probe
      if ($null -ne $hold.ExitCode -and $hold.ExitCode -ne 0 -and -not $probe.Process.HasExited) {
        $probe.TerminationAttempted = $true
        $probe.TerminationSucceeded = [bool](Stop-NativePairProcess $probe.Process)
        Complete-NativePairObservedProcess $probe
      }
      if ($null -ne $probe.ExitCode -and $probe.ExitCode -ne 0 -and -not $hold.Process.HasExited) {
        $hold.TerminationAttempted = $true
        $hold.TerminationSucceeded = [bool](Stop-NativePairProcess $hold.Process)
        Complete-NativePairObservedProcess $hold
      }
      if ($hold.Process.HasExited -and $probe.Process.HasExited) {
        break
      }
      if ($started.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
        $timedOut = $true
        if (-not $hold.Process.HasExited) { $hold.WasRunningAtTimeout = $true; $timedOutProcesses += 'Hold' }
        if (-not $probe.Process.HasExited) { $probe.WasRunningAtTimeout = $true; $timedOutProcesses += 'Probe' }
        foreach ($record in @($hold, $probe)) {
          if (-not $record.Process.HasExited) {
            $record.TerminationAttempted = $true
            $record.TerminationSucceeded = [bool](Stop-NativePairProcess $record.Process)
            Complete-NativePairObservedProcess $record
          }
        }
        break
      }
      Start-Sleep -Milliseconds 50
    }
  } finally {
    foreach ($record in @($hold, $probe)) {
      if ($null -eq $record) { continue }
      if (-not $record.Process.HasExited) {
        $record.TerminationAttempted = $true
        $record.TerminationSucceeded = [bool](Stop-NativePairProcess $record.Process)
      }
      Complete-NativePairObservedProcess $record
    }
    $holdClosed = ($null -eq $hold -or $hold.ProcessClosed)
    $probeClosed = ($null -eq $probe -or $probe.ProcessClosed)
    $unclosedNames = @()
    if (-not $holdClosed) { $unclosedNames += 'Hold' }
    if (-not $probeClosed) { $unclosedNames += 'Probe' }
    if ($null -ne $hold) { $hold.Process.Dispose() }
    if ($null -ne $probe) { $probe.Process.Dispose() }
    if (-not $holdClosed -or -not $probeClosed) {
      throw [InvalidOperationException]::new(('Paired local client process closure was not confirmed for: {0}; inspect guarded Status before any retry.' -f ($unclosedNames -join ', ')))
    }
  }
  $holdDiagnostic = Get-NativePairProcessDiagnostic $hold
  $probeDiagnostic = Get-NativePairProcessDiagnostic $probe
  return [pscustomobject]@{
    HoldExitCode = if ($null -ne $hold) { $hold.ExitCode } else { $null }
    ProbeExitCode = if ($null -ne $probe) { $probe.ExitCode } else { $null }
    Hold = $holdDiagnostic
    Probe = $probeDiagnostic
    TimedOut = $timedOut
    TimedOutProcesses = @($timedOutProcesses)
    ProcessesClosed = [bool]((($null -eq $hold) -or $hold.ProcessClosed) -and (($null -eq $probe) -or $probe.ProcessClosed))
    DatabaseTransactionsConfirmed = [bool]($holdDiagnostic.DatabaseTransactionEndConfirmed -and $probeDiagnostic.DatabaseTransactionEndConfirmed)
  }
}

function New-NativePairReadOnlyProcess([string]$Name, [string]$PsqlPath, [string[]]$Arguments, [System.Collections.IDictionary]$EnvironmentOverrides) {
  $startInfo = New-NativePairStartInfo $PsqlPath $Arguments $EnvironmentOverrides
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw [InvalidOperationException]::new('A fixed local read-only psql process did not start.') }
  $record = [pscustomobject]@{
    Name = $Name
    StartedAtUtc = [DateTime]::UtcNow.ToString('o')
    PasswordSentAtUtc = $null
    EndedAtUtc = $null
    ExitCode = $null
    ProcessClosed = $false
    OutputDrained = $false
    TerminationAttempted = $false
    TerminationSucceeded = $null
    StdOutCapture = [Amuhon.NativePairBoundedCapture]::new(8192)
    StdErrCapture = [Amuhon.NativePairBoundedCapture]::new(8192)
    StdOutTask = $null
    StdErrTask = $null
    InputTask = $null
    Process = $process
  }
  try {
    $record.StdOutTask = $record.StdOutCapture.Start($process.StandardOutput)
    $record.StdErrTask = $record.StdErrCapture.Start($process.StandardError)
    return $record
  } catch {
    [void](Stop-NativePairProcess $process)
    $process.Dispose()
    throw [InvalidOperationException]::new('A fixed local psql output reader could not be started.')
  }
}

function Complete-NativePairReadOnlyProcess([object]$Record) {
  if ($null -eq $Record -or $null -eq $Record.Process -or $null -ne $Record.EndedAtUtc) { return }
  $Record.Process.Refresh()
  if (-not $Record.Process.HasExited) { return }
  $Record.EndedAtUtc = [DateTime]::UtcNow.ToString('o')
  $Record.ExitCode = [int]$Record.Process.ExitCode
  $Record.ProcessClosed = [bool]$Record.Process.HasExited
  $stdoutDrained = $Record.StdOutTask.Wait(5000)
  $stderrDrained = $Record.StdErrTask.Wait(5000)
  $Record.OutputDrained = [bool]($stdoutDrained -and $stderrDrained)
}

function Get-NativePairReadOnlyProcessResult([object]$Record) {
  if ($null -eq $Record) { return $null }
  $stdout = $Record.StdOutCapture.Snapshot()
  $stderr = $Record.StdErrCapture.Snapshot()
  $identityResult = 'UNEXPECTED_OUTPUT'
  if (-not $Record.StdOutCapture.Truncated -and $Record.StdOutCapture.TotalCharacters -le 8192) {
    if ([regex]::IsMatch($stdout, '\APASS(?:\r?\n)?\z')) { $identityResult = 'PASS' }
    elseif ([regex]::IsMatch($stdout, '\AFAIL(?:\r?\n)?\z')) { $identityResult = 'FAIL' }
    elseif ($Record.StdOutCapture.TotalCharacters -eq 0) { $identityResult = 'NO_OUTPUT' }
  }
  return [pscustomobject]@{
    Name = $Record.Name
    StartedAtUtc = $Record.StartedAtUtc
    PasswordSentAtUtc = $Record.PasswordSentAtUtc
    EndedAtUtc = $Record.EndedAtUtc
    ExitCode = $Record.ExitCode
    ProcessClosed = [bool]$Record.ProcessClosed
    OutputDrained = [bool]$Record.OutputDrained
    TerminationAttempted = [bool]$Record.TerminationAttempted
    TerminationSucceeded = $Record.TerminationSucceeded
    StdOutCharacters = [long]$Record.StdOutCapture.TotalCharacters
    StdErrCharacters = [long]$Record.StdErrCapture.TotalCharacters
    StdOutTruncated = [bool]$Record.StdOutCapture.Truncated
    StdErrTruncated = [bool]$Record.StdErrCapture.Truncated
    IdentityResult = $identityResult
    Passed = [bool]($Record.ProcessClosed -and $Record.OutputDrained -and $Record.ExitCode -eq 0 -and
      $identityResult -ceq 'PASS' -and -not $Record.StdOutCapture.Truncated -and -not $Record.StdErrCapture.Truncated)
  }
}

function Invoke-NativePairReadOnlyIdentityChecks(
  [string]$PsqlPath,
  [string[]]$FirstArguments,
  [System.Collections.IDictionary]$FirstEnvironment,
  [string[]]$SecondArguments,
  [System.Collections.IDictionary]$SecondEnvironment,
  [Security.SecureString]$Password,
  [int]$TimeoutSeconds = 30
) {
  if ($TimeoutSeconds -lt 5 -or $TimeoutSeconds -gt 60) {
    throw [ArgumentOutOfRangeException]::new('TimeoutSeconds', 'The read-only pair timeout must be between 5 and 60 seconds.')
  }
  if ($null -eq $Password -or $Password.Length -eq 0) { throw [ArgumentException]::new('A non-empty in-memory password is required.') }
  $first = $null
  $second = $null
  $timedOut = $false
  $startupOrInputFailure = $false
  $childFailure = $false
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  try {
    $first = New-NativePairReadOnlyProcess 'First' $PsqlPath $FirstArguments $FirstEnvironment
    $second = New-NativePairReadOnlyProcess 'Second' $PsqlPath $SecondArguments $SecondEnvironment
    $first.InputTask = [Amuhon.NativePairSecureInput]::WriteAndCloseAsync($first.Process, $Password)
    $second.InputTask = [Amuhon.NativePairSecureInput]::WriteAndCloseAsync($second.Process, $Password)

    while ($true) {
      foreach ($record in @($first, $second)) {
        Complete-NativePairReadOnlyProcess $record
        if ($null -ne $record.InputTask -and $record.InputTask.IsFaulted) { $startupOrInputFailure = $true }
        if ($null -eq $record.PasswordSentAtUtc -and $null -ne $record.InputTask -and $record.InputTask.IsCompleted -and
            -not $record.InputTask.IsFaulted -and -not $record.InputTask.IsCanceled) {
          $record.PasswordSentAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        if ($record.Process.HasExited) {
          $completedResult = Get-NativePairReadOnlyProcessResult $record
          if (-not $completedResult.Passed) { $childFailure = $true }
        }
      }
      if ($startupOrInputFailure -or $childFailure) { break }
      if ($first.Process.HasExited -and $second.Process.HasExited -and $first.InputTask.IsCompleted -and $second.InputTask.IsCompleted) { break }
      if ($deadline.Elapsed.TotalSeconds -ge $TimeoutSeconds) { $timedOut = $true; break }
      Start-Sleep -Milliseconds 25
    }
  } catch {
    $startupOrInputFailure = $true
  } finally {
    foreach ($record in @($first, $second)) {
      if ($null -eq $record) { continue }
      try {
        $record.Process.Refresh()
        if (-not $record.Process.HasExited) {
          $record.TerminationAttempted = $true
          $record.TerminationSucceeded = [bool](Stop-NativePairProcess $record.Process)
        }
        Complete-NativePairReadOnlyProcess $record
        if ($null -ne $record.InputTask -and -not $record.InputTask.IsCompleted) { [void]$record.InputTask.Wait(5000) }
        if ($null -ne $record.InputTask -and $null -eq $record.PasswordSentAtUtc -and $record.InputTask.IsCompleted -and
            -not $record.InputTask.IsFaulted -and -not $record.InputTask.IsCanceled) {
          $record.PasswordSentAtUtc = [DateTime]::UtcNow.ToString('o')
        }
      } catch { $startupOrInputFailure = $true }
    }
    foreach ($record in @($first, $second)) {
      if ($null -ne $record -and $null -ne $record.Process) { $record.Process.Dispose() }
    }
  }
  $firstResult = Get-NativePairReadOnlyProcessResult $first
  $secondResult = Get-NativePairReadOnlyProcessResult $second
  $closed = [bool]((($null -eq $firstResult) -or $firstResult.ProcessClosed) -and (($null -eq $secondResult) -or $secondResult.ProcessClosed))
  $inputSent = [bool]($null -ne $firstResult -and $null -ne $secondResult -and
    -not [string]::IsNullOrWhiteSpace($firstResult.PasswordSentAtUtc) -and -not [string]::IsNullOrWhiteSpace($secondResult.PasswordSentAtUtc))
  return [pscustomobject]@{
    First = $firstResult
    Second = $secondResult
    TimedOut = $timedOut
    StartupOrInputFailure = $startupOrInputFailure
    ChildFailure = $childFailure
    ProcessesClosed = $closed
    PasswordsSent = $inputSent
    Passed = [bool](-not $timedOut -and -not $startupOrInputFailure -and -not $childFailure -and $closed -and $inputSent -and
      $null -ne $firstResult -and $null -ne $secondResult -and $firstResult.Passed -and $secondResult.Passed)
  }
}

Export-ModuleMember -Function ConvertTo-NativeWindowsArgument, New-NativePairStartInfo,
  Start-NativePairProcess, Stop-NativePairProcess, Invoke-NativePairProcesses,
  Invoke-NativePairAuthProbe, Get-NativePairProcessDiagnostic, Invoke-NativePairReadOnlyIdentityChecks
