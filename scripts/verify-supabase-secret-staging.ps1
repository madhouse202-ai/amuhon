[CmdletBinding()]
param(
    [switch]$SelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:ExpectedProjectRef = 'ahxnmkuvdpzctcwcyadl'
$script:ExpectedHost = $script:ExpectedProjectRef + '.supabase.co'
$script:ApiRootUri = 'https://' + $script:ExpectedHost + '/rest/v1/'
$script:CheckoutStatusRpcUri = $script:ApiRootUri + 'rpc/get_amuhon_order_checkout_status'
$script:InvalidCheckoutStatusArgs = '{"p_order_id":null,"p_upload_token_hash":"invalid"}'
$script:RequestTimeoutMilliseconds = 15000

function ConvertFrom-SafeDotEnvScalar {
    param([Parameter(Mandatory = $true)][string]$RawValue)

    $value = $RawValue.Trim()
    if ($value.Length -eq 0) { throw 'env_value_invalid' }

    if ($value[0] -eq '"' -or $value[0] -eq "'") {
        $quote = $value[0]
        if ($value.Length -lt 2 -or $value[$value.Length - 1] -ne $quote) {
            throw 'env_value_invalid'
        }
        $value = $value.Substring(1, $value.Length - 2)
    }
    else {
        # Inline comments are accepted only when separated from the value.
        $commentIndex = $value.IndexOf(' #', [StringComparison]::Ordinal)
        if ($commentIndex -ge 0) { $value = $value.Substring(0, $commentIndex).TrimEnd() }
    }

    # This checker requires literal values so it never evaluates shell or dotenv expressions.
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\r\n]' -or $value -match '\$') {
        throw 'env_value_invalid'
    }
    return $value
}

function Read-SupabaseProbeSettings {
    param([Parameter(Mandatory = $true)][string]$Text)

    $settings = @{}
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*(?:#|$)') { continue }
        if ($line -notmatch '^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=(?<value>.*)$') { continue }

        $name = $Matches['name']
        if ($name -ne 'SUPABASE_URL' -and $name -ne 'SUPABASE_SECRET_KEY') { continue }
        if ($settings.ContainsKey($name)) { throw 'env_duplicate_setting' }
        $settings[$name] = ConvertFrom-SafeDotEnvScalar -RawValue $Matches['value']
    }

    if (-not $settings.ContainsKey('SUPABASE_URL')) { throw 'env_url_missing' }
    if (-not $settings.ContainsKey('SUPABASE_SECRET_KEY')) { throw 'env_secret_missing' }
    if (-not (Test-SupabaseSecretKeyFormat -Value $settings['SUPABASE_SECRET_KEY'])) {
        throw 'env_secret_invalid'
    }
    return ,$settings
}

function Test-SupabaseSecretKeyFormat {
    param([Parameter(Mandatory = $true)][string]$Value)

    return $Value -eq $Value.Trim() -and
        $Value.StartsWith('sb_secret_', [StringComparison]::Ordinal) -and
        $Value -match '^sb_secret_[A-Za-z0-9_-]+$'
}

