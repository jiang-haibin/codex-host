# CodexHost Windows 本机定制

## 我添加的功能

- **独立的数据目录与历史迁移**。将 Codex 历史、项目侧栏和部分 Harness 原生历史迁移到本目录的 `host-state/`，启动器统一使用该目录。
- **官方 Codex 与 Host 的历史同步**。支持增量导入、GPT 会话回写、并发写入检查和冲突报告，保留外部 Harness 的独立历史。可手动同步，也可安装每分钟运行的 Windows 计划任务。
- **Antigravity 用量与模型补全**（`antigravity-usage.mjs`）。优先使用上游统计，从原生会话数据库和转录文件补全缺失的模型与缓存统计，补充模型切换及新模型标签识别。
- **Antigravity 会话回放修复**（`antigravity-replay.mjs`）。放宽 `0.21.0` 中 `nativeReplayCompletion` 对 `session_info_update` 的硬性等待与文本长度精确匹配，增加数据库读取异常降级与 `1500ms` 兜底收敛，解决无标题会话与 `agy 1.5.11+` 历史打开卡死超时问题。
- **工具调用与文件修改展示**（`antigravity-usage.mjs`）。沿用 ACP 原生差异，修补 `plugins/antigravity/plugin.mjs` 与 `host-runtime.mjs` 补充 PascalCase 参数、`manage_task`、`search_web`、读取文件与命令执行的展示，以及大文件先搜索后读取的 `read_file` 提示。
- **本机插件白名单**（`enabled-plugins.mjs`）。写入并验证 `plugins/enabled.json`，启用 `antigravity`、`workbuddy` 与 `codex-usage`。
- **渲染器性能优化**（`renderer-performance.mjs`）。修补 `renderer-extension.js`，跳过对隐藏的 Host 输入框提示控件读取几何尺寸，减少强制样式重算。
- **Windows 启动与通知适配**（`Start-CodexHost*`、`Watch-CodexToast.ps1` / `Undo-CodexToastWatcher.ps1`）。提供普通启动、独立试用目录和静默启动入口，支持 `.codexhost-next` 并行切换，配置 WorkBuddy、Antigravity 路径与代理例外，并拦截系统通知点击额外拉起的官方窗口。

本目录使用 npm 安装的 `@codexhost/cli@0.21.0`。外部 Harness 的临时和持久侧聊使用上游实现，沿用来源 Harness（原实验性 `sidechat-gpt.mjs` 已停用并移除）。[0.21.0 发布说明](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.21.0)

## 当前启用的运行时补丁

运行 `npm ci` 时会通过 `package.json` 的 `postinstall` 按序自动应用以下 4 个补丁脚本（升级或并行验证期间支持传入 `--next` 指向 `node_modules/.codexhost-next/`）：

| 补丁脚本 | 修改目标 | 作用说明 |
| --- | --- | --- |
| `antigravity-usage.mjs` | `plugins/antigravity/manifest.json`、`plugin.mjs`、`host-runtime.mjs` | 补全 Antigravity 模型/缓存统计，补充工具参数、任务/搜索/读取展示与 `read_file` 提示 |
| `antigravity-replay.mjs` | `plugins/antigravity/plugin.mjs` | 修复 `0.21.0` `session/load` 回放完成检测死锁（在 `0.20.0` 上自动跳过） |
| `enabled-plugins.mjs` | `plugins/enabled.json` | 锁定仅启用 `antigravity`、`workbuddy`、`codex-usage` |
| `renderer-performance.mjs` | `renderer-extension.js` | 隐藏提示控件时跳过 `scrollWidth/clientWidth` 读取 |

## 首次使用

适用于 Windows。需要 Node.js 24、官方 Codex Desktop，以及已有历史记录的 `%USERPROFILE%\.codex`。建议等运行中的任务结束并退出 Desktop 后迁移历史。

从完整源码仓库使用时，先进入 `windows-local`。在本机独立目录使用时，直接打开本目录的终端。

```powershell
node --disable-warning=ExperimentalWarning .\codex-history.mjs migrate
npm ci
.\Start-CodexHost.cmd
```

