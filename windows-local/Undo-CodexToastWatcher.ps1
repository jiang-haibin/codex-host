# 回退“通知点击守护”改动，恢复到加入 Watch-CodexToast.ps1 之前的状态。
#
# 用法（在 D:\codex-host 下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\Undo-CodexToastWatcher.ps1
#
# 只删除这次加入的内容，启动器里其他未提交的改动保持不变：
#   - Start-CodexHost.cmd / Start-CodexHost-Trial.cmd / Start-CodexHost-Silent.vbs 中
#     启动守护脚本的那几行；
#   - .gitattributes 中的 "*.ps1 text eol=crlf"；
#   - Watch-CodexToast.ps1，以及本脚本自身。
# 正在运行的守护进程会先被结束（只匹配本目录下的 Watch-CodexToast.ps1）。

param(
    [string]$Root = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$encoding = New-Object System.Text.UTF8Encoding($false)

function Remove-Block($name, $pattern) {
    $file = Join-Path $Root $name
    if (-not (Test-Path -LiteralPath $file)) {
        Write-Host "跳过（文件不存在）：$name"
        return
    }
    $text = [IO.File]::ReadAllText($file, $encoding)
    $updated = [regex]::Replace($text, $pattern, '')
    if ($updated -eq $text) {
        Write-Host "跳过（未找到改动）：$name"
        return
    }
    [IO.File]::WriteAllText($file, $updated, $encoding)
    Write-Host "已还原：$name"
}

# 1. 结束本目录守护脚本对应的 powershell 进程。
$watcher = Join-Path $Root 'Watch-CodexToast.ps1'
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($watcher, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "已结束守护进程：$($_.ProcessId)"
    }

# 2. 删除启动器中的守护启动行（注释行 + 启动行 + 紧随的空行）。
$launchBlock = "(?m)^(REM \d+\. |' )Keep toast clicks from opening the official Codex instance\r?\n" +
    "[^\r\n]*Watch-CodexToast\.ps1[^\r\n]*\r?\n\r?\n"
foreach ($name in 'Start-CodexHost.cmd', 'Start-CodexHost-Trial.cmd', 'Start-CodexHost-Silent.vbs') {
    Remove-Block $name $launchBlock
}

# 3. 还原 .gitattributes。
Remove-Block '.gitattributes' '(?m)^\*\.ps1 text eol=crlf\r?\n'

# 4. 删除守护脚本和本脚本。
if (Test-Path -LiteralPath $watcher) {
    Remove-Item -LiteralPath $watcher -Force
    Write-Host '已删除：Watch-CodexToast.ps1'
}
Remove-Item -LiteralPath $PSCommandPath -Force
Write-Host '回退完成。重新用启动器启动 CodexHost 即可。'