function Test-ExpectedStagingUrl {
    param([Parameter(Mandatory = $true)][string]$Value)

    $parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed)) { return $false }
    if (-not [string]::Equals($parsed.Scheme, 'https', [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not [string]::Equals($parsed.DnsSafeHost, $script:ExpectedHost, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ($parsed.Port -ne 443 -or -not [string]::IsNullOrEmpty($parsed.UserInfo)) { return $false }
    if (-not [string]::IsNullOrEmpty($parsed.Query) -or -not [string]::IsNullOrEmpty($parsed.Fragment)) { return $false }
    return $parsed.AbsolutePath -eq '/'
}

function Get-RepositoryRootFromScript {
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Get-HttpFailureCategory {
    param([int]$StatusCode, [ValidateSet('api_root', 'checkout_status_rpc')][string]$Stage)

    if ($StatusCode -ge 300 -and $StatusCode -lt 400) { return 'redirect_refused' }
    if ($StatusCode -eq 401) {
        if ($Stage -eq 'api_root') { return 'api_authentication_rejected' }
        return 'rpc_authentication_denied_after_root_pass'
    }
    if ($StatusCode -eq 403) {
        if ($Stage -eq 'api_root') { return 'api_root_access_denied_ambiguous' }
        return 'rpc_execute_or_role_denied_after_root_pass'
    }
    if ($StatusCode -eq 404) {
        if ($Stage -eq 'api_root') { return 'api_root_unavailable' }
        return 'fixed_read_only_rpc_unavailable'
    }
    if ($StatusCode -eq 429) { return 'rate_limited' }
    if ($StatusCode -ge 500) { return 'supabase_service_error' }
    return 'http_error'
}

function Invoke-ReadOnlyStagingRequest {
    param(
        [Parameter(Mandatory = $true)][string]$ApiKey,
        [Parameter(Mandatory = $true)][ValidateSet('api_root', 'checkout_status_rpc')][string]$Stage
    )

    $request = $null
    $response = $null
    $requestStream = $null
    try {
        $requestUri = if ($Stage -eq 'api_root') { $script:ApiRootUri } else { $script:CheckoutStatusRpcUri }
        $request = [System.Net.HttpWebRequest]::Create($requestUri)
        $request.Method = if ($Stage -eq 'api_root') { 'GET' } else { 'POST' }
        $request.AllowAutoRedirect = $false
        $request.Proxy = $null
        $request.Credentials = $null
        $request.PreAuthenticate = $false
        $request.Timeout = $script:RequestTimeoutMilliseconds
        $request.ReadWriteTimeout = $script:RequestTimeoutMilliseconds
        $request.Accept = if ($Stage -eq 'api_root') { 'application/openapi+json' } else { 'application/json' }
        Set-ProbeAuthenticationHeaders -Request $request -ApiKey $ApiKey

        if ($Stage -eq 'checkout_status_rpc') {
            $request.ContentType = 'application/json'
            $requestBody = [Text.Encoding]::UTF8.GetBytes($script:InvalidCheckoutStatusArgs)
            $request.ContentLength = $requestBody.Length
            $requestStream = $request.GetRequestStream()
            $requestStream.Write($requestBody, 0, $requestBody.Length)
            $requestStream.Close()
            $requestStream = $null
        }

        $response = [System.Net.HttpWebResponse]$request.GetResponse()
        $status = [int]$response.StatusCode
        return Get-ProbeHttpOutcome -StatusCode $status -Stage $Stage
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Response -is [System.Net.HttpWebResponse]) {
            $response = [System.Net.HttpWebResponse]$_.Exception.Response
            $status = [int]$response.StatusCode
            if ($Stage -eq 'checkout_status_rpc' -and $status -eq 400) {
                if (Test-ExpectedCheckoutGuardResponse -Response $response) {
                    return @{ Passed = $true; Status = $status; Category = 'invalid_token_guard_executed_before_order_lookup' }
                }
                return @{ Passed = $false; Status = $status; Category = 'rpc_rejection_unverified' }
            }
            return Get-ProbeHttpOutcome -StatusCode $status -Stage $Stage
        }

        $category = 'transport_error'
        if ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::Timeout) { $category = 'timeout' }
        elseif ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::NameResolutionFailure) { $category = 'dns_error' }
        elseif ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::TrustFailure -or
                $_.Exception.Status -eq [System.Net.WebExceptionStatus]::SecureChannelFailure) { $category = 'tls_error' }
        return @{ Passed = $false; Status = $null; Category = $category }
    }
    catch {
        return @{ Passed = $false; Status = $null; Category = 'transport_error' }
    }
    finally {
        if ($null -ne $requestStream) { $requestStream.Close() }
        if ($null -ne $response) { $response.Close() }
    }
}

