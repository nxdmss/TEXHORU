# One scheduler tick, up to 40 seconds of bounded work. Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mutex = New-Object Threading.Mutex -ArgumentList $false, 'Local\TEXHORU_CATALOG_AGENT'
$locked = $false; $script:connection = $null; $connector = $null
function Unprotect([string]$Value) {
    $secure = ConvertTo-SecureString $Value
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secure.Dispose() }
}
function Invoke-AgentApi([string]$Method, [string]$Path, $Body) {
    $json = $Body | ConvertTo-Json -Depth 15 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 524288) { throw 'PAYLOAD_TOO_LARGE' }
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $apiPath = '/api/integrations/1c/remote/' + $Path
    $timestamp = [string][int64](([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalSeconds)
    $nonce = [guid]::NewGuid().ToString('N')
    $sha = [Security.Cryptography.SHA256]::Create()
    $hmac = $null
    try {
        $bodyHash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
        $message = $Method.ToUpperInvariant() + "`n" + $apiPath + "`n" + $timestamp + "`n" + $nonce + "`n" + $bodyHash
        $hmac = New-Object Security.Cryptography.HMACSHA256 -ArgumentList (,[Text.Encoding]::UTF8.GetBytes($script:apiKey))
        $signature = -join ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($message)) | ForEach-Object { $_.ToString('x2') })
    } finally {
        $sha.Dispose()
        if ($hmac) { $hmac.Dispose() }
    }
    $headers = @{}
    foreach ($key in $script:headers.Keys) { $headers[$key] = $script:headers[$key] }
    $headers['x-1c-timestamp'] = $timestamp
    $headers['x-1c-nonce'] = $nonce
    $headers['x-1c-signature'] = $signature
    Invoke-RestMethod -Method $Method -Uri ('https://' + $script:config.ApiHost + $apiPath) -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 40
}
function Write-CatalogLog([string]$Code) {
    $path = Join-Path $AgentDir 'catalog-agent.log'
    if ((Test-Path $path) -and (Get-Item $path).Length -gt 1MB) { Move-Item -Force $path ($path + '.1') }
    Add-Content -LiteralPath $path -Value ((Get-Date -Format 's') + ' ' + $Code) -Encoding UTF8
}
try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { return }
    $script:config = Get-Content -LiteralPath (Join-Path $AgentDir 'catalog-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($script:config.ApiHost -notmatch '^(?=.{1,253}$)[a-zA-Z0-9]+([a-zA-Z0-9.-]*[a-zA-Z0-9])?$' -or -not $script:config.BaseId -or $script:config.AgentId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'CONFIG' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $script:apiKey = Unprotect $script:config.KeyProtected
    $script:headers = @{ 'x-1c-key' = $script:apiKey; 'x-1c-base-kind' = 'PRODUCTION'; 'x-1c-base-id' = $script:config.BaseId; 'x-1c-agent-id' = $script:config.AgentId }
    . (Join-Path $AgentDir 'Read-UT103.ps1')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $poll = Invoke-AgentApi 'POST' 'poll' @{ agentId = $script:config.AgentId; state = 'idle' }
    while ($poll.job -and $watch.Elapsed.TotalSeconds -lt 40) {
        if (-not $script:connection) {
            $stage = 'COM_CONNECT'
            $connector = New-Object -ComObject V83.COMConnector
            $script:connection = $connector.Connect((Unprotect $script:config.ConnectionProtected))
        }
        $stage = 'CATALOG_READ'
        $body = Read-RemotePage $poll.job
        $stage = 'HTTP'
        if ($null -eq $body) { $null = Invoke-AgentApi 'POST' ('jobs/' + $poll.job.id + '/finish') @{ leaseToken = $poll.job.leaseToken } }
        else { $null = Invoke-AgentApi 'POST' ('jobs/' + $poll.job.id + '/batch') $body }
        # Three calls per DELTA page stay below the shared API rate limit.
        Start-Sleep -Milliseconds 2000
        $poll = Invoke-AgentApi 'POST' 'poll' @{ agentId = $script:config.AgentId; state = 'processing' }
    }
    $null = Invoke-AgentApi 'POST' 'poll' @{ agentId = $script:config.AgentId; state = 'idle' }
    Write-CatalogLog 'OK'
} catch {
    # Never persist the COM connection string, API key or provider error text.
    if (-not $stage) { $stage = 'CONFIG' }
    $logCode = $stage
    if ($_.Exception.Message -match '^[A-Z][A-Z0-9_:-]{0,79}$') { $logCode += ':' + $_.Exception.Message }
    Write-CatalogLog $logCode
    if ($stage -in @('COM_CONNECT', 'CATALOG_READ')) {
        try { $null = Invoke-AgentApi 'POST' 'poll' @{ agentId = $script:config.AgentId; state = 'error'; error = $stage } } catch {}
    }
} finally {
    if ($script:connection) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:connection); $script:connection = $null }
    if ($connector) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($connector) }
    if ($script:headers) { $script:headers.Clear() }
    $script:apiKey = $null
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
