# Run using Windows PowerShell matching COMConnector bitness, under the Windows account running the task.
$ErrorActionPreference = 'Stop'
function Read-Required([string]$Prompt) {
    $value = (Read-Host $Prompt).Trim()
    if (-not $value) { throw 'Значение не заполнено' }
    return $value
}
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$dir = Join-Path $env:LOCALAPPDATA 'TEXHORU\CatalogAgent'
$hostName = Read-Required 'Домен сайта без https:// (например texhopy.com)'
if ($hostName -notmatch '^(?=.{1,253}$)[a-zA-Z0-9]+([a-zA-Z0-9.-]*[a-zA-Z0-9])?$') { throw 'Нужен только домен' }
$baseId = Read-Required 'Идентификатор базы, как ONE_C_PRODUCTION_BASE_ID на сервере'
$key = Read-Host 'ONE_C_API_KEY (ввод скрыт)' -AsSecureString
Write-Host 'Строка подключения: File="C:\путь\к\базе";Usr="ОбменСайта";Pwd="пароль";'
Write-Host 'Для серверной базы: Srvr="сервер";Ref="имя_базы";Usr="ОбменСайта";Pwd="пароль";'
$connection = Read-Host 'Строка подключения к 1С (ввод скрыт)' -AsSecureString
$retail = Read-Host 'Розничный тип цен [Розничная]'; if (-not $retail) { $retail = 'Розничная' }
$purchase = Read-Host 'Закупочный тип цен [Закупочная]'; if (-not $purchase) { $purchase = 'Закупочная' }
$null = New-Item -ItemType Directory -Path $dir -Force
# Only this Windows user and SYSTEM can read DPAPI-protected settings.
$acl = New-Object Security.AccessControl.DirectorySecurity
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($sid, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -LiteralPath $dir -AclObject $acl
foreach ($file in @('Run-CatalogAgent.ps1', 'Read-UT103.ps1')) {
    $from = Join-Path $source $file; $to = Join-Path $dir $file
    if ([IO.Path]::GetFullPath($from) -ne [IO.Path]::GetFullPath($to)) { Copy-Item -LiteralPath $from -Destination $to -Force }
}
$configPath = Join-Path $dir 'catalog-config.json'
$agentId = [guid]::NewGuid().ToString()
if (Test-Path $configPath) { $agentId = (Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).AgentId }
@{ ApiHost = $hostName; BaseId = $baseId; AgentId = $agentId; KeyProtected = (ConvertFrom-SecureString $key); ConnectionProtected = (ConvertFrom-SecureString $connection); RetailPriceName = $retail; PurchasePriceName = $purchase } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
$key.Dispose(); $connection.Dispose()
$exe = Join-Path $PSHOME 'powershell.exe'
# 1C 8.3 installations are often 32-bit even on 64-bit Windows Server. Pick
# the PowerShell process that can actually create the registered COMConnector.
$probe = 'try { $c = New-Object -ComObject V83.COMConnector; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($c); exit 0 } catch { exit 1 }'
$candidates = @($exe)
$x86 = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
if ((Test-Path $x86) -and $x86 -ne $exe) { $candidates += $x86 }
$exe = $null
foreach ($candidate in $candidates) {
    & $candidate -NoProfile -Command $probe
    if ($LASTEXITCODE -eq 0) { $exe = $candidate; break }
}
if (-not $exe) { throw 'COMConnector 1С не зарегистрирован ни для 64-, ни для 32-разрядного PowerShell' }
$action = New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $dir 'Run-CatalogAgent.ps1') + '"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(15) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable
Register-ScheduledTask -TaskName 'TEXHORU Catalog Agent' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'TEXHORU Catalog Agent'
Write-Host 'Готово. Открой на сайте Управление → Обмен с 1С. Компьютер должен быть включён, пользователь Windows — в системе.'
Write-Host ('Агент использует: ' + $exe)
Write-Host ('Журнал без паролей: ' + (Join-Path $dir 'catalog-agent.log'))