function Test-ExpectedCheckoutGuardResponse {
    param([Parameter(Mandatory = $true)][System.Net.HttpWebResponse]$Response)

    $stream = $null
    $bufferStream = $null
    try {
        $stream = $Response.GetResponseStream()
        if ($null -eq $stream) { return $false }

        $bufferStream = New-Object System.IO.MemoryStream
        $buffer = New-Object byte[] 1024
        $totalBytes = 0
        while ($totalBytes -le 4096) {
            $remaining = 4097 - $totalBytes
            $readCount = $stream.Read($buffer, 0, [Math]::Min($buffer.Length, $remaining))
            if ($readCount -le 0) { break }
            $bufferStream.Write($buffer, 0, $readCount)
            $totalBytes += $readCount
        }
        if ($totalBytes -gt 4096) { return $false }

        $bodyText = [Text.Encoding]::UTF8.GetString($bufferStream.ToArray())
        return Test-ExpectedCheckoutGuardBody -Text $bodyText
    }
    catch { return $false }
    finally {
        if ($null -ne $stream) { $stream.Close() }
        if ($null -ne $bufferStream) { $bufferStream.Dispose() }
    }
}

function Test-ExpectedCheckoutGuardBody {
    param([Parameter(Mandatory = $true)][string]$Text)

    try {
        $errorInfo = ConvertFrom-Json -InputObject $Text -ErrorAction Stop
        return $errorInfo.code -eq 'P0001' -and $errorInfo.message -eq 'ORDER_NOT_AUTHORIZED'
    }
    catch { return $false }
}

function Get-ProbeHttpOutcome {
    param([int]$StatusCode, [ValidateSet('api_root', 'checkout_status_rpc')][string]$Stage)

    if ($Stage -eq 'api_root' -and $StatusCode -eq 200) {
        return @{ Passed = $true; Status = $StatusCode; Category = 'api_key_accepted' }
    }
    if ($Stage -eq 'checkout_status_rpc' -and $StatusCode -eq 400) { return @{ Passed = $false; Status = $StatusCode; Category = 'rpc_rejection_unverified' } }
    if ($Stage -eq 'checkout_status_rpc' -and $StatusCode -ge 200 -and $StatusCode -lt 300) {
        return @{ Passed = $false; Status = $StatusCode; Category = 'rpc_guard_unexpectedly_accepted' }
    }
    return @{ Passed = $false; Status = $StatusCode; Category = (Get-HttpFailureCategory -StatusCode $StatusCode -Stage $Stage) }
}

function Set-ProbeAuthenticationHeaders {
    param(
        [Parameter(Mandatory = $true)][System.Net.HttpWebRequest]$Request,
        [Parameter(Mandatory = $true)][string]$ApiKey
    )

    [void]$Request.Headers.Add('apikey', $ApiKey)
}

function Assert-SelfTest {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw ('self_test_failed:' + $Name) }
}

