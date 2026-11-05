# Configure 1C TEST agent without storing plaintext passwords.
# Run in the SAME 32-bit PowerShell user account as the scheduled agent.
$ErrorActionPreference = 'Stop'
if ([Environment]::Is64BitProcess) {
    throw 'Open C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe (32-bit)'
}
$dataDir = Join-Path $env:LOCALAPPDATA 'TEXHORU-1C-TEST-Agent'
if (!(Test-Path $dataDir)) { New-Item -Path $dataDir -ItemType Directory -Force | Out-Null }

Write-Host 'TEXHORU 1C TEST AGENT - ONLY localhost/test, ONE Xiaomi 15' -ForegroundColor Yellow
Write-Host 'Credentials remain encrypted for this Windows account (DPAPI). Do not send them.'
$httpsHost = (Read-Host 'HTTPS host of TEXHORU without https:// (for example your ngrok host)').Trim()
if ($httpsHost -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{2,250}$' -or $httpsHost.Contains('..')) {
    throw 'Enter only the HTTPS host name; no path, port, http:// or https://'
}
$cred = Get-Credential -UserName 'Progger' -Message 'Password for TEST 1C only (not website)'
if ($null -eq $cred) { throw 'No 1C credential supplied' }
$key = Read-Host 'ONE_C_API_KEY from server/.env.local (not your 1C password)' -AsSecureString
if ($null -eq $key -or $key.Length -eq 0) { throw 'API key is required' }

$config = @{
    server = 'localhost'
    database = 'test'
    httpsHost = $httpsHost
    allowedOneCId = 'c22eb931-4214-11f0-8169-74563c6454da'
    variant = 'Xiaomi 15 12/512 black - TEST'
}
$config | ConvertTo-Json | Set-Content (Join-Path $dataDir 'config.json') -Encoding UTF8
$cred | Export-Clixml (Join-Path $dataDir 'credential.xml')
$key | ConvertFrom-SecureString | Set-Content (Join-Path $dataDir 'api-key.dpapi') -Encoding ASCII
Write-Host ('Stored encrypted configuration under: ' + $dataDir) -ForegroundColor Green
Write-Host 'Price writes are DISABLED until a separate explicit arm step.' -ForegroundColor Yellow
Write-Host 'Next: run 02-Read-Test.ps1 (in the 32-bit PowerShell).' -ForegroundColor Green
