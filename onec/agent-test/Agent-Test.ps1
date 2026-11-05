# TEXHORU TEST: 1C 8.3 32-bit COM agent. PowerShell 4+.
# No configuration edits. Writes are OFF until an explicit local arm file exists.
param(
    [switch]$CheckProcessor,
    [switch]$RunPending
)
$ErrorActionPreference = 'Stop'
$agentId = 'c22eb931-4214-11f0-8169-74563c6454da'
$dataDir = Join-Path $env:LOCALAPPDATA 'TEXHORU-1C-TEST-Agent'
$logPath = Join-Path $dataDir 'agent.log'

function Log([string]$Message) {
    if (!(Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 5242880) {
        Move-Item $logPath ($logPath + '.previous') -Force
    }
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $Message
    Add-Content -Path $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

function OneC([object]$Target, [string]$Name, [string]$Kind, [object[]]$Values = @()) {
    if ($null -eq $Target) { throw ('1C COM: empty object for ' + $Name) }
    switch ($Kind) {
        'method' { $binding = [System.Reflection.BindingFlags]::InvokeMethod; break }
        'get'    { $binding = [System.Reflection.BindingFlags]::GetProperty; break }
        'set'    { $binding = [System.Reflection.BindingFlags]::SetProperty; break }
        default  { throw 'Invalid COM call mode' }
    }
    return [System.__ComObject].InvokeMember($Name, $binding, $null, $Target, $Values)
}

if ([Environment]::Is64BitProcess) {
    throw 'Use 32-bit PowerShell: C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
}
if (!(Test-Path (Join-Path $dataDir 'credential.xml'))) {
    throw 'Not configured: run 01-Configure.ps1 first in 32-bit PowerShell'
}
if (!(Test-Path (Join-Path $dataDir 'config.json'))) {
    throw 'Not configured: missing config.json'
}
$config = Get-Content (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json
if ($config.database -cne 'test' -or $config.server -cne 'localhost' -or
    $config.allowedOneCId -cne $agentId) {
    throw 'Safety stop: only localhost / test / Xiaomi 15 is allowed'
}
if ($config.httpsHost -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{2,250}$') {
    throw 'HTTPS host configuration is invalid'
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\TEXHORU-1C-TEST-Agent')
$locked = $false
try {
    $locked = $mutex.WaitOne(0)
    if (!$locked) { Log 'Another TEST agent cycle is running. Skipped.'; return }

    $credential = Import-Clixml (Join-Path $dataDir 'credential.xml')
    if ($credential -isnot [System.Management.Automation.PSCredential]) {
        throw 'Credential store is not a Windows PSCredential'
    }
    $username = $credential.UserName
    $password = $credential.GetNetworkCredential().Password
    if ($username -match '[";]' -or $password -match '[";]') {
        throw '1C password/login contains unsupported connection-string characters'
    }

    # Intentionally FIXED: the production database "base" must never be selected.
    $connectionString = 'Srvr="localhost";Ref="test";Usr="' + $username + '";Pwd="' + $password + '";'
    $com = New-Object -ComObject V83.COMConnector
    $db = $com.Connect($connectionString)
    $password = $null
    $connectionString = $null

    # Always perform a read-only query before any synchronization.
    $q = OneC $db 'NewObject' 'method' @('Запрос')
    $readSql = 'ВЫБРАТЬ ПЕРВЫЕ 1 Номенклатура.Наименование КАК Название ИЗ Справочник.Номенклатура КАК Номенклатура'
    OneC $q 'Текст' 'set' @($readSql) | Out-Null
    $result = OneC $q 'Выполнить' 'method'
    $rows = OneC $result 'Выбрать' 'method'
    $hasItem = OneC $rows 'Следующий' 'method'
    if (!$hasItem) { throw 'TEST database has no nomenclature; not processing prices' }
    $productName = [string](OneC $rows 'Название' 'get')
    Log ('Connected to 1C TEST. Nomenclature read OK: ' + $productName)

    if (!$CheckProcessor -and !$RunPending) {
        Log 'READ-ONLY health check passed. No prices changed.'
        return
    }

    $epfPath = Join-Path $PSScriptRoot 'TEXHORU-TEST-Agent.epf'
    if (!(Test-Path $epfPath)) {
        throw ('External 1C processor not built yet: ' + $epfPath)
    }
    $processorManager = OneC $db 'ВнешниеОбработки' 'get'
    $processor = OneC $processorManager 'Создать' 'method' @($epfPath)
    $diagnostic = [string](OneC $processor 'ТЕХОРУТестПроверить' 'method')
    Log ('TEST processor verified: ' + $diagnostic)

    if ($CheckProcessor -and !$RunPending) {
        Log 'External processor check passed. No prices changed.'
        return
    }

    # Schedule can safely run before activation. Only a locally approved arm file unlocks prices.
    $armFile = Join-Path $dataDir 'enable-price-writes.test'
    if (!(Test-Path $armFile)) {
        Log 'READ-ONLY mode: price writes not armed. No changes made.'
        return
    }
    $armText = (Get-Content $armFile -Raw).Trim()
    if ($armText -cne ('TEST ONLY ' + $agentId)) {
        throw 'Safety stop: invalid local approval for one-item TEST pilot'
    }

    if (!(Test-Path (Join-Path $dataDir 'api-key.dpapi'))) {
        throw 'API key not configured'
    }
    $encrypted = Get-Content (Join-Path $dataDir 'api-key.dpapi') -Raw
    $secureKey = ConvertTo-SecureString ($encrypted.Trim())
    $keyCredential = New-Object System.Management.Automation.PSCredential ('api', $secureKey)
    $apiKey = $keyCredential.GetNetworkCredential().Password
    if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'Empty API key' }
    # BSL independently checks that the server scope contains ONLY the Xiaomi GUID.
    $report = [string](OneC $processor 'ПилотТЕХОРУПолучитьЦены' 'method' @([string]$config.httpsHost, $apiKey))
    $apiKey = $null
    Log ('TEST price exchange: ' + $report)
}
catch {
    Log ('ERROR: ' + $_.Exception.Message)
    exit 1
}
finally {
    if ($locked) { $mutex.ReleaseMutex() | Out-Null }
    $mutex.Dispose()
}
