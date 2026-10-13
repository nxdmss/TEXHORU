@echo off
cd /d "%~dp0"
if exist "TEXHORU.exe" (
  "TEXHORU.exe"
) else (
  node scripts/auto-start.mjs
)
