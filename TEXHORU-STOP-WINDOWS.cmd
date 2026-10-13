@echo off
cd /d "%~dp0"
if exist "TEXHORU STOP.exe" (
  "TEXHORU STOP.exe"
) else (
  node scripts/auto-stop.mjs
)
