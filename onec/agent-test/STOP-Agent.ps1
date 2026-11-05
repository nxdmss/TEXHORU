# Emergency pause and task removal. Does not touch 1C database.
$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:LOCALAPPDATA 'TEXHORU-1C-TEST-Agent'
$armFile = Join-Path $dataDir 'enable-price-writes.test'
if (Test-Path $armFile) { Remove-Item $armFile -Force }
Import-Module ScheduledTasks -ErrorAction SilentlyContinue
if (Get-ScheduledTask -TaskName 'TEXHORU 1C TEST Agent' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'TEXHORU 1C TEST Agent' -Confirm:$false
}
Write-Host 'TEST agent paused and task removed. 1C unchanged.' -ForegroundColor Green
