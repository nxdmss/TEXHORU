# READ-ONLY: do not change TEST prices. 32-bit PowerShell.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Agent-Test.ps1')
