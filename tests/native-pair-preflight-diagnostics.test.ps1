$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..\scripts\native-postgres\test-pair-connections-native.ps1'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw 'Pair connection script is missing.' }

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $scriptPath).Path, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Pair connection script has a PowerShell parse error.' }
$diagnosticFunction = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Get-SafeNativePreflightFailureMessage'
}, $true)
if ($null -eq $diagnosticFunction) { throw 'Safe preflight diagnostic function was not found.' }
Invoke-Expression $diagnosticFunction.Extent.Text

$knownException = 'Native PostgreSQL test refused: the expected PostgreSQL cluster is not running; start it manually after review.'
$knownDisplay = Get-SafeNativePreflightFailureMessage -InvocationSucceeded $false -ExceptionThrown $true -ExceptionMessage $knownException
if ($knownDisplay -cne 'the shared native preflight rejected the environment: the expected PostgreSQL cluster is not running; start it manually after review.; no paired psql process was started.') {
  throw 'A known fixed preflight rejection was not displayed as its approved reason.'
}
Write-Host 'PASS known fixed preflight refusal is displayed'

$secretMarker = 'mock-secret-token-do-not-display'
$unknownDisplay = Get-SafeNativePreflightFailureMessage -InvocationSucceeded $false -ExceptionThrown $true -ExceptionMessage ("unexpected error $secretMarker postgres://host/db PGPASSWORD=value")
if ($unknownDisplay -cne 'the shared native preflight raised an unrecognized exception; details were suppressed and no paired psql process was started.' -or
    $unknownDisplay.Contains($secretMarker) -or $unknownDisplay.Contains('postgres://') -or $unknownDisplay.Contains('PGPASSWORD')) {
  throw 'An unknown exception was not suppressed.'
}
Write-Host 'PASS unknown preflight exception details and secret-like values are suppressed'

$falseStatusDisplay = Get-SafeNativePreflightFailureMessage -InvocationSucceeded $false -ExceptionThrown $false -ExceptionMessage $null
if ($falseStatusDisplay -cne 'the shared native preflight returned a false success indicator; no paired psql process was started.') {
  throw 'A false invocation success indicator was not distinguished from an exception.'
}
$successDisplay = Get-SafeNativePreflightFailureMessage -InvocationSucceeded $true -ExceptionThrown $false -ExceptionMessage $null
if ($null -ne $successDisplay) { throw 'A successful preflight was classified as a failure.' }
Write-Host 'PASS false success indicator is distinct and success remains non-failing'

$source = Get-Content -LiteralPath $scriptPath -Raw
$preflightCall = $source.IndexOf('& $preflight -NativeRoot $rootPath -PreflightOnly', [StringComparison]::Ordinal)
$failureStop = $source.IndexOf('if ($null -ne $preflightFailureMessage) { Stop-NativePairConnections $preflightFailureMessage }', [StringComparison]::Ordinal)
$pairStart = $source.IndexOf('Invoke-NativePairReadOnlyIdentityChecks `', [StringComparison]::Ordinal)
if ($preflightCall -lt 0 -or $failureStop -le $preflightCall -or $pairStart -le $failureStop) {
  throw 'Preflight failure does not stop execution before the paired psql helper.'
}
Write-Host 'PASS preflight failures stop before either paired psql process is started'