function Invoke-SelfTest {
    $repositoryRoot = Get-RepositoryRootFromScript
    Assert-SelfTest (Test-Path -LiteralPath (Join-Path $repositoryRoot 'package.json') -PathType Leaf) 'script_relative_repository_root'

    $validSecret = 'sb_secret_mock_only_for_local_test'
    $validText = @"
# harmless comment
SUPABASE_URL="https://$($script:ExpectedHost)"
SUPABASE_SECRET_KEY='$validSecret'
LEGACY_CREDENTIAL=must_be_ignored
"@
    $settings = Read-SupabaseProbeSettings -Text $validText
    Assert-SelfTest ($settings['SUPABASE_SECRET_KEY'] -eq $validSecret) 'literal_secret_parse'
    Assert-SelfTest (-not $settings.ContainsKey('LEGACY_CREDENTIAL')) 'legacy_setting_ignored'
    Assert-SelfTest (Test-ExpectedStagingUrl -Value $settings['SUPABASE_URL']) 'expected_project_url'
    Assert-SelfTest (-not (Test-ExpectedStagingUrl -Value 'https://other-project.supabase.co')) 'wrong_project_rejected'
    Assert-SelfTest (-not (Test-ExpectedStagingUrl -Value ('https://' + $script:ExpectedHost + '.attacker.invalid'))) 'host_suffix_rejected'
    Assert-SelfTest (-not (Test-ExpectedStagingUrl -Value ('http://' + $script:ExpectedHost))) 'http_rejected'
    Assert-SelfTest (-not (Test-ExpectedStagingUrl -Value ('https://' + $script:ExpectedHost + ':444'))) 'nonstandard_port_rejected'
    Assert-SelfTest (-not (Test-ExpectedStagingUrl -Value ('https://user@' + $script:ExpectedHost))) 'userinfo_rejected'
    Assert-SelfTest (-not (Test-ExpectedStagingUrl -Value ('https://' + $script:ExpectedHost + '/?next=other'))) 'query_rejected'
    Assert-SelfTest (-not (Test-ExpectedStagingUrl -Value ('https://' + $script:ExpectedHost + '/#other'))) 'fragment_rejected'
    Assert-SelfTest (-not (Test-SupabaseSecretKeyFormat -Value 'not_a_secret_key')) 'non_secret_key_rejected'
    Assert-SelfTest (-not (Test-SupabaseSecretKeyFormat -Value ' sb_secret_mock_only_for_local_test')) 'leading_space_rejected'
    Assert-SelfTest (-not (Test-SupabaseSecretKeyFormat -Value 'sb_secret_mock_only_for_local_test ')) 'trailing_space_rejected'
    Assert-SelfTest (-not (Test-SupabaseSecretKeyFormat -Value '"sb_secret_mock_only_for_local_test"')) 'embedded_quotes_rejected'
    $quotedWhitespaceRejected = $false
    try {
        Read-SupabaseProbeSettings -Text "SUPABASE_URL=https://$($script:ExpectedHost)`nSUPABASE_SECRET_KEY=' $validSecret '" | Out-Null
    }
    catch { $quotedWhitespaceRejected = $true }
    Assert-SelfTest $quotedWhitespaceRejected 'quoted_secret_whitespace_rejected'
    $unbalancedQuoteRejected = $false
    try {
        Read-SupabaseProbeSettings -Text "SUPABASE_URL=https://$($script:ExpectedHost)`nSUPABASE_SECRET_KEY='$validSecret" | Out-Null
    }
    catch { $unbalancedQuoteRejected = $true }
    Assert-SelfTest $unbalancedQuoteRejected 'unbalanced_quote_rejected'
    Assert-SelfTest ((Get-HttpFailureCategory -StatusCode 401 -Stage api_root) -eq 'api_authentication_rejected') 'api_401_classified'
    Assert-SelfTest ((Get-HttpFailureCategory -StatusCode 403 -Stage api_root) -eq 'api_root_access_denied_ambiguous') 'api_403_not_called_bad_key'
    Assert-SelfTest ((Get-HttpFailureCategory -StatusCode 403 -Stage checkout_status_rpc) -eq 'rpc_execute_or_role_denied_after_root_pass') 'rpc_403_separated_after_api_pass'
    Assert-SelfTest ((Get-ProbeHttpOutcome -StatusCode 200 -Stage api_root).Passed) 'api_root_200_pass'
    Assert-SelfTest ((Get-ProbeHttpOutcome -StatusCode 400 -Stage checkout_status_rpc).Category -eq 'rpc_rejection_unverified') 'rpc_http_400_requires_expected_error'
    Assert-SelfTest (Test-ExpectedCheckoutGuardBody -Text '{"code":"P0001","message":"ORDER_NOT_AUTHORIZED"}') 'expected_guard_body_only'
    Assert-SelfTest (-not (Test-ExpectedCheckoutGuardBody -Text '{"code":"P0001","message":"OTHER_ERROR"}')) 'unexpected_rpc_error_rejected'
    Assert-SelfTest (-not (Get-ProbeHttpOutcome -StatusCode 200 -Stage checkout_status_rpc).Passed) 'rpc_unexpected_success_fails'

    $secretRequest = [System.Net.HttpWebRequest]::Create($script:ApiRootUri)
    Set-ProbeAuthenticationHeaders -Request $secretRequest -ApiKey $validSecret
    Assert-SelfTest ($secretRequest.Headers['apikey'] -eq $validSecret) 'new_key_apikey_header'
    Assert-SelfTest ($null -eq $secretRequest.Headers['Authorization']) 'new_key_no_bearer_header'

    $duplicateRejected = $false
    try {
        Read-SupabaseProbeSettings -Text "SUPABASE_URL=https://$($script:ExpectedHost)`nSUPABASE_URL=https://$($script:ExpectedHost)`nSUPABASE_SECRET_KEY=$validSecret" | Out-Null
    }
    catch { $duplicateRejected = $true }
    Assert-SelfTest $duplicateRejected 'duplicate_setting_rejected'

    $expansionRejected = $false
    try {
        Read-SupabaseProbeSettings -Text "SUPABASE_URL=https://$($script:ExpectedHost)`nSUPABASE_SECRET_KEY=`$OTHER_VALUE" | Out-Null
    }
    catch { $expansionRejected = $true }
    Assert-SelfTest $expansionRejected 'variable_expansion_rejected'

    Write-Output 'PASS local new-key safety self-test (no secret file read or network request)'
}

