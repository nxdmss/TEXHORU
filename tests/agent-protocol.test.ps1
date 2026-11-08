$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'onec/agent/Agent-Protocol.ps1')
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$valid = '{"protocolVersion":2,"ok":true,"applied":30,"failed":0,"processed":30,"batches":3}'
Assert ((Read-AgentResult $valid).applied -eq 30) '30 successful confirmations not recognized'
foreach ($bad in @('OK: TEXHORU: обработано изменений: 2',
    '{"protocolVersion":2,"ok":true,"applied":1,"failed":1,"processed":2,"batches":1}',
    '{"protocolVersion":2,"ok":true,"applied":30,"failed":0,"processed":30,"batches":4}',
    '{"protocolVersion":2,"ok":true,"applied":30,"failed":0,"processed":30,"batches":1}',
    '{"protocolVersion":2,"ok":true,"applied":1.5,"failed":0,"processed":1.5,"batches":1}')) {
    $rejected = $false
    try { Read-AgentResult $bad | Out-Null } catch { $rejected = $true }
    Assert $rejected 'Invalid or legacy success accepted'
}
Write-Host 'PASS: protocol accepts confirmed totals and rejects legacy, fractional and inconsistent reports.'
# A negative preflight identifies obvious operator mistakes without pretending to parse a 1C container.
$epfTemp = Join-Path ([IO.Path]::GetTempPath()) ('texhoru-epf-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $epfTemp | Out-Null
function Assert-EpfFailure([scriptblock]$Action, [string]$Expected) {
    $failed = $false
    try { & $Action } catch {
        $failed = $true
        Assert ($_.Exception.Message -match $Expected) ('Unexpected EPF failure: ' + $_.Exception.Message)
    }
    Assert $failed 'An invalid or inaccessible EPF candidate was accepted'
}
try {
    $sample = Join-Path $epfTemp 'candidate.epf'
    $code = "// TEXHORU`nПроцедура ПриОткрытии(Отказ)`nКонецПроцедуры"
    foreach ($encoding in @((New-Object Text.UTF8Encoding -ArgumentList $false),
        (New-Object Text.UTF8Encoding -ArgumentList $true), [Text.Encoding]::Unicode, [Text.Encoding]::BigEndianUnicode)) {
        [IO.File]::WriteAllText($sample, $code, $encoding)
        Assert-EpfFailure { Assert-AgentEpf $sample } 'Вместо EPF сохранён текст модуля'
    }
    [IO.File]::WriteAllBytes($sample, (New-Object byte[] 0))
    Assert-EpfFailure { Assert-AgentEpf $sample } 'пустой или обрезан'
    [IO.File]::WriteAllBytes($sample, (New-Object byte[] 4))
    Assert-EpfFailure { Assert-AgentEpf $sample } 'пустой или обрезан'
    Assert-EpfFailure { Assert-AgentEpf (Join-Path $epfTemp 'missing.epf') } 'Не найден файл'
    # Deliberately no magic signature: an unknown binary must be left for 1C to validate.
    [IO.File]::WriteAllBytes($sample, (New-Object byte[] 64))
    Assert-AgentEpf $sample
    $lock = [IO.File]::Open($sample, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Assert-EpfFailure { Assert-AgentEpf $sample } 'Не удалось прочитать EPF' } finally { $lock.Dispose() }
    # The updater must reject bad text before disabling the existing task or touching its files.
    $profile = Join-Path $epfTemp 'profile'
    $installed = Join-Path $profile 'TEXHORU\Agent'
    New-Item -ItemType Directory -Path $installed -Force | Out-Null
    @{BaseKind='TEST'; BaseLabel='TEST'} | ConvertTo-Json | Set-Content (Join-Path $installed 'agent-config.json')
    $sources = Join-Path $epfTemp 'sources'
    New-Item -ItemType Directory -Path $sources | Out-Null
    foreach ($name in @('Run-TEXHORUAgent.ps1', 'Agent-Protocol.ps1', 'Update-TEXHORUAgent.ps1')) {
        Copy-Item (Join-Path $root ('onec/agent/' + $name)) $sources
    }
    [IO.File]::WriteAllText($sample, $code, [Text.Encoding]::UTF8)
    $previousLocalAppData = $env:LOCALAPPDATA
    $global:TEXHORUTestTaskTouched = $false
    function Get-ScheduledTask { $global:TEXHORUTestTaskTouched = $true; throw 'Task should not be queried for an invalid EPF' }
    try {
        $env:LOCALAPPDATA = $profile
        Assert-EpfFailure { & (Join-Path $sources 'Update-TEXHORUAgent.ps1') -EpfPath $sample } 'Вместо EPF сохранён текст модуля'
        Assert (-not $global:TEXHORUTestTaskTouched) 'Updater touched the task before validating the EPF'
    } finally { $env:LOCALAPPDATA = $previousLocalAppData }
    Write-Host 'PASS: EPF text/BOM variants, empty, truncated, missing and locked files; binary passthrough; updater rejects before touching task.'
} finally { Remove-Item -LiteralPath $epfTemp -Recurse -Force }
# Real process invocation with a fake 1C executable, never a real database.
if (-not $IsLinux) { Write-Host 'Process fixture uses Linux; protocol checks passed.'; return }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('texhoru-agent-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    foreach ($name in @('Run-TEXHORUAgent.ps1', 'Agent-Protocol.ps1')) { Copy-Item (Join-Path $root ('onec/agent/' + $name)) $temp }
    $platform = Join-Path $temp 'fake-1c'
    @'
#!/usr/bin/env python3
import json, sys
from pathlib import Path
root=Path(__file__).parent
(root/'launched').write_text('yes')
runtime=sys.argv[sys.argv.index('/C')+1].split('|',1)[1]
Path(runtime.replace('agent-runtime-','agent-result-').replace('.json','.txt')).write_text((root/'fixture.json').read_text())
'@ | Set-Content -LiteralPath $platform
    & chmod +x $platform
    '// TEXHORU: module text mistakenly saved as EPF' | Set-Content (Join-Path $temp 'test.epf')
    $secret = ConvertTo-SecureString 'test-only-not-a-real-key' -AsPlainText -Force
    @{ BaseKind='TEST'; BaseLabel='TEST'; BaseMode='SERVER'; ServerAddress='localhost/test'; AuthMode='WINDOWS';
       ApiHost='example.test'; PlatformExe=$platform; EpfPath=(Join-Path $temp 'test.epf');
       ApiKeyProtected=(ConvertFrom-SecureString $secret) } | ConvertTo-Json | Set-Content (Join-Path $temp 'agent-config.json')
    $global:TEXHORUTestrequests = 0
    $global:TEXHORUTesthasItems = $false
    $global:TEXHORUTeststates = @()
    function Invoke-RestMethod {
        param($Method, $Uri, $Headers, $TimeoutSec, $ContentType, $Body)
        if ($Uri.EndsWith('/heartbeat')) { $global:TEXHORUTeststates += ($Body | ConvertFrom-Json).state; return @{ok=$true} }
        $global:TEXHORUTestrequests++
        if ($global:TEXHORUTesthasItems) { return @{schemaVersion=1;items=@(@{id='one'})} }
        return @{schemaVersion=1;items=@()}
    }
    $runner = Join-Path $temp 'Run-TEXHORUAgent.ps1'
    & $runner
    Assert (-not (Test-Path (Join-Path $temp 'launched'))) 'Empty queue launched 1C'
    Assert ($global:TEXHORUTeststates[-1] -eq 'idle') 'Idle status missing'
    $global:TEXHORUTesthasItems = $true
    & $runner
    Assert (-not (Test-Path (Join-Path $temp 'launched'))) 'Text masquerading as EPF launched 1C'
    Assert ($global:TEXHORUTeststates[-1] -eq 'error') 'Invalid EPF did not report an exchange error'
    Assert ((Get-Content (Join-Path $temp 'agent.log') -Raw) -match 'Вместо EPF сохранён текст модуля') 'Operator guidance missing from log'
    Remove-Item (Join-Path $temp 'retry-state.json')
    [IO.File]::WriteAllBytes((Join-Path $temp 'test.epf'), (New-Object byte[] 64))
    $valid | Set-Content (Join-Path $temp 'fixture.json')
    & $runner
    Assert (Test-Path (Join-Path $temp 'launched')) 'Nonempty queue did not launch process'
    Assert ($global:TEXHORUTeststates[-1] -eq 'idle') 'Successful run did not finish idle'
    Assert (-not (Test-Path (Join-Path $temp 'retry-state.json'))) 'Success created a retry'
    '{"protocolVersion":2,"ok":false,"applied":1,"failed":1,"processed":2,"batches":1}' | Set-Content (Join-Path $temp 'fixture.json')
    & $runner
    Assert (Test-Path (Join-Path $temp 'retry-state.json')) 'Partial failure did not schedule backoff'
    Assert ($global:TEXHORUTeststates[-1] -eq 'error') 'Partial failure reported success'
    $before = $global:TEXHORUTestrequests
    & $runner
    Assert ($global:TEXHORUTestrequests -eq $before) 'Backoff still requested queue'
    Assert (@(Get-ChildItem $temp -Filter 'agent-runtime-*.json').Count -eq 0) 'Temporary credentials left on disk'
    Write-Host 'PASS: empty queue, bad EPF prevents launch, real child process, confirmation counts, partial failure, backoff and runtime cleanup.'
} catch { Get-Content (Join-Path $temp 'agent.log') -ErrorAction SilentlyContinue; throw } finally { Remove-Item -LiteralPath $temp -Recurse -Force }
