# Install a per-user Windows scheduled task: every 5 minutes, only while logged on.
# Task is READ-ONLY until a separate, explicit TEST pilot approval file is created.
$ErrorActionPreference = 'Stop'
if ([Environment]::Is64BitProcess) { throw 'Open 32-bit PowerShell' }
$dataDir = Join-Path $env:LOCALAPPDATA 'TEXHORU-1C-TEST-Agent'
if (!(Test-Path (Join-Path $dataDir 'credential.xml'))) { throw 'Run 01-Configure.ps1 first' }
$exe = Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
$runner = Join-Path $PSScriptRoot 'Agent-Test.ps1'
$epf = Join-Path $PSScriptRoot 'TEXHORU-TEST-Agent.epf'
if (!(Test-Path $runner)) { throw 'Agent-Test.ps1 missing' }
if (!(Test-Path $epf)) { throw 'Create TEXHORU-TEST-Agent.epf and run 03-Check-EPF.ps1 before scheduling' }

$taskName = 'TEXHORU 1C TEST Agent'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$cmd = [Security.SecurityElement]::Escape($exe)
$args = [Security.SecurityElement]::Escape(('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $runner + '" -RunPending'))
$boundary = (Get-Date -Format 'yyyy-MM-dd') + 'T00:00:00'

# XML permits a DAILY schedule with 5-minute repetitions (the cmdlet's -Daily
# parameter set does not expose -RepetitionInterval on older Windows versions).
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>TEXHORU 1C TEST. Never connects to base; user opt-in needed for writes.</Description></RegistrationInfo>
  <Triggers><CalendarTrigger>
    <StartBoundary>$boundary</StartBoundary><Enabled>true</Enabled>
    <Repetition><Interval>PT5M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
  </CalendarTrigger></Triggers>
  <Principals><Principal id="Author">
    <UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>
  </Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT4M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>$cmd</Command><Arguments>$args</Arguments></Exec></Actions>
</Task>
"@
Import-Module ScheduledTasks -ErrorAction Stop
Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null
Write-Host ('Scheduled TEST agent every 5 min for SID ' + $sid) -ForegroundColor Green
Write-Host 'Only while THIS Windows user is logged on and the computer/VM is running.' -ForegroundColor Yellow
Write-Host 'Price writes are still DISABLED. For logs: %LOCALAPPDATA%\TEXHORU-1C-TEST-Agent\agent.log'
