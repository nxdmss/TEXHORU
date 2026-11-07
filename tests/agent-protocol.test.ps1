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
    'fixture' | Set-Content (Join-Path $temp 'test.epf')
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
    Write-Host 'PASS: empty queue, real child process, confirmation counts, partial failure, backoff and runtime cleanup.'
} catch { Get-Content (Join-Path $temp 'agent.log') -ErrorAction SilentlyContinue; throw } finally { Remove-Item -LiteralPath $temp -Recurse -Force }
