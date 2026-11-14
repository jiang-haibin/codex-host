# CodexHost 通知点击守护脚本
#
# Codex Desktop 是 MSIX 打包应用。点击 Host 实例弹出的系统通知时，Windows
# 通知服务（WpnUserService）除了让 Host 进程自己收到 click 事件外，还会按包的
# AUMID 额外启动一个不带 --user-data-dir 的 ChatGPT.exe（参数形如
# "type=click&tag=..."）。这个进程使用官方默认的用户数据目录，于是会打开或
# 聚焦官方 Codex 窗口，而不是 Host。
#
# 本脚本在 CodexHost 运行期间监听 ChatGPT.exe 的启动，只针对“刚刚由通知服务
# 拉起”的那一个新进程，在它打开窗口前结束它，让点击只由 Host 实例处理。
# 判定条件全部满足才会动手：
#   1. 进程是本脚本亲眼看到创建的（不扫描已存在的进程）；
#   2. 父进程是 WpnUserService，参数是通知激活参数，且不带 --user-data-dir；
#   3. Host 实例正在运行，且此外没有任何其他官方 Codex 主进程。
# 因此已经在运行的官方 Codex（无论当初怎么启动的）永远不会被结束。

param(
    # 等待 codexhost.exe 出现的最长秒数，超时仍未出现则退出。
    [int]$StartupGraceSeconds = 120
)

$ErrorActionPreference = 'Stop'

# 同一会话只保留一个守护进程。
$isFirst = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\CodexHostToastWatcher', [ref]$isFirst)
if (-not $isFirst) {
    exit 0
}

# Electron 的 Windows 通知激活参数：click / action / reply。
$toastLaunchPattern = '(?i)(^|\s)"?type=(click|action|reply)&'

function Get-MainCodexProcesses {
    # 只看主进程，Chromium 子进程都带 --type=。
    @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?i)\s--type=' })
}

function Test-HostProcess($process) {
    # codexhost 启动的实例同时带远程调试端口和独立的用户数据目录。
    $process.CommandLine -match '(?i)--remote-debugging-port=' -and
        $process.CommandLine -match '(?i)--user-data-dir='
}

function Test-ToastLaunch($process) {
    $process.CommandLine -notmatch '(?i)--user-data-dir=' -and
        $process.CommandLine -match $toastLaunchPattern
}

function Test-NotificationParent($process) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)" -ErrorAction SilentlyContinue
    $parent -and $parent.Name -eq 'svchost.exe' -and $parent.CommandLine -match '(?i)\bWpnUserService\b'
}

function Stop-ToastLaunches($created) {
    # 只处理本批事件里新建的、由通知服务拉起的进程。
    $candidates = @($created | Where-Object {
        $_.CommandLine -and $_.CommandLine -notmatch '(?i)\s--type=' -and
            (Test-ToastLaunch $_) -and (Test-NotificationParent $_)
    })
    if ($candidates.Count -eq 0) {
        return
    }
    $newIds = @($created | ForEach-Object { $_.ProcessId })
    $mains = Get-MainCodexProcesses
    if (-not ($mains | Where-Object { Test-HostProcess $_ })) {
        return
    }
    # 只要还有其他官方 Codex 在运行，这次点击就可能属于它，一律不动。
    $official = $mains | Where-Object { -not (Test-HostProcess $_) -and $newIds -notcontains $_.ProcessId }
    if ($official) {
        return
    }
    foreach ($candidate in $candidates) {
        # 再确认一次 PID 仍是同一个进程，避免 PID 被复用。
        $current = $mains | Where-Object {
            $_.ProcessId -eq $candidate.ProcessId -and $_.CreationDate -eq $candidate.CreationDate
        }
        if ($current) {
            & taskkill.exe /PID $candidate.ProcessId /T /F *> $null
        }
    }
}

function Test-LauncherRunning {
    [bool](Get-Process -Name codexhost -ErrorAction SilentlyContinue)
}

$sourceId = 'CodexHostToastLaunch'
$query = "SELECT * FROM __InstanceCreationEvent WITHIN 0.5 " +
    "WHERE TargetInstance ISA 'Win32_Process' AND TargetInstance.Name = 'ChatGPT.exe'"
Register-CimIndicationEvent -Query $query -SourceIdentifier $sourceId | Out-Null

$deadline = (Get-Date).AddSeconds($StartupGraceSeconds)
$launcherSeen = $false
try {
    while ($true) {
        # 有新 ChatGPT.exe 时立即检查；超时只用来检查 codexhost 是否已退出。
        Wait-Event -SourceIdentifier $sourceId -Timeout 5 | Out-Null
        $events = @(Get-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue)
        $events | Remove-Event
        if ($events.Count -gt 0) {
            Stop-ToastLaunches @($events | ForEach-Object { $_.SourceEventArgs.NewEvent.TargetInstance })
        }

        if (Test-LauncherRunning) {
            $launcherSeen = $true
        } elseif ($launcherSeen -or (Get-Date) -gt $deadline) {
            break
        }
    }
} finally {
    Unregister-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
