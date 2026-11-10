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
    choice /C YN /M "Force close existing instances and start"
    if errorlevel 2 exit /b 1
    taskkill /F /IM ChatGPT.exe >nul 2>&1
    taskkill /F /IM codexhost.exe >nul 2>&1
    timeout /t 1 /nobreak >nul
)

REM 1. Capture real host user profile before sandbox redirection
set "REAL_USERPROFILE=%USERPROFILE%"

REM 2. Configure isolated trial-state paths
set "CODEXHOST_TRIAL=%~dp0trial-state"
set "CODEXHOST_DATA_DIR=%CODEXHOST_TRIAL%\host"
set "CODEX_HOME=%CODEXHOST_TRIAL%\codex"
set "CODEX_ELECTRON_USER_DATA_PATH=%CODEXHOST_TRIAL%\electron"
set "USERPROFILE=%CODEXHOST_TRIAL%\profile"
set "LOCALAPPDATA=%CODEXHOST_TRIAL%\local"
set "CODEXHOST_CONSOLE=0"

REM 3. Domestic WorkBuddy paths and credentials
set "CODEXHOST_WORKBUDDY_COMMAND=D:\Workbuddy"
set "WORKBUDDY_CONFIG_DIR=%REAL_USERPROFILE%\.workbuddy"

REM 4. Antigravity CLI path (isolated to antigravity plugin)
set "CODEXHOST_ANTIGRAVITY_COMMAND=%REAL_USERPROFILE%\.gemini\bin\agy.exe"

REM 5. Bypass local proxy for domestic services
set "NO_PROXY=workbuddy.cn,tencent.com,localhost,127.0.0.1,%NO_PROXY%"
set "no_proxy=workbuddy.cn,tencent.com,localhost,127.0.0.1,%no_proxy%"

pushd "%~dp0" || exit /b 1
call "%~dp0node_modules\.bin\codexhost.cmd"
set "CODEXHOST_EXIT=%ERRORLEVEL%"
popd
if not "%CODEXHOST_EXIT%"=="0" (
    echo CodexHost exited with error code %CODEXHOST_EXIT%.
    pause
)
exit /b %CODEXHOST_EXIT%
