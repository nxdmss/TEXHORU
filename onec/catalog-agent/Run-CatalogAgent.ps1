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
    Invoke-RestMethod -Method $Method -Uri ('https://' + $script:config.ApiHost + '/api/integrations/1c/remote/' + $Path) -Headers $script:headers -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 40
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
    if ($script:config.ApiHost -notmatch '^(?=.{1,253}$)[a-zA-Z0-9]+([a-zA-Z0-9.-]*[a-zA-Z0-9])?$' -or -not $script:config.BaseId) { throw 'CONFIG' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $script:headers = @{ 'x-1c-key' = (Unprotect $script:config.KeyProtected); 'x-1c-base-kind' = 'PRODUCTION'; 'x-1c-base-id' = $script:config.BaseId }
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
    Write-CatalogLog $stage
    if ($stage -in @('COM_CONNECT', 'CATALOG_READ')) {
        try { $null = Invoke-AgentApi 'POST' 'poll' @{ agentId = $script:config.AgentId; state = 'error'; error = $stage } } catch {}
    }
} finally {
    if ($script:connection) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:connection); $script:connection = $null }
    if ($connector) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($connector) }
    if ($script:headers) { $script:headers.Clear() }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
