@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo TEXHORU - CHISTAYA USTANOVKA
echo.
echo Zakroy TEXHORU.exe i TEXHORU STOP.exe.
echo Budet sozdan rezervnyy arhiv bazy, nastroek i fotografiy.
echo Posle etogo lokalnye tovary, gruppy, ceny i privyazki obnulatsya.
echo.
set /p "CONFIRM=Vvedi RESET-TEXHORU dlya podtverzhdeniya: "
if not "%CONFIRM%"=="RESET-TEXHORU" (
  echo Otmeneno.
  pause
  exit /b 0
)
set "NODE_EXE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE (
  for /d %%D in ("%LOCALAPPDATA%\TEXHORU\runtime\node-v22*-win-x64") do (
    if exist "%%~fD\node.exe" set "NODE_EXE=%%~fD\node.exe"
  )
)
if not defined NODE_EXE (
  echo Node.js ne nayden. Zapusti TEXHORU.exe odin raz ili ustanovi Node.js 22.
  pause
  exit /b 1
)
"%NODE_EXE%" "%~dp0scripts\reset-local.mjs" --confirm RESET-TEXHORU
echo.
if errorlevel 1 (
  echo Sbrosheno NE bylo. Prover tekst oshibki vyshe.
) else (
  echo Gotovo. Teper zapusti TEXHORU.exe.
)
pause
