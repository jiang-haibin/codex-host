@echo off
setlocal

set "HAS_RUNNING=0"
for %%E in (ChatGPT.exe codexhost.exe) do (
    for /f "tokens=1 delims=," %%P in ('tasklist.exe /NH /FO CSV /FI "IMAGENAME eq %%E"') do (
        if /i "%%~P"=="%%E" set "HAS_RUNNING=1"
    )
)
if "%HAS_RUNNING%"=="1" (
    echo Existing Codex Desktop or CodexHost process is running.
    choice /C YN /M "Force close existing instances and restart"
    if errorlevel 2 exit /b 1
    taskkill /F /IM ChatGPT.exe >nul 2>&1
    taskkill /F /IM codexhost.exe >nul 2>&1
    timeout /t 1 /nobreak >nul
)

set "CODEX_HOME=%~dp0host-state\codex"
set "CODEX_SQLITE_HOME=%CODEX_HOME%"
set "CODEXHOST_DATA_DIR=%~dp0host-state\host"
set "CODEX_ELECTRON_USER_DATA_PATH=%~dp0host-state\electron"
if not exist "%CODEX_HOME%\state_5.sqlite" (
    echo Initialize the local history first with: node "%~dp0codex-history.mjs" migrate
    pause
    exit /b 1
)
node --disable-warning=ExperimentalWarning "%~dp0codex-history.mjs" projects
if errorlevel 1 (
    echo Could not migrate the Host project sidebar.
    pause
    exit /b 1
)
node --disable-warning=ExperimentalWarning "%~dp0codex-history.mjs" sync > "%~dp0host-state\sync.log" 2>&1

REM 1. Disable auto console popup
set "CODEXHOST_CONSOLE=0"

REM 2. WorkBuddy executable and Host-local conversation profile
set "CODEXHOST_WORKBUDDY_COMMAND=D:\Workbuddy"
set "WORKBUDDY_CONFIG_DIR=%CODEXHOST_DATA_DIR%\workbuddy"

REM 3. Antigravity CLI path (uses real user profile with full skills/MCP/rules)
set "CODEXHOST_ANTIGRAVITY_COMMAND=%USERPROFILE%\.gemini\bin\agy.exe"

REM 4. Bypass local proxy for domestic services
set "NO_PROXY=workbuddy.cn,tencent.com,localhost,127.0.0.1,%NO_PROXY%"
set "no_proxy=workbuddy.cn,tencent.com,localhost,127.0.0.1,%no_proxy%"

REM 5. Keep toast clicks from opening the official Codex instance
start "" /b powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0Watch-CodexToast.ps1" >nul 2>&1

pushd "%~dp0" || exit /b 1
call "%~dp0node_modules\.bin\codexhost.cmd"
set "CODEXHOST_EXIT=%ERRORLEVEL%"
popd
if not "%CODEXHOST_EXIT%"=="0" (
    echo CodexHost exited with error code %CODEXHOST_EXIT%.
    pause
)
exit /b %CODEXHOST_EXIT%