`migrate` 只用于首次初始化，已有 `host-state/` 时会拒绝覆盖。安装依赖时会自动应用本机补丁和插件白名单。

启动器中的 WorkBuddy 路径当前为 `D:\Workbuddy`，Antigravity 路径为 `%USERPROFILE%\.gemini\bin\agy.exe`。请按实际安装位置调整。静默启动可双击 `Start-CodexHost-Silent.vbs`。

## 历史同步

手动同步已完成或可安全读取的历史。

```powershell
node --disable-warning=ExperimentalWarning .\codex-history.mjs sync
```

安装每分钟运行的同步计划任务。

```powershell
node --disable-warning=ExperimentalWarning .\codex-history.mjs install
```

计划任务名为 `CodexHost Conversation Sync`。运行中的写入、无法确认的状态和双方同时修改的冲突可能延后处理，执行结果写入 `host-state/` 下的日志。`CODEX_HISTORY_STOCK_HOME` 可以指定官方历史目录。

`plan` 预览非 GPT 历史数量。`prune` 会在核验 Host 副本后从官方资料目录移除相应记录，`sidebar` 会清理已核验的侧栏引用，执行前应保留历史备份。

## 更新 CodexHost 与本机补丁

等任务结束并退出正在使用的 Desktop 后运行 `npm ci`。它会按锁文件安装 Host 并应用本机补丁。升级到其他版本后先验证补丁是否兼容，再启动新版本。

从 0.20.0 升级时，三个启动器将在下次启动时优先使用 `node_modules/.codexhost-next/` 中已验证的 0.21.0。结束任务并退出 Desktop 后，如旧版后台服务仍在运行，可在本目录执行以下命令正常停止服务，再按原方式启动。

```powershell
$env:CODEXHOST_DATA_DIR = Join-Path $PWD 'host-state\host'
.\node_modules\.bin\codexhost.cmd stop
```

随后如需重新安装，可在 Host 退出后运行 `npm ci`，此后启动器将使用常规安装路径。并行安装期间如需回退，可在新版 Host 退出后将 `node_modules/.codexhost-next/` 移出 `node_modules/`，启动器就会使用原来的 0.20.0。升级前的程序、补丁和状态快照位于 `backups/v0.20.0-20261118/`。

修改补丁脚本后，在 Host 退出时重新应用。

```powershell
$patchArgs = @()
if (Test-Path -LiteralPath '.\node_modules\.codexhost-next\node_modules\.bin\codexhost.cmd') {
    $patchArgs = @('--next')
}
node .\antigravity-usage.mjs @patchArgs
node .\antigravity-replay.mjs @patchArgs
node .\enabled-plugins.mjs @patchArgs
node .\renderer-performance.mjs @patchArgs
```

## 文件作用

| 文件 | 作用 |
| --- | --- |
| `Start-CodexHost.cmd` | 使用 `host-state/` 启动，迁移项目侧栏并执行一次历史同步 |
| `Start-CodexHost-Silent.vbs` | 隐藏终端启动，也为计划任务提供隐藏同步入口 |
| `Start-CodexHost-Trial.cmd` | 使用独立的 `trial-state/` 配置启动试用实例 |
| `codex-history.mjs` | 历史迁移、增量同步、项目与侧栏处理、Windows 同步计划任务 |
| `antigravity-usage.mjs` | 补全 Antigravity 用量、工具展示与大文件读取提示 |
| `antigravity-replay.mjs` | 修复 0.21.0 中 Antigravity `session/load` 回放完成检测导致的卡死超时 |
| `enabled-plugins.mjs` | 设置并验证 Host 插件白名单 |
| `renderer-performance.mjs` | 跳过隐藏的 Host 输入框提示控件的尺寸读取，减少强制样式重算 |
| `Watch-CodexToast.ps1` | 监听通知激活产生的新进程，按限定条件处理额外拉起的窗口 |
| `Undo-CodexToastWatcher.ps1` | 撤销通知守护改动，并删除守护脚本及自身 |
| `codex-official.ico` | 启动快捷方式使用的图标 |

`host-state/`、`trial-state/`、`backups/`、依赖和日志已由 `.gitignore` 排除。迁移生成的数据包含本机历史和配置，应保留在本机。
