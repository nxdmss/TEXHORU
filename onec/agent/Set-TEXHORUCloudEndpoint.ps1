# Change only the site's HTTPS endpoint and protected API key. Never changes the 1C base or EPF.
param(
    [Parameter(Mandatory = $true)][string]$ApiHost,
    [string]$AgentDir = (Join-Path $env:LOCALAPPDATA 'TEXHORU\Agent'),
    [switch]$RunNow
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($ApiHost -notmatch '^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$') {
    throw 'ApiHost: domain only, without https://, path or port.'
}
$ConfigPath = Join-Path $AgentDir 'agent-config.json'
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Installed agent-config.json not found.' }
$mutex = New-Object System.Threading.Mutex -ArgumentList $false, 'Local\TEXHORU_TEST_1C_AGENT'
$locked = $false
$plain = $null
$pointer = [IntPtr]::Zero
try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Agent is running. Wait for its current cycle to finish and retry.' }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($config.BaseKind -ne 'TEST') { throw 'Only an installed TEST agent can be moved by this command.' }
    $health = Invoke-RestMethod -Uri ('https://' + $ApiHost + '/api/health') -TimeoutSec 20
    if (-not $health.ok -or $health.service -ne 'texhoru-api') { throw 'This endpoint is not a healthy TEXHORU server.' }
    $secret = Read-Host 'ONE_C_API_KEY from the cloud server (input hidden)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ($plain.Length -lt 24) { throw 'Invalid API key length.' }
    $headers = @{ 'x-1c-key' = $plain }
    $null = Invoke-RestMethod -Uri ('https://' + $ApiHost + '/api/integrations/1c/price-sync/pending') -Headers $headers -TimeoutSec 20
    # All validation succeeds before changing local config. No plain-text key on disk.
    $config.ApiHost = $ApiHost.ToLowerInvariant()
    $config.ApiKeyProtected = ConvertFrom-SecureString -SecureString $secret
    $temporary = $ConfigPath + '.cloud-tmp'
    $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $ConfigPath -Force
    Remove-Item -LiteralPath (Join-Path $AgentDir 'retry-state.json') -Force -ErrorAction SilentlyContinue
    $body = @{ state = 'idle'; applied = 0; failed = 0 } | ConvertTo-Json -Compress
    try { $null = Invoke-RestMethod -Method Post -Uri ('https://' + $ApiHost + '/api/integrations/1c/agent/heartbeat') -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 20 }
    catch { Write-Warning 'Endpoint saved; heartbeat failed. Check the agent log on its next cycle.' }
    Write-Host 'Cloud endpoint saved. TEST base, EPF and Windows schedule were preserved.'
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $plain = $null
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
if ($RunNow) {
    $task = Get-ScheduledTask -TaskName 'TEXHORU 1C Test Agent' -ErrorAction Stop
    if ($task.State -eq 'Disabled') { throw 'The task is disabled. Enable it deliberately before starting.' }
    Start-ScheduledTask -TaskName 'TEXHORU 1C Test Agent'
}
