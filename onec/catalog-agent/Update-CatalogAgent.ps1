# Updates the already configured agent without asking for API keys or 1C passwords.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = Join-Path $env:LOCALAPPDATA 'TEXHORU\CatalogAgent'
if (-not (Test-Path (Join-Path $dir 'catalog-config.json'))) { throw 'Сначала установите агент: настройки не найдены' }
Stop-ScheduledTask -TaskName 'TEXHORU Catalog Agent' -ErrorAction SilentlyContinue
foreach ($file in @('Run-CatalogAgent.ps1', 'Read-UT103.ps1')) {
    Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri ('https://raw.githubusercontent.com/nxdmss/TEXHORU/main/onec/catalog-agent/' + $file) -OutFile (Join-Path $dir $file)
}
$probe = 'try { $c = New-Object -ComObject V83.COMConnector; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($c); exit 0 } catch { exit 1 }'
$candidates = @(Join-Path $PSHOME 'powershell.exe')
$x86 = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
if ((Test-Path $x86) -and $x86 -ne $candidates[0]) { $candidates += $x86 }
$exe = $null
foreach ($candidate in $candidates) {
    & $candidate -NoProfile -Command $probe
    if ($LASTEXITCODE -eq 0) { $exe = $candidate; break }
}
if (-not $exe) { throw 'COMConnector 1С не зарегистрирован ни для 64-, ни для 32-разрядного PowerShell' }
$action = New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $dir 'Run-CatalogAgent.ps1') + '"')
Set-ScheduledTask -TaskName 'TEXHORU Catalog Agent' -Action $action | Out-Null
Start-ScheduledTask -TaskName 'TEXHORU Catalog Agent'
Write-Host 'Агент обновлён. Пароли и ключи не менялись.'
Write-Host ('COMConnector найден через: ' + $exe)
