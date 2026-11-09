@echo off
setlocal

for %%E in (ChatGPT.exe codexhost.exe) do (
    for /f "tokens=1 delims=," %%P in ('tasklist.exe /NH /FO CSV /FI "IMAGENAME eq %%E"') do (
        if /i "%%~P"=="%%E" (
            echo Close Codex Desktop and CodexHost before starting the trial.
            exit /b 1
        )
    )
)

:: 1. 记录宿主机真实用户主目录（在隔离前捕获）
set "REAL_USERPROFILE=%USERPROFILE%"

:: 2. 设置沙盒隔离运行环境
set "CODEXHOST_TRIAL=%~dp0trial-state"
set "CODEXHOST_DATA_DIR=%CODEXHOST_TRIAL%\host"
set "CODEX_HOME=%CODEXHOST_TRIAL%\codex"
set "CODEX_ELECTRON_USER_DATA_PATH=%CODEXHOST_TRIAL%\electron"
set "USERPROFILE=%CODEXHOST_TRIAL%\profile"
set "LOCALAPPDATA=%CODEXHOST_TRIAL%\local"
set "CODEXHOST_CONSOLE=0"

:: 3. 规范注入国内版 WorkBuddy 路径与凭证目录（仅由 workbuddy 插件读取）
set "CODEXHOST_WORKBUDDY_COMMAND=D:\Workbuddy"
set "WORKBUDDY_CONFIG_DIR=%REAL_USERPROFILE%\.workbuddy"

:: 4. 规范注入 Antigravity CLI 路径（仅由 antigravity 插件独占读取，不干扰其他模型）
set "CODEXHOST_ANTIGRAVITY_COMMAND=%REAL_USERPROFILE%\.gemini\bin\agy.exe"

:: 5. 优化国内域名网络白名单，防止本地 7890 代理导致 Axios 抛出异常
set "NO_PROXY=workbuddy.cn,tencent.com,localhost,127.0.0.1,%NO_PROXY%"
set "no_proxy=workbuddy.cn,tencent.com,localhost,127.0.0.1,%no_proxy%"

pushd "%~dp0" || exit /b 1
call "%~dp0node_modules\.bin\codexhost.cmd"
set "CODEXHOST_EXIT=%ERRORLEVEL%"
popd
exit /b %CODEXHOST_EXIT%
