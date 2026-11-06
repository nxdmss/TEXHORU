# One-time installation of the TEXHORU agent. Run as the same Windows user that opens the TEST 1C base.
# Windows PowerShell 5.1 or newer.
$ErrorActionPreference = 'Stop'

function Read-Required([string]$Prompt) {
    do { $value = (Read-Host $Prompt).Trim() } while ([string]::IsNullOrWhiteSpace($value))
    return $value
}

function Read-PlatformPath {
    $roots = @()
    if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles '1cv8') }
    $roots += (Join-Path $env:SystemDrive 'Program Files (x86)\1cv8')
    $found = foreach ($root in $roots) {
        if (Test-Path $root) {
            Get-ChildItem -LiteralPath $root -Filter '1cv8.exe' -File -Recurse -ErrorAction SilentlyContinue
        }
    }
    $candidate = $found | Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) {
        Write-Host ('Найдена 1С: ' + $candidate.FullName) -ForegroundColor Green
        $answer = Read-Host 'Нажми Enter, чтобы использовать этот файл, или введи другой путь'
        if ([string]::IsNullOrWhiteSpace($answer)) { return $candidate.FullName }
        return $answer.Trim('" ')
    }
    return (Read-Required 'Полный путь к 1cv8.exe')
}

function Protect-Secret([Security.SecureString]$Value) {
    return ConvertFrom-SecureString -SecureString $Value
}

Write-Host ''
Write-Host 'Установка агента TEXHORU для тестовой 1С' -ForegroundColor Cyan
Write-Host 'Агент будет забирать только уже выбранные на сайте изменения.'
Write-Host 'Рабочую базу подключать запрещено.'
Write-Host ''

$baseLabel = Read-Required 'Название тестовой базы (в названии должно быть ТЕСТ, TEST, КОПИЯ или ПИЛОТ)'
if ($baseLabel -notmatch '(?i)(test|тест|копия|pilot|пилот|demo)') {
    throw 'Название не похоже на тестовую базу. Установку остановил.'
}

$confirm = Read-Host 'Если это именно КОПИЯ/ТЕСТОВАЯ база, напиши: ПОДТВЕРЖДАЮ ТЕСТ'
if ($confirm -cne 'ПОДТВЕРЖДАЮ ТЕСТ') { throw 'Подтверждение не получено. Ничего не установлено.' }

$baseMode = (Read-Required 'Тип базы: FILE (папка файловой базы) или SERVER (серверная база)').ToUpperInvariant()
if ($baseMode -eq 'FILE') {
    $basePath = (Read-Required 'Полный путь к папке тестовой базы 1С').Trim('" ')
    if (-not (Test-Path -LiteralPath $basePath -PathType Container)) { throw 'Папка базы не найдена.' }
    $serverAddress = ''
} elseif ($baseMode -eq 'SERVER') {
    $serverAddress = (Read-Required 'Адрес тестовой базы в формате сервер\имя_базы').Trim('" ')
    $basePath = ''
} else {
    throw 'Нужно выбрать FILE или SERVER.'
}

$platformExe = Read-PlatformPath
if (-not (Test-Path -LiteralPath $platformExe -PathType Leaf)) { throw 'Файл 1cv8.exe не найден.' }

$epfSource = (Read-Required 'Путь к собранному TEXHORU-Agent.epf').Trim('" ')
if (-not (Test-Path -LiteralPath $epfSource -PathType Leaf)) {
    throw 'Файл EPF не найден. Сначала программист должен один раз собрать его из модуля UT103-PilotRetailPrices-FormModule.bsl. Инструкция: onec/agent/README.md'
}

$authMode = (Read-Required 'Вход в 1С: WINDOWS (вход Windows) или ONEC (имя и пароль 1С)').ToUpperInvariant()
if ($authMode -notin @('WINDOWS', 'ONEC')) { throw 'Нужно выбрать WINDOWS или ONEC.' }
$oneCUser = ''
$oneCPasswordProtected = ''
if ($authMode -eq 'ONEC') {
    $oneCUser = Read-Required 'Имя отдельного пользователя 1С с минимальными правами для тестового обмена'
    $oneCPassword = Read-Host 'Пароль этого пользователя 1С' -AsSecureString
    if ($oneCPassword.Length -eq 0) { throw 'Пароль 1С не может быть пустым.' }
    $oneCPasswordProtected = Protect-Secret $oneCPassword
    $oneCPassword.Dispose()
}

