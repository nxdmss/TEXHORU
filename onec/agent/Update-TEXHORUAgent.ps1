# Updates an installed TEST agent without asking for credentials again.
param([Parameter(Mandatory = $true)][string]$EpfPath)
$ErrorActionPreference = 'Stop'
$agentDir = Join-Path $env:LOCALAPPDATA 'TEXHORU\Agent'
$configPath = Join-Path $agentDir 'agent-config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.BaseKind -ne 'TEST' -or $config.BaseLabel -notmatch '(?i)(test|тест|копия|pilot|пилот|demo)') { throw 'Обновление разрешено только для установленного TEST-агента.' }
$source = (Resolve-Path -LiteralPath $EpfPath).Path
if ([IO.Path]::GetExtension($source) -ne '.epf') { throw 'Выбери собранную обработку EPF.' }
# New scripts must be beside this updater before touching the installed task.
foreach ($name in @('Run-TEXHORUAgent.ps1', 'Agent-Protocol.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name))) { throw ('Не найден файл обновления: ' + $name) }
}
$taskName = 'TEXHORU 1C Test Agent'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($task.State -eq 'Running') { throw 'Агент ещё выполняет обмен. Дождись завершения и повтори обновление.' }
$mutex = [System.Threading.Mutex]::new($false, 'Local\TEXHORU_TEST_1C_AGENT')
$locked = $mutex.WaitOne(0)
if (-not $locked) { $mutex.Dispose(); throw 'Агент ещё работает. Дождись окончания обмена.' }
try {
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    $backup = Join-Path $agentDir ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -Path $backup -ItemType Directory | Out-Null
    foreach ($name in @('Run-TEXHORUAgent.ps1', 'Agent-Protocol.ps1')) {
        $installed = Join-Path $agentDir $name
        if (Test-Path -LiteralPath $installed) { Copy-Item -LiteralPath $installed -Destination $backup }
    }
    Copy-Item -LiteralPath $config.EpfPath -Destination (Join-Path $backup 'TEXHORU-Agent.epf')
    if ($source -ne [IO.Path]::GetFullPath($config.EpfPath)) { Copy-Item -LiteralPath $source -Destination $config.EpfPath -Force }
    foreach ($name in @('Run-TEXHORUAgent.ps1', 'Agent-Protocol.ps1')) {
        $src = Join-Path $PSScriptRoot $name
        $dst = Join-Path $agentDir $name
        if ([IO.Path]::GetFullPath($src) -ne [IO.Path]::GetFullPath($dst)) { Copy-Item -LiteralPath $src -Destination $dst -Force }
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $triggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $identity),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650))
    )
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Set-ScheduledTask -TaskName $taskName -Trigger $triggers -Settings $settings | Out-Null
    Remove-Item -LiteralPath (Join-Path $agentDir 'retry-state.json') -Force -ErrorAction SilentlyContinue
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    Write-Host 'Агент обновлён. Он запускается при входе в Windows и проверяет очередь каждые 2 минуты.'
    Write-Host ('Резервная копия: ' + $backup)
    Write-Host 'Сначала выполни один запуск и проверь подтверждённые цены на сайте.'
} catch {
    # Partial updates stay disabled. The backup is retained for recovery.
    Write-Host 'Обновление не завершено. Расписание оставлено отключённым; сохрани резервную копию.'
    throw
}

finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
