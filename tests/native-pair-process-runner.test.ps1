$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $PSScriptRoot '..\scripts\native-postgres\native-pair-process-runner.psm1'
if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) { throw 'Pair process runner module is missing.' }
Import-Module -Name $modulePath -Force -ErrorAction Stop

$mockExecutable = Join-Path ([IO.Path]::GetTempPath()) ('amuhon-native-pair-' + [Guid]::NewGuid().ToString('N') + '.exe')
$source = @'
using System;
using System.Threading;
public static class AmuhonNativePairProcessProbe {
    public static int Main(string[] args) {
        int code, delay, stderrCharacters = 0, inputDelay = 0, stdoutCharacters = 0;
        if ((args.Length < 3 || args.Length > 7) || !Int32.TryParse(args[1], out code) || !Int32.TryParse(args[2], out delay)) return 97;
        if (args.Length >= 4 && !Int32.TryParse(args[3], out stderrCharacters)) return 97;
        if (args.Length >= 6 && !Int32.TryParse(args[5], out inputDelay)) return 97;
        if (args.Length >= 7 && !Int32.TryParse(args[6], out stdoutCharacters)) return 97;
        if (inputDelay > 0) Thread.Sleep(inputDelay);
        string input = Console.In.ReadLine();
        if (input != "pair-mock-only") return 98;
        if (!String.IsNullOrEmpty(args[0])) {
            string[] outputItems = args[0].Split('|');
            foreach (string item in outputItems) {
                if (item.StartsWith("OUT:", StringComparison.Ordinal)) Console.WriteLine(item.Substring(4));
                else if (item.StartsWith("ERR:", StringComparison.Ordinal)) Console.Error.WriteLine(item.Substring(4));
                else Console.WriteLine(item);
            }
        }
        while (stdoutCharacters > 0) {
            int count = Math.Min(stdoutCharacters, 4096);
            Console.Out.Write(new string('O', count));
            stdoutCharacters -= count;
        }
        while (stderrCharacters > 0) {
            int count = Math.Min(stderrCharacters, 4096);
            Console.Error.Write(new string('E', count));
            stderrCharacters -= count;
        }
        if (args.Length == 5 && args[4] == "diagnostic") {
            Console.Error.WriteLine("psql:pair-probe.sql:42: ERROR: mocked lock failure");
            Console.Error.WriteLine("SQL state: 55P03");
            Console.Error.WriteLine("CONTEXT: PL/pgSQL function inline_code_block line 9 at RAISE");
        }
        if (delay > 0) Thread.Sleep(delay);
        return code;
    }
}
'@
$mockPassword = ConvertTo-SecureString 'pair-mock-only' -AsPlainText -Force
$oldPgHostAddr = [Environment]::GetEnvironmentVariable('PGHOSTADDR', 'Process')
$oldPgService = [Environment]::GetEnvironmentVariable('PGSERVICE', 'Process')

