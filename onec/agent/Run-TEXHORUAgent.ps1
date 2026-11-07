# Runs one queue check in the TEST 1C base. Called by Windows Task Scheduler.
$ErrorActionPreference = 'Stop'

$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $AgentDir 'agent-config.json'
$LogPath = Join-Path $AgentDir 'agent.log'
$runId = [guid]::NewGuid().ToString('N')
$RuntimePath = Join-Path $AgentDir ('agent-runtime-' + $runId + '.json')
$ResultPath = Join-Path $AgentDir ('agent-result-' + $runId + '.txt')
$OneCOutputPath = Join-Path $AgentDir ('1c-output-' + $runId + '.log')
$RetryPath = Join-Path $AgentDir 'retry-state.json'
. (Join-Path $AgentDir 'Agent-Protocol.ps1')
$agentExitCode = 0
$reportedApplied = 0
$reportedFailed = 0

function Send-Heartbeat([string]$State) {
    if (-not $headers) { return }
    try {
        $body = @{ state = $State; applied = $reportedApplied; failed = $reportedFailed } | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post -Uri ('https://' + $config.ApiHost + '/api/integrations/1c/agent/heartbeat') -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null
    } catch { Write-AgentLog 'Не удалось передать состояние агента на сайт.' }
}
$mutex = [System.Threading.Mutex]::new($false, 'Local\TEXHORU_TEST_1C_AGENT')
$locked = $false

function Write-AgentLog([string]$Message) {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 2MB)) {
        Move-Item -Force $LogPath ($LogPath + '.1')
    }
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Convert-SecureStringToPlainText([string]$ProtectedValue) {
    if ([string]::IsNullOrWhiteSpace($ProtectedValue)) { return '' }
    $secure = ConvertTo-SecureString -String $ProtectedValue
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secure.Dispose()
    }
}