if ($SelfTest) {
    try { Invoke-SelfTest; exit 0 }
    catch { Write-Output 'FAIL local safety self-test category=self_test_failed'; exit 1 }
}

$settings = $null
$envText = $null
$result = $null
try {
    $repositoryRoot = Get-RepositoryRootFromScript
    $envPath = Join-Path $repositoryRoot '.env.local'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        Write-Output 'FAIL HTTP n/a category=env_file_missing'
        exit 2
    }
    $envItem = Get-Item -LiteralPath $envPath -Force
    if (($envItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Write-Output 'FAIL HTTP n/a category=env_file_reparse_point_refused'
        exit 2
    }

    $envText = [IO.File]::ReadAllText($envPath)
    $settings = Read-SupabaseProbeSettings -Text $envText
    if (-not (Test-ExpectedStagingUrl -Value $settings['SUPABASE_URL'])) {
        Write-Output 'FAIL HTTP n/a category=project_ref_mismatch'
        exit 2
    }

    # The URL is fixed in the script; the configured URL is used only for the exact Ref check.
    $newRoot = Invoke-ReadOnlyStagingRequest -ApiKey $settings['SUPABASE_SECRET_KEY'] -Stage api_root
    $statusText = if ($null -eq $newRoot.Status) { 'n/a' } else { [string]$newRoot.Status }
    $outcome = if ($newRoot.Passed) { 'PASS' } else { 'FAIL' }
    Write-Output ("{0} NEW_KEY API_ROOT HTTP {1} category={2}" -f $outcome, $statusText, $newRoot.Category)
    if (-not $newRoot.Passed) { exit 1 }

    $newRpc = Invoke-ReadOnlyStagingRequest -ApiKey $settings['SUPABASE_SECRET_KEY'] -Stage checkout_status_rpc
    $statusText = if ($null -eq $newRpc.Status) { 'n/a' } else { [string]$newRpc.Status }
    $outcome = if ($newRpc.Passed) { 'PASS' } else { 'FAIL' }
    Write-Output ("{0} NEW_KEY CHECKOUT_STATUS_RPC HTTP {1} category={2}" -f $outcome, $statusText, $newRpc.Category)
    if (-not $newRpc.Passed) { exit 1 }

    exit 0
}
catch {
    # Never print exception text: file paths, input values, or transport details may be sensitive.
    Write-Output 'FAIL HTTP n/a category=configuration_or_internal_error'
    exit 2
}
finally {
    if ($null -ne $settings -and $settings.ContainsKey('SUPABASE_SECRET_KEY')) {
        $settings['SUPABASE_SECRET_KEY'] = $null
    }
    $envText = $null
    $apiResult = $null
    $newRpc = $null
    $requestBody = $null
    $result = $null
}