try {
  [Environment]::SetEnvironmentVariable('PGHOSTADDR', '192.0.2.123', 'Process')
  [Environment]::SetEnvironmentVariable('PGSERVICE', 'mock-only-invalid-service', 'Process')
  $safeStartInfo = New-NativePairStartInfo -FilePath 'mock-only.exe' -Arguments @('-mock-host', 'not-a-real-endpoint') -EnvironmentOverrides @{
    PGCONNECT_TIMEOUT = '5'; PGPASSFILE = 'NUL'; PGAPPNAME = 'mock-only'; PGOPTIONS = '-c statement_timeout=1000'
  }
  foreach ($forbiddenName in @('PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE')) {
    if ($safeStartInfo.EnvironmentVariables.ContainsKey($forbiddenName)) {
      throw "Inherited libpq override $forbiddenName was retained in the child environment."
    }
  }
  if ($safeStartInfo.EnvironmentVariables['PGPASSFILE'] -cne 'NUL') {
    throw 'The child process did not receive the fixed no-file password source.'
  }
  $rejectedPasswordOverride = $false
  try {
    $null = New-NativePairStartInfo -FilePath 'mock-only.exe' -Arguments @() -EnvironmentOverrides @{ PGPASSWORD = 'never-allowed' }
  } catch { $rejectedPasswordOverride = $true }
  if (-not $rejectedPasswordOverride) { throw 'A PGPASSWORD override was not rejected.' }
  Write-Host 'PASS child environment strips inherited libpq overrides and rejects PGPASSWORD'

  Add-Type -TypeDefinition $source -OutputAssembly $mockExecutable -OutputType ConsoleApplication -ErrorAction Stop | Out-Null
  foreach ($expected in @(0, 1, 2, 3)) {
    $process = Start-NativePairProcess -FilePath $mockExecutable -Arguments @('PASS', [string]$expected, '0') -EnvironmentOverrides @{} -Password $mockPassword
    try {
      if (-not $process.WaitForExit(10000)) { throw "Mock process for code $expected timed out." }
      $process.Refresh()
      if (-not $process.HasExited -or [int]$process.ExitCode -ne $expected) {
        throw "Mock process returned $($process.ExitCode); expected $expected."
      }
      Write-Host "PASS paired-process mock exit code $expected"
    } finally {
      [void](Stop-NativePairProcess $process)
      $process.Dispose()
    }
  }

  $pairOk = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('ROLLBACK', '0', '600') -HoldEnvironment @{} `
    -ProbeArguments @('COMMIT', '0', '50') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 10
  if ($pairOk.HoldExitCode -ne 0 -or $pairOk.ProbeExitCode -ne 0 -or -not $pairOk.ProcessesClosed -or $pairOk.TimedOut -or
      -not $pairOk.DatabaseTransactionsConfirmed -or $pairOk.Hold.LastCompletedPsqlStatus -cne 'ROLLBACK' -or
      $pairOk.Probe.LastCompletedPsqlStatus -cne 'COMMIT') {
    throw 'Two-process success mock did not return closed zero-exit clients with final transaction statuses.'
  }
  Write-Host 'PASS paired-process concurrent success and closure'

  $independentInput = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('OUT:HOLD_INPUT_READ', '0', '0', '0', '', '400') -HoldEnvironment @{} `
    -ProbeArguments @('OUT:PROBE_INPUT_READ', '0', '0') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 10
  foreach ($record in @($independentInput.Hold, $independentInput.Probe)) {
    if ([string]::IsNullOrWhiteSpace($record.StartedAtUtc) -or
        [string]::IsNullOrWhiteSpace($record.PasswordSentAtUtc) -or
        [string]::IsNullOrWhiteSpace($record.EndedAtUtc) -or
        $null -eq $record.ExitCode -or -not $record.OutputDrained -or -not $record.ProcessClosed) {
      throw 'Paired mock did not record complete process timing, stdin-send, exit, and output-drain diagnostics.'
    }
    if ($record.PSObject.Properties.Name -contains 'Authenticated') {
      throw 'A completed stdin write was incorrectly exposed as an authentication result.'
    }
  }
  if ($independentInput.HoldExitCode -ne 0 -or $independentInput.ProbeExitCode -ne 0 -or
      $independentInput.Hold.StdOutCharacters -le 0 -or $independentInput.Probe.StdOutCharacters -le 0) {
    throw 'Two separate child processes did not independently read their stdin passwords and finish.'
  }
  Write-Host 'PASS independent stdin pipes, delayed read, timestamps, exit codes, and output drain'

  $noOutputPair = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('', '0', '0') -HoldEnvironment @{} `
    -ProbeArguments @('', '0', '0') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 10
  if ($noOutputPair.HoldExitCode -ne 0 -or $noOutputPair.ProbeExitCode -ne 0 -or
      $noOutputPair.Hold.StdOutCharacters -ne 0 -or $noOutputPair.Hold.StdErrCharacters -ne 0 -or
      $noOutputPair.Probe.StdOutCharacters -ne 0 -or $noOutputPair.Probe.StdErrCharacters -ne 0 -or
      $noOutputPair.Probe.ProbeStage -cne '未到達または観測不能') {
    throw 'No-output child processes were not kept distinct from a marker-confirmed stage.'
  }
  Write-Host 'PASS zero-output children remain unobserved rather than implying SQL progress'

  $allProbeStages = 'PAIR_PROBE_STAGE:SQL_FILE_STARTED|PAIR_PROBE_STAGE:IDENTITY_GUARD_PASSED|PAIR_PROBE_STAGE:TRANSACTION_STARTED|PAIR_PROBE_STAGE:HOLDER_DETECTED|PAIR_PROBE_STAGE:SKIP_LOCKED_VALIDATION_COMPLETED|PAIR_PROBE_STAGE:COMMIT_ACKNOWLEDGED|COMMIT'
  $stagePair = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('PAIR_HOLDER_READY|ROLLBACK', '0', '0') -HoldEnvironment @{} `
    -ProbeArguments @($allProbeStages, '0', '0') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 10
  if ($stagePair.Probe.ProbeStage -cne 'COMMIT_ACKNOWLEDGED' -or
      -not $stagePair.Hold.HoldReadyNoticeSeen -or
      -not [object]::ReferenceEquals($null, $stagePair.Probe.HoldReadyNoticeSeen)) {
    throw 'Probe stage markers or Hold-only readiness indication were attributed incorrectly.'
  }
  Write-Host 'PASS Probe reaches the final fixed stage and holder-ready is Hold-only'

  $distributedStages = 'OUT:PAIR_PROBE_STAGE:SQL_FILE_STARTED|OUT:PAIR_PROBE_STAGE:IDENTITY_GUARD_PASSED|OUT:PAIR_PROBE_STAGE:TRANSACTION_STARTED|ERR:PAIR_PROBE_STAGE:HOLDER_DETECTED|ERR:PAIR_PROBE_STAGE:SKIP_LOCKED_VALIDATION_COMPLETED'
  $distributedStagePair = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('PAIR_HOLDER_READY|ROLLBACK', '0', '0') -HoldEnvironment @{} `
    -ProbeArguments @($distributedStages, '0', '0') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 10
  if ($distributedStagePair.Probe.ProbeStage -cne 'SKIP_LOCKED_VALIDATION_COMPLETED') {
    throw 'Probe stage selection regressed when a later marker was on stderr and earlier markers were on stdout.'
  }
  Write-Host 'PASS Probe stage uses fixed progress rank across stdout and stderr'

  $unknownStagePair = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('PAIR_HOLDER_READY|ROLLBACK', '0', '0') -HoldEnvironment @{} `
    -ProbeArguments @('OUT:PAIR_PROBE_STAGE:UNREVIEWED_STAGE|ERR:UNTRUSTED_STAGE', '0', '0') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 10
  if ($unknownStagePair.Probe.ProbeStage -cne '未到達または観測不能') {
    throw 'An unknown Probe marker was treated as an approved progress stage.'
  }
  Write-Host 'PASS unknown or missing Probe markers remain unobserved'

  $pairFailed = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('PASS', '0', '5000') -HoldEnvironment @{} `
    -ProbeArguments @('FAIL', '1', '50') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 10
  if ($pairFailed.ProbeExitCode -ne 1 -or -not $pairFailed.ProcessesClosed) {
    throw 'Nonzero probe mock was not reported with both processes closed.'
  }
  Write-Host 'PASS paired-process failure stops and closes sibling'

  $sqlFailure = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('ROLLBACK', '0', '0') -HoldEnvironment @{} `
    -ProbeArguments @('FAIL', '1', '0', '0', 'diagnostic') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 10
  if ($sqlFailure.Probe.SqlState -cne '55P03' -or $sqlFailure.Probe.PsqlScriptLine -ne 42 -or
      $sqlFailure.Probe.PlpgsqlContext -cne 'PL/pgSQL line 9 at RAISE' -or
      -not $sqlFailure.ProcessesClosed) {
    throw 'SQLSTATE and line/context diagnostics were not extracted without exposing raw stderr.'
  }
  Write-Host 'PASS SQLSTATE and bounded error-location diagnostics'

  $holdOnlyEnded = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('ROLLBACK', '0', '50') -HoldEnvironment @{} `
    -ProbeArguments @('PROBE_WAIT', '0', '5000') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 1
  if (-not $holdOnlyEnded.TimedOut -or $holdOnlyEnded.TimedOutProcesses.Count -ne 1 -or
      $holdOnlyEnded.TimedOutProcesses[0] -cne 'Probe' -or $holdOnlyEnded.Hold.ExitCode -ne 0 -or
      -not $holdOnlyEnded.Hold.DatabaseTransactionEndConfirmed -or $holdOnlyEnded.Probe.DatabaseTransactionEndConfirmed -or
      $holdOnlyEnded.Probe.ProbeStage -cne '未到達または観測不能') {
    throw 'Hold-only completion did not identify Probe as the timed-out process or report transaction confirmation safely.'
  }
  Write-Host 'PASS timeout identifies a still-running Probe after Hold completion'

  $probeOnlyEnded = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('HOLD_WAIT', '0', '5000') -HoldEnvironment @{} `
    -ProbeArguments @('COMMIT', '0', '50') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 1
  if (-not $probeOnlyEnded.TimedOut -or $probeOnlyEnded.TimedOutProcesses.Count -ne 1 -or
      $probeOnlyEnded.TimedOutProcesses[0] -cne 'Hold' -or $probeOnlyEnded.Probe.ExitCode -ne 0 -or
      -not $probeOnlyEnded.Probe.DatabaseTransactionEndConfirmed -or $probeOnlyEnded.Hold.DatabaseTransactionEndConfirmed) {
    throw 'Probe-only completion did not identify Hold as the timed-out process or report transaction confirmation safely.'
  }
  Write-Host 'PASS timeout identifies a still-running Hold after Probe completion'

  $bothTimedOut = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('HOLD_WAIT', '0', '5000') -HoldEnvironment @{} `
    -ProbeArguments @('PROBE_WAIT', '0', '5000') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 1
  if (-not $bothTimedOut.TimedOut -or $bothTimedOut.TimedOutProcesses.Count -ne 2 -or
      -not $bothTimedOut.ProcessesClosed -or $bothTimedOut.DatabaseTransactionsConfirmed) {
    throw 'Timeout of both mock clients was not identified and safely marked unconfirmed.'
  }
  Write-Host 'PASS timeout identifies both clients and leaves DB transaction outcome unconfirmed'

  $largeStderr = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('ROLLBACK', '0', '0', '250000', '', '0', '250000') -HoldEnvironment @{} `
    -ProbeArguments @('COMMIT', '0', '0', '250000', '', '0', '250000') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 10
  if (-not $largeStderr.ProcessesClosed -or -not $largeStderr.Hold.OutputDrained -or
      $largeStderr.Hold.StdErrCharacters -ne 250000 -or -not $largeStderr.Hold.StdErrTruncated -or
      $largeStderr.Hold.StdErrTailCharacters -gt 8192 -or
      -not $largeStderr.Probe.OutputDrained -or $largeStderr.Probe.StdErrCharacters -ne 250000 -or
      $largeStderr.Probe.StdOutCharacters -lt 250000 -or -not $largeStderr.Probe.StdOutTruncated -or
      $largeStderr.Probe.StdOutTailCharacters -gt 8192 -or $largeStderr.Hold.StdOutCharacters -lt 250000) {
    throw ('Concurrent stream check failed: hold(out={0},err={1},drained={2},outTail={3},errTail={4}); probe(out={5},err={6},drained={7},outTail={8},errTail={9}).' -f `
      $largeStderr.Hold.StdOutCharacters, $largeStderr.Hold.StdErrCharacters, $largeStderr.Hold.OutputDrained,
      $largeStderr.Hold.StdOutTailCharacters, $largeStderr.Hold.StdErrTailCharacters,
      $largeStderr.Probe.StdOutCharacters, $largeStderr.Probe.StdErrCharacters, $largeStderr.Probe.OutputDrained,
      $largeStderr.Probe.StdOutTailCharacters, $largeStderr.Probe.StdErrTailCharacters)
  }
  Write-Host 'PASS concurrent large stdout/stderr is drained and retained only in bounded memory'

  $pairTimedOut = Invoke-NativePairProcesses -PsqlPath $mockExecutable `
    -HoldArguments @('PASS', '0', '5000') -HoldEnvironment @{} `
    -ProbeArguments @('PASS', '0', '5000') -ProbeEnvironment @{} `
    -Password $mockPassword -TimeoutSeconds 1
  if (-not $pairTimedOut.TimedOut -or -not $pairTimedOut.ProcessesClosed) {
    throw 'Pair timeout did not terminate and confirm closure of both mock processes.'
  }
  Write-Host 'PASS paired-process timeout terminates and closes both clients'

  $readOnlyEnvironmentA = @{ PGPASSFILE = 'NUL'; PGCONNECT_TIMEOUT = '5'; PGAPPNAME = 'mock-readonly-a'; PGOPTIONS = '-c statement_timeout=1000' }
  $readOnlyEnvironmentB = @{ PGPASSFILE = 'NUL'; PGCONNECT_TIMEOUT = '5'; PGAPPNAME = 'mock-readonly-b'; PGOPTIONS = '-c statement_timeout=1000' }
  $readOnlyPass = Invoke-NativePairReadOnlyIdentityChecks -PsqlPath $mockExecutable `
    -FirstArguments @('PASS', '0', '0', '40', '', '350') -FirstEnvironment $readOnlyEnvironmentA `
    -SecondArguments @('PASS', '0', '0', '50') -SecondEnvironment $readOnlyEnvironmentB `
    -Password $mockPassword -TimeoutSeconds 10
  if (-not $readOnlyPass.Passed -or -not $readOnlyPass.PasswordsSent -or -not $readOnlyPass.ProcessesClosed -or
      $readOnlyPass.First.ExitCode -ne 0 -or $readOnlyPass.Second.ExitCode -ne 0 -or
      $readOnlyPass.First.IdentityResult -cne 'PASS' -or $readOnlyPass.Second.IdentityResult -cne 'PASS' -or
      -not $readOnlyPass.First.OutputDrained -or -not $readOnlyPass.Second.OutputDrained -or
      [string]::IsNullOrWhiteSpace($readOnlyPass.First.PasswordSentAtUtc) -or
      [string]::IsNullOrWhiteSpace($readOnlyPass.Second.PasswordSentAtUtc)) {
    throw 'Read-only two-client mock did not require independent input, exact PASS, zero exits, closed processes, and drained streams.'
  }
  $readOnlyPublicResult = $readOnlyPass | ConvertTo-Json -Depth 5 -Compress
  if ($readOnlyPublicResult.Contains('pair-mock-only') -or
      $readOnlyPass.First.PSObject.Properties.Name -contains 'StdOut' -or
      $readOnlyPass.First.PSObject.Properties.Name -contains 'StdErr') {
    throw 'Read-only process result exposed a secret or raw output stream.'
  }
  Write-Host 'PASS read-only two-client mock: independent delayed stdin, concurrent streams, exact identity result, and safe diagnostics'

  $readOnlyMarkerFail = Invoke-NativePairReadOnlyIdentityChecks -PsqlPath $mockExecutable `
    -FirstArguments @('FAIL', '0', '0') -FirstEnvironment $readOnlyEnvironmentA `
    -SecondArguments @('PASS', '0', '7000') -SecondEnvironment $readOnlyEnvironmentB `
    -Password $mockPassword -TimeoutSeconds 10
  if ($readOnlyMarkerFail.Passed -or $readOnlyMarkerFail.First.IdentityResult -cne 'FAIL' -or
      -not $readOnlyMarkerFail.ProcessesClosed -or -not $readOnlyMarkerFail.ChildFailure -or
      -not $readOnlyMarkerFail.Second.TerminationAttempted -or -not $readOnlyMarkerFail.Second.TerminationSucceeded) {
    throw 'An identity FAIL marker was accepted or did not stop and confirm closure of its peer.'
  }
  Write-Host 'PASS read-only two-client mock rejects identity FAIL'

  $readOnlyExitFail = Invoke-NativePairReadOnlyIdentityChecks -PsqlPath $mockExecutable `
    -FirstArguments @('PASS', '1', '0') -FirstEnvironment $readOnlyEnvironmentA `
    -SecondArguments @('PASS', '0', '0') -SecondEnvironment $readOnlyEnvironmentB `
    -Password $mockPassword -TimeoutSeconds 10
  if ($readOnlyExitFail.Passed -or $readOnlyExitFail.First.ExitCode -ne 1 -or
      -not $readOnlyExitFail.ProcessesClosed -or -not $readOnlyExitFail.ChildFailure) {
    throw 'A nonzero read-only child exit was accepted or did not stop its peer.'
  }
  Write-Host 'PASS read-only two-client mock rejects nonzero exit and closes peer'

  $readOnlyNoOutput = Invoke-NativePairReadOnlyIdentityChecks -PsqlPath $mockExecutable `
    -FirstArguments @('', '0', '0') -FirstEnvironment $readOnlyEnvironmentA `
    -SecondArguments @('PASS', '0', '0') -SecondEnvironment $readOnlyEnvironmentB `
    -Password $mockPassword -TimeoutSeconds 10
  if ($readOnlyNoOutput.Passed -or $readOnlyNoOutput.First.IdentityResult -cne 'NO_OUTPUT') {
    throw 'Missing identity output was accepted by the read-only two-client helper.'
  }
  Write-Host 'PASS read-only two-client mock rejects missing identity output'

  $readOnlyLargeOutput = Invoke-NativePairReadOnlyIdentityChecks -PsqlPath $mockExecutable `
    -FirstArguments @('PASS', '0', '0', '250000', '', '0', '250000') -FirstEnvironment $readOnlyEnvironmentA `
    -SecondArguments @('PASS', '0', '0', '250000', '', '0', '250000') -SecondEnvironment $readOnlyEnvironmentB `
    -Password $mockPassword -TimeoutSeconds 10
  if ($readOnlyLargeOutput.Passed -or -not $readOnlyLargeOutput.ProcessesClosed -or
      -not $readOnlyLargeOutput.First.OutputDrained -or -not $readOnlyLargeOutput.Second.OutputDrained -or
      -not $readOnlyLargeOutput.First.StdOutTruncated -or -not $readOnlyLargeOutput.First.StdErrTruncated -or
      $readOnlyLargeOutput.First.StdOutCharacters -lt 250000 -or $readOnlyLargeOutput.First.StdErrCharacters -ne 250000) {
    throw 'Large read-only child output was not fully drained, bounded, and rejected as non-exact output.'
  }
  Write-Host 'PASS read-only two-client mock drains oversized streams while bounding retained output'

  $readOnlyTimedOut = Invoke-NativePairReadOnlyIdentityChecks -PsqlPath $mockExecutable `
    -FirstArguments @('PASS', '0', '7000') -FirstEnvironment $readOnlyEnvironmentA `
    -SecondArguments @('PASS', '0', '7000') -SecondEnvironment $readOnlyEnvironmentB `
    -Password $mockPassword -TimeoutSeconds 5
  if (-not $readOnlyTimedOut.TimedOut -or $readOnlyTimedOut.Passed -or -not $readOnlyTimedOut.ProcessesClosed -or
      -not $readOnlyTimedOut.First.TerminationAttempted -or -not $readOnlyTimedOut.First.TerminationSucceeded -or
      -not $readOnlyTimedOut.Second.TerminationAttempted -or -not $readOnlyTimedOut.Second.TerminationSucceeded -or
      -not $readOnlyTimedOut.First.OutputDrained -or -not $readOnlyTimedOut.Second.OutputDrained) {
    throw 'Read-only two-client timeout did not stop and confirm closure of both children.'
  }
  Write-Host 'PASS read-only two-client timeout stops and confirms both children'

  $authPass = Invoke-NativePairAuthProbe -PsqlPath $mockExecutable -Arguments @('PASS', '0', '0') `
    -EnvironmentOverrides @{ PGPASSFILE = 'NUL'; PGAPPNAME = 'mock-only'; PGCONNECT_TIMEOUT = '5'; PGOPTIONS = '-c statement_timeout=1000' } `
    -Password $mockPassword -TimeoutSeconds 5
  if ($authPass.ExitCode -ne 0 -or $authPass.Output.Trim() -cne 'PASS') {
    throw 'Read-only auth probe mock did not require both zero exit and exact PASS output.'
  }
  Write-Host 'PASS read-only auth probe captures exact PASS and exit code'

  $authFailMarker = Invoke-NativePairAuthProbe -PsqlPath $mockExecutable -Arguments @('FAIL', '0', '0') `
    -EnvironmentOverrides @{ PGPASSFILE = 'NUL'; PGAPPNAME = 'mock-only'; PGCONNECT_TIMEOUT = '5'; PGOPTIONS = '-c statement_timeout=1000' } `
    -Password $mockPassword -TimeoutSeconds 5
  if ($authFailMarker.ExitCode -ne 0 -or $authFailMarker.Output.Trim() -cne 'FAIL') {
    throw 'Read-only auth probe mock did not preserve a non-PASS identity result.'
  }
  Write-Host 'PASS read-only auth probe reports FAIL output separately from exit code'

  $authFailureCode = Invoke-NativePairAuthProbe -PsqlPath $mockExecutable -Arguments @('PASS', '1', '0') `
    -EnvironmentOverrides @{ PGPASSFILE = 'NUL'; PGAPPNAME = 'mock-only'; PGCONNECT_TIMEOUT = '5'; PGOPTIONS = '-c statement_timeout=1000' } `
    -Password $mockPassword -TimeoutSeconds 5
  if ($authFailureCode.ExitCode -ne 1 -or $authFailureCode.Output.Trim() -cne 'PASS') {
    throw 'Read-only auth probe mock did not preserve a nonzero exit code.'
  }
  Write-Host 'PASS read-only auth probe rejects nonzero exit despite PASS output'

  $authTimedOut = $false
  try {
    $null = Invoke-NativePairAuthProbe -PsqlPath $mockExecutable -Arguments @('PASS', '0', '5000') `
      -EnvironmentOverrides @{ PGPASSFILE = 'NUL'; PGAPPNAME = 'mock-only'; PGCONNECT_TIMEOUT = '5'; PGOPTIONS = '-c statement_timeout=1000' } `
      -Password $mockPassword -TimeoutSeconds 1
  } catch [TimeoutException] { $authTimedOut = $true }
  if (-not $authTimedOut) { throw 'Read-only auth probe mock did not stop on timeout.' }
  Write-Host 'PASS read-only auth probe enforces timeout'
} finally {
  $mockPassword.Dispose()
  [Environment]::SetEnvironmentVariable('PGHOSTADDR', $oldPgHostAddr, 'Process')
  [Environment]::SetEnvironmentVariable('PGSERVICE', $oldPgService, 'Process')
  if (Test-Path -LiteralPath $mockExecutable -PathType Leaf) {
    Remove-Item -LiteralPath $mockExecutable -Force
  }
}