function Quote-Argument([string]$Value) {
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { exit 0 }
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Нет настроек агента. Запусти Install-TEXHORUAgent.ps1.' }

    if (Test-Path -LiteralPath $RetryPath) {
        try { $retry = Get-Content -LiteralPath $RetryPath -Raw | ConvertFrom-Json } catch { $retry = $null }
        if ($retry -and [datetime]$retry.nextAttemptAt -gt (Get-Date)) { return }
    }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    Write-AgentLog 'Старт агента.'
    if ($config.BaseKind -ne 'TEST') { throw 'Запуск остановлен: в настройках не указана тестовая база.' }
    if ($config.BaseLabel -notmatch '(?i)(test|тест|копия|pilot|пилот|demo)') {
        throw 'Запуск остановлен: название базы не похоже на тестовую копию.'
    }
    if (-not (Test-Path -LiteralPath $config.PlatformExe)) { throw 'Не найден исполняемый файл 1С.' }
    if (-not (Test-Path -LiteralPath $config.EpfPath)) { throw 'Не найден собранный файл TEXHORU-Agent.epf.' }

    $apiKey = Convert-SecureStringToPlainText $config.ApiKeyProtected
    if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'Не сохранён ключ тестового обмена 1С.' }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'x-1c-key' = $apiKey; 'ngrok-skip-browser-warning' = 'true' }
    $pendingUrl = 'https://' + $config.ApiHost + '/api/integrations/1c/price-sync/pending'
    $pending = Invoke-RestMethod -Method Get -Uri $pendingUrl -Headers $headers -TimeoutSec 25
    if ($pending.schemaVersion -ne 1 -or $null -eq $pending.items) { throw 'Сервер вернул неверный формат очереди.' }
    $items = @($pending.items)
    if ($items.Count -eq 0) {
        Write-AgentLog 'Очередь пуста. 1С не запускалась.'
        Send-Heartbeat 'idle'
        Remove-Item -LiteralPath $RetryPath -Force -ErrorAction SilentlyContinue
        return
    }
    Send-Heartbeat 'processing'

    # The key is written only for the short lifetime of this 1C run.
    # The folder is private to the Windows account that installed the agent.
    $runtime = @{
        host = [string]$config.ApiHost
        apiKey = $apiKey
        baseKind = 'TEST'
        baseLabel = [string]$config.BaseLabel
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($RuntimePath, $runtime, [Text.UTF8Encoding]::new($false))
    if (Test-Path $ResultPath) { Remove-Item -LiteralPath $ResultPath -Force }
    if (Test-Path $OneCOutputPath) { Remove-Item -LiteralPath $OneCOutputPath -Force }

    $arguments = 'ENTERPRISE '
    if ($config.BaseMode -eq 'FILE') {
        $arguments += '/F ' + (Quote-Argument ([string]$config.BasePath)) + ' '
    } elseif ($config.BaseMode -eq 'SERVER') {
        $arguments += '/S ' + (Quote-Argument ([string]$config.ServerAddress)) + ' '
    } else {
        throw 'Не выбран тип информационной базы 1С.'
    }

    if ($config.AuthMode -eq 'WINDOWS') {
        $arguments += '/WA+ '
    } elseif ($config.AuthMode -eq 'ONEC') {
        $password = Convert-SecureStringToPlainText $config.OneCPasswordProtected
        if ([string]::IsNullOrWhiteSpace($config.OneCUser) -or [string]::IsNullOrWhiteSpace($password)) {
            throw 'Не сохранены имя или пароль пользователя 1С.'
        }
        $arguments += '/N ' + (Quote-Argument ([string]$config.OneCUser)) + ' /P ' + (Quote-Argument $password) + ' '
        $password = $null
    } else {
        throw 'Не выбран способ входа в 1С.'
    }

    $startupParameter = 'TEXHORU_AGENT|' + $RuntimePath
    $arguments += '/Execute ' + (Quote-Argument ([string]$config.EpfPath)) + ' '
    $arguments += '/C ' + (Quote-Argument $startupParameter) + ' '
    $arguments += '/DisableStartupDialogs /Out ' + (Quote-Argument $OneCOutputPath) + ' -NoTruncate'

    Write-AgentLog ('В очереди изменений: ' + $items.Count + '. Запускаю только тестовую базу "' + $config.BaseLabel + '".')
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = [string]$config.PlatformExe
    $startInfo.Arguments = $arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden

    $process = [Diagnostics.Process]::Start($startInfo)
    if (-not $process.WaitForExit(240000)) {
        try { $process.Kill() } catch {}
        throw '1С не завершила обработку за 4 минуты. Проверь журнал.'
    }
    $process.Refresh()
    $exitCode = $process.ExitCode
    $process.Dispose()

    if (-not (Test-Path -LiteralPath $ResultPath)) {
        if (Test-Path $OneCOutputPath) {
            $oneCOutput = Get-Content -LiteralPath $OneCOutputPath -Raw -ErrorAction SilentlyContinue
            if ($oneCOutput) { Write-AgentLog ('Вывод 1С: ' + ($oneCOutput -replace '[\r\n]+', ' ')) }
        }
        throw "1С не вернула результат обработки (код завершения: $exitCode)."
    }

    $result = Read-AgentResult (Get-Content -LiteralPath $ResultPath -Raw)
    $reportedApplied = $result.applied
    $reportedFailed = $result.failed
    Write-AgentLog ('Подтверждено сайтом и 1С: ' + $result.applied + '; ошибок: ' + $result.failed + '; пакетов: ' + $result.batches + '.')
    if (-not $result.ok) { throw 'Обработка сообщила об ошибке. Подробности в обмене с 1С на сайте и файле agent-result.' }
    if ($exitCode -ne 0) { throw "1С завершилась с кодом $exitCode." }
    Send-Heartbeat 'idle'
    Remove-Item -LiteralPath $RetryPath -Force -ErrorAction SilentlyContinue

}
catch {
    $agentExitCode = 1
    try {
        Write-AgentLog ('ОШИБКА: ' + $_.Exception.Message)
        Send-Heartbeat 'error'
        $failures = 1
        if ($retry) { $failures = [Math]::Min(10, [int]$retry.failures + 1) }
        $minutes = [Math]::Min(10, [Math]::Pow(2, $failures))
        @{ failures = $failures; nextAttemptAt = (Get-Date).AddMinutes($minutes).ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath $RetryPath -Encoding UTF8
        Write-AgentLog ('Следующая попытка не раньше чем через ' + $minutes + ' мин.')
    } catch {}
}
finally {
    Remove-Item -LiteralPath $RuntimePath -Force -ErrorAction SilentlyContinue
    if ($locked) {
        # Keep only the latest 20 runs; never remove runtime files of another process.
        foreach ($pattern in @('agent-result-*.txt', '1c-output-*.log')) {
            Get-ChildItem -LiteralPath $AgentDir -Filter $pattern -File |
                Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 |
                Remove-Item -Force -ErrorAction SilentlyContinue
        }
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}

exit $agentExitCode
