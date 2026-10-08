@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem ===========================================================================
rem  DSH internal plugin marketplace -- server launcher
rem
rem  Usage:
rem    start-market.bat                   start with defaults
rem    start-market.bat --port 9000       use another port
rem    start-market.bat --host 0.0.0.0    let other machines on the LAN connect
rem    start-market.bat --check           verify the environment, do not start
rem
rem  Data lives in .market\ inside this project (database + artifacts).
rem  The first run creates the database and the admin account
rem  admin / dsh-admin, which must change its password on first login.
rem ===========================================================================

set "MARKET_HOST=127.0.0.1"
set "MARKET_PORT=8787"
rem Data lives inside the project so it travels with the checkout and stays out
rem of the way. `.market/` is in .gitignore, so it is never committed.
rem %~dp0 is this script's directory (with a trailing backslash).
set "MARKET_DATA_DIR=%~dp0.market"

:parse
if "%~1"=="" goto after_parse
if /i "%~1"=="--port" (
  set "MARKET_PORT=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="--host" (
  set "MARKET_HOST=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="--data" (
  set "MARKET_DATA_DIR=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="--check" (
  set "CHECK_ONLY=1"
  shift
  goto parse
)
echo Unknown argument: %~1
echo Usage: --port PORT  --host ADDR  --data DIR  --check
exit /b 1

:after_parse

rem When bound to a LAN address the verification link must not say 127.0.0.1,
rem or the colleague who receives it cannot open it.
if not "%MARKET_HOST%"=="127.0.0.1" (
  set "MARKET_CALLBACK_HOST=%MARKET_HOST%"
)

rem ---- locate Node: system PATH first, then the DSH bundled runtime ---------
set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 (
  for /f "delims=" %%i in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)
if not defined NODE_EXE (
  set "BUNDLED=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  if exist "!BUNDLED!" set "NODE_EXE=!BUNDLED!"
)
if not defined NODE_EXE (
  echo.
  echo [ERROR] node not found.
  echo   Install Node 22.5 or newer, or make sure the DSH bundled runtime exists.
  echo.
  exit /b 1
)

rem ---- version gate: node:sqlite needs 22.5+ --------------------------------
rem Run the check from a temp file beside this script: cmd mangles the
rem parentheses inside -e strings, and %TEMP% may contain spaces which would
rem break the for /f command parsing.
set "VERSION_PROBE=%~dp0.dsh-version-probe.cjs"
> "%VERSION_PROBE%" echo const p = process.versions.node.split('.').map(Number);
>>"%VERSION_PROBE%" echo const ok = p[0] ^> 22 ^|^| p[0] === 22 ^&^& p[1] ^>= 5;
>>"%VERSION_PROBE%" echo console.log(process.versions.node ^+ ^(ok ? '' : ' TOO_OLD'^)^);
>>"%VERSION_PROBE%" echo process.exit(ok ? 0 : 1);
set "NODE_VERSION="
rem The whole command needs its own pair of quotes: without it cmd splits the
rem executable path at the space in "C:\Program Files\...".
for /f "delims=" %%v in ('""!NODE_EXE!" "!VERSION_PROBE!"" 2^>nul') do set "NODE_VERSION=%%v"
del "%VERSION_PROBE%" >nul 2>nul
if not defined NODE_VERSION (
  echo.
  echo [ERROR] Cannot run Node: !NODE_EXE!
  echo.
  exit /b 1
)
echo !NODE_VERSION! | findstr /c:"TOO_OLD" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo [ERROR] Node too old: !NODE_VERSION!
  echo   The server needs Node 22.5 or newer for the built-in node:sqlite.
  echo.
  exit /b 1
)

rem ---- must run from the project root --------------------------------------
if not exist "server\index.mjs" (
  echo.
  echo [ERROR] This does not look like the project root:
  echo   %CD%
  echo   expected to find server\index.mjs
  echo.
  exit /b 1
)

if defined CHECK_ONLY (
  echo Environment OK.
  echo   Node      !NODE_EXE!  ^(!NODE_VERSION!^)
  echo   Data dir  %MARKET_DATA_DIR%
  echo   Database  %MARKET_DATA_DIR%\market.db
  echo   Would listen on %MARKET_HOST%:%MARKET_PORT%
  exit /b 0
)

rem ---- first run: create the database and the admin account ----------------
if not exist "%MARKET_DATA_DIR%\market.db" (
  echo.
  echo First run: initialising the database...
  "!NODE_EXE!" server\cli.mjs bootstrap
  if not %errorlevel%==0 (
    echo [ERROR] Initialisation failed.
    exit /b 1
  )
  echo.
)

echo ===========================================================================
echo  DSH internal plugin marketplace - server
echo ---------------------------------------------------------------------------
echo   Listening   %MARKET_HOST%:%MARKET_PORT%
echo   Data dir    %MARKET_DATA_DIR%
echo   Node        !NODE_EXE!  ^(!NODE_VERSION!^)
echo.
echo   Market page http://127.0.0.1:19387/market   ^(open inside DSH^)
echo   Health      http://%MARKET_HOST%:%MARKET_PORT%/dsh-market/health
echo.
if not "%MARKET_HOST%"=="127.0.0.1" (
  echo   Bound to %MARKET_HOST%, so colleagues can reach it.
  echo   If they cannot connect, check that Windows Firewall allows port %MARKET_PORT%.
  echo.
)
echo   Press Ctrl+C to stop.
echo ===========================================================================
echo.

"!NODE_EXE!" server\index.mjs

echo.
echo Server stopped.
pause
