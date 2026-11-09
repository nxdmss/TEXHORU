$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'onec/agent/Set-TEXHORUCloudEndpoint.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('texhoru-cloud-agent-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$configPath = Join-Path $temp 'agent-config.json'
$global:CloudTestRejectKey = $false
$global:CloudTestCalls = 0
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-RestMethod {
    param($Uri, $Headers, $TimeoutSec, $Method, $ContentType, $Body)
    $global:CloudTestCalls++
    if ($Uri.EndsWith('/health')) { return @{ ok=$true; service='texhoru-api' } }
    if ($global:CloudTestRejectKey) { throw 'Unauthorized test key' }
    return @{ ok=$true; items=@() }
}
function Read-Host {
    param($Prompt, [switch]$AsSecureString)
    return ConvertTo-SecureString 'cloud-test-only-not-a-real-key-123456789' -AsPlainText -Force
}
try {
    @{ BaseKind='TEST'; BaseLabel='TEST'; EpfPath='C:\test-agent.epf'; PlatformExe='C:\1cv8.exe';
       ApiHost='old.example.org'; ApiKeyProtected='old-protected-value' } | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    $before = Get-Content $configPath -Raw
    $failed = $false
    try { & $script -ApiHost 'https://wrong.example.org/' -AgentDir $temp } catch { $failed = $true }
    Assert $failed 'Full URL accepted as a host'
    Assert ((Get-Content $configPath -Raw) -eq $before) 'Bad host changed configuration'
    $global:CloudTestRejectKey = $true
    $failed = $false
    try { & $script -ApiHost 'cloud.example.org' -AgentDir $temp } catch { $failed = $true }
    Assert $failed 'Rejected key accepted'
    Assert ((Get-Content $configPath -Raw) -eq $before) 'Rejected key changed configuration'
    $global:CloudTestRejectKey = $false
    & $script -ApiHost 'CLOUD.example.org' -AgentDir $temp
    $after = Get-Content $configPath -Raw | ConvertFrom-Json
    Assert ($after.ApiHost -eq 'cloud.example.org') 'New host not saved'
    Assert ($after.EpfPath -eq 'C:\test-agent.epf' -and $after.PlatformExe -eq 'C:\1cv8.exe' -and $after.BaseKind -eq 'TEST') '1C parameters changed'
    Assert ($after.ApiKeyProtected -ne 'old-protected-value') 'Protected key not updated'
    Assert (-not ((Get-Content $configPath -Raw).Contains('cloud-test-only-not-a-real-key'))) 'Plain key stored in config'
    Assert ((Get-ChildItem $temp).Count -eq 1) 'Unrequested backup or temporary file left behind'
    $after.BaseKind = 'PRODUCTION'
    $after | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    $before = Get-Content $configPath -Raw
    $requests = $global:CloudTestCalls
    $failed = $false
    try { & $script -ApiHost 'other.example.org' -AgentDir $temp } catch { $failed = $true }
    Assert $failed 'Production 1C configuration was accepted'
    Assert ((Get-Content $configPath -Raw) -eq $before -and $global:CloudTestCalls -eq $requests) 'Production base was touched'
    Write-Host 'PASS: cloud endpoint validation, protected key, unchanged TEST base/EPF and refusal to alter production.'
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
