# READ-ONLY: run AFTER adding the object-module source to TEXHORU-TEST-Agent.epf.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Agent-Test.ps1') -CheckProcessor
