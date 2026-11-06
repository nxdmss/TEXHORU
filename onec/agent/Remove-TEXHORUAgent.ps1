param([switch]$Purge)

$ErrorActionPreference = 'Stop'
$taskName = 'TEXHORU 1C Test Agent'
$agentDir = Join-Path $env:LOCALAPPDATA 'TEXHORU\Agent'

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Автоматический запуск агента остановлен.'
} else {
    Write-Host 'Задание агента уже удалено.'
}

if ($Purge) {
    $confirm = Read-Host 'Удалить настройки и журнал агента? Напиши УДАЛИТЬ'
    if ($confirm -ceq 'УДАЛИТЬ') {
        Remove-Item -LiteralPath $agentDir -Recurse -Force
        Write-Host 'Настройки и журнал удалены. База 1С и сайт не затронуты.'
    } else {
        Write-Host 'Файлы агента оставлены.'
    }
} else {
    Write-Host ('Настройки и журнал оставлены в ' + $agentDir)
    Write-Host 'Чтобы удалить их осознанно, запусти этот файл с параметром -Purge.'
}