$apiHost = Read-Required 'Адрес сайта для агента (только имя хоста, без https:// и без /api)'
if ($apiHost -match '[/:\s]' -or $apiHost -notmatch '^[A-Za-z0-9.-]+$') {
    throw 'Укажи только имя HTTPS-хоста, например example.ngrok-free.dev.'
}
$apiKey = Read-Host 'Ключ ONE_C_API_KEY именно тестового сервера' -AsSecureString
if ($apiKey.Length -lt 16) { throw 'Ключ слишком короткий. Проверь ONE_C_API_KEY на тестовом сервере.' }
$apiKeyProtected = Protect-Secret $apiKey
$apiKey.Dispose()

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentDir = Join-Path $env:LOCALAPPDATA 'TEXHORU\Agent'
$logsDir = Join-Path $agentDir 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

# Keep this folder private to the current Windows account.
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($currentIdentity.User)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($currentIdentity.User, 'FullControl', $inheritance, $propagation, $allow)))
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', $inheritance, $propagation, $allow)))
Set-Acl -LiteralPath $agentDir -AclObject $acl
Set-Acl -LiteralPath $logsDir -AclObject $acl

$epfDestination = Join-Path $agentDir 'TEXHORU-Agent.epf'
Copy-Item -LiteralPath $epfSource -Destination $epfDestination -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'Run-TEXHORUAgent.ps1') -Destination (Join-Path $agentDir 'Run-TEXHORUAgent.ps1') -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'Remove-TEXHORUAgent.ps1') -Destination (Join-Path $agentDir 'Remove-TEXHORUAgent.ps1') -Force

$config = [ordered]@{
    BaseKind = 'TEST'
    BaseLabel = $baseLabel
    BaseMode = $baseMode
    BasePath = $basePath
    ServerAddress = $serverAddress
    PlatformExe = $platformExe
    EpfPath = $epfDestination
    AuthMode = $authMode
    OneCUser = $oneCUser
    OneCPasswordProtected = $oneCPasswordProtected
    ApiHost = $apiHost
    ApiKeyProtected = $apiKeyProtected
}
$configPath = Join-Path $agentDir 'agent-config.json'
$json = $config | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($configPath, $json, [Text.UTF8Encoding]::new($false))

$taskName = 'TEXHORU 1C Test Agent'
$runScript = Join-Path $agentDir 'Run-TEXHORUAgent.ps1'
$powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShell)) { throw 'Не найден Windows PowerShell 5.1.' }
$action = New-ScheduledTaskAction -Execute $powerShell -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runScript + '"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'TEXHORU: process only explicitly approved retail-price changes in the TEST 1C base.' -Force | Out-Null

Write-Host ''
Write-Host 'Агент установлен.' -ForegroundColor Green
Write-Host 'Проверка очереди выполняется каждые 2 минуты, пока ты вошёл в Windows.'
Write-Host ('Журнал: ' + (Join-Path $agentDir 'agent.log'))
Write-Host ('Подробный вывод 1С: ' + (Join-Path $agentDir '1c-output.log'))
Write-Host 'Пароль 1С и ключ API сохранены в зашифрованном виде для этой учётной записи Windows.'
Write-Host 'При входе по паролю 1С он кратковременно передаётся процессу 1С при запуске. Для служебной учётной записи используй минимальные права.'
Write-Host ''
$runNow = Read-Host 'Запустить первую проверку очереди сейчас? Напиши ДА, чтобы начать'
if ($runNow -ceq 'ДА') {
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Первая проверка запущена. Результат смотри в журнале агента.' -ForegroundColor Green
} else {
    Write-Host 'Агент начнёт проверку по расписанию.'
}
