# Explicit TEST-only opt-in. Run only AFTER confirming the one-item workflow.
$ErrorActionPreference = 'Stop'
if ([Environment]::Is64BitProcess) { throw 'Use 32-bit PowerShell' }
$dataDir = Join-Path $env:LOCALAPPDATA 'TEXHORU-1C-TEST-Agent'
$config = Get-Content (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json
$id = 'c22eb931-4214-11f0-8169-74563c6454da'
if ($config.database -cne 'test' -or $config.server -cne 'localhost' -or $config.allowedOneCId -cne $id) {
    throw 'Safety stop: this agent only allows localhost/test and Xiaomi 15'
}
$epf = Join-Path $PSScriptRoot 'TEXHORU-TEST-Agent.epf'
if (!(Test-Path $epf)) { throw 'Missing TEST agent EPF' }
$logPath = Join-Path $dataDir 'agent.log'
if (!(Test-Path $logPath) -or -not ((Get-Content $logPath -Tail 80) -match 'TEST processor verified:')) {
    throw 'Run 03-Check-EPF.ps1 and confirm the current retail price first'
}
Write-Host 'ATTENTION: THIS WILL ALLOW REAL PRICE DOCUMENTS IN THE TEST 1C DATABASE.' -ForegroundColor Yellow
Write-Host 'TEST only: localhost/test, Xiaomi 15 12/512 black. Never production base.' -ForegroundColor Yellow
$answer = Read-Host 'To enable, type exactly: TEST XIAOMI 15'
if ($answer -cne 'TEST XIAOMI 15') { throw 'Not enabled. No changes made.' }
Set-Content (Join-Path $dataDir 'enable-price-writes.test') ('TEST ONLY ' + $id) -Encoding ASCII
Write-Host 'TEST price writes enabled for the ONE approved GUID. Check 1C tab after exchange.' -ForegroundColor Green
Write-Host 'To disable immediately run STOP-Agent.ps1.'
