# CodexHost Windows 本机定制

## 我添加的功能

- **独立的数据目录与历史迁移**。将 Codex 历史、项目侧栏和部分 Harness 原生历史迁移到本目录的 `host-state/`，启动器统一使用该目录。
- **官方 Codex 与 Host 的历史同步**。支持增量导入、GPT 会话回写、并发写入检查和冲突报告，保留外部 Harness 的独立历史。可手动同步，也可安装每分钟运行的 Windows 计划任务。
- **Antigravity 用量与模型补全**（`antigravity-usage.mjs`）。优先使用上游统计，从原生会话数据库和转录文件补全缺失的模型与缓存统计，补充模型切换及新模型标签识别（含 `Gemini 4 Neon`、`Orchestrator (Neon)` 等）。
- **工具调用与文件修改展示**（`antigravity-usage.mjs`）。沿用 ACP 原生差异，修补 `plugins/antigravity/plugin.mjs` 与 `host-runtime.mjs` 补充 PascalCase 参数、`manage_task`、`search_web`、读取文件与命令执行的展示，以及大文件先搜索后读取的 `read_file` 提示。
- **持久侧边对话侧栏隔离修复**（`sidechat-sidebar.mjs`）。修补 `host-runtime.mjs` 与 `desktop-controller.mjs`：对带 `attachedToThreadId` 的持久侧边对话不再广播 `thread/started` 通知（与官方 `codex.exe` 行为一致，避免侧边对话自动进入左侧项目聊天记录），同时在桥接层 `observeBridgeResult` 中补全 `thread/fork` 归属登记。
- **本机插件白名单**（`enabled-plugins.mjs`）。写入并验证 `plugins/enabled.json`，启用 `antigravity`、`workbuddy` 与 `codex-usage`。
- **渲染器性能优化**（`renderer-performance.mjs`）。修补 `renderer-extension.js`，跳过对隐藏的 Host 输入框提示控件读取几何尺寸，减少强制样式重算。
- **版本化安全更新与零锁冲突切换**（`resolve-codexhost.mjs`、`stage-codexhost.mjs`）。三个启动器统一按 `package.json` 锁定版本解析 CLI（优先标准 `node_modules/`，其次根目录 `.codexhost-staged/<version>/`，兼容旧 `node_modules/.codexhost-next/`），避免运行中 Windows 文件锁冲突与误启动旧版。
- **Windows 启动与通知适配**（`Start-CodexHost*`、`Watch-CodexToast.ps1` / `Undo-CodexToastWatcher.ps1`）。提供普通启动、独立试用目录和静默启动入口，配置 WorkBuddy、Antigravity 路径与代理例外，并拦截系统通知点击额外拉起的官方窗口。

本目录使用 npm 安装的 `@codexhost/cli@0.22.0`。外部 Harness 的临时和持久侧聊使用上游实现，沿用来源 Harness（原实验性 `sidechat-gpt.mjs` 已停用并移除）；Antigravity 历史读取在 `0.22.0` 已由上游改用原生 SQLite 读取（#908），原 `0.21.0` 专用的 `antigravity-replay.mjs` 补丁随之退役移除。[0.22.0 发布说明](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.22.0)

## 当前启用的运行时补丁

运行 `npm ci` 时会通过 `package.json` 的 `postinstall` 按序自动应用以下 4 个补丁脚本（支持 `--modules <目录>` 指定任意安装槽位，同时保留 `--next` 兼容）：

| 补丁脚本 | 修改目标 | 作用说明 |
| --- | --- | --- |
| `antigravity-usage.mjs` | `plugins/antigravity/manifest.json`、`plugin.mjs`、`host-runtime.mjs` | 补全 Antigravity 模型/缓存统计与新模型标签，补充工具参数、任务/搜索/读取展示与 `read_file` 提示 |
| `sidechat-sidebar.mjs` | `host-runtime.mjs`、`desktop-controller.mjs` | 压制持久侧边对话的 `thread/started` 广播避免误入左侧项目列表，并补全桥接层 `thread/fork` 归属登记 |
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

### 方式一：运行中安全预装与切换（推荐）

在 CodexHost 运行期间，更新 `package.json` 与 `package-lock.json` 后直接运行：

```powershell
npm run stage
npm run verify
```

`stage-codexhost.mjs` 会在独立目录 `.codexhost-staged/<version>/` 中执行原子 `npm ci --ignore-scripts`、顺序应用并幂等校验全部补丁、做语法检查与 `--version` 验证，完全不碰正在运行的进程与 `node_modules/`。下次重启 CodexHost 时（通过任意启动器关闭旧实例并启动），`resolve-codexhost.mjs` 会自动切换到匹配 `package.json` 的新版本。

### 方式二：停服后标准安装到 `node_modules/`

等任务结束并退出正在使用的 Desktop，若后台服务仍在运行可先正常停止：

```powershell
$env:CODEXHOST_DATA_DIR = Join-Path $PWD 'host-state\host'
& (node .\resolve-codexhost.mjs) stop
npm ci
npm run verify
```

当 `node_modules/` 中的版本与 `package.json` 一致时，启动器会优先使用标准 `node_modules/`，届时可以安全清理旧的 `.codexhost-staged/` 与 `node_modules/.codexhost-next/`。

### 回退到上一版本

从 `0.21.0` 升级到 `0.22.0` 期间，原有的 `0.21.0` 运行目录保留在 `node_modules/.codexhost-next/`，脚本与配置快照备份于 `backups/v0.21.0-20261119/`。如需回退，只需退出 Host 并将 `package.json` 中的 `@codexhost/cli` 版本改回 `0.21.0`（或恢复该备份目录中的脚本），重新启动即可切回 `0.21.0`。

修改补丁脚本后，可通过 `npm run stage`（针对暂存槽位）或对对应 `--modules` 目录重新应用补丁，并运行 `npm run verify` 确认补丁完整生效。

## 文件作用

| 文件 | 作用 |
| --- | --- |
| `Start-CodexHost.cmd` | 使用 `host-state/` 启动，迁移项目侧栏、执行历史同步并按锁定版本拉起 Host |
| `Start-CodexHost-Silent.vbs` | 隐藏终端启动，也为计划任务提供隐藏同步入口 |
| `Start-CodexHost-Trial.cmd` | 使用独立的 `trial-state/` 配置启动试用实例 |
| `resolve-codexhost.mjs` | 按 `package.json` 锁定版本解析可用 CLI 路径并校验补丁完整性 |
| `stage-codexhost.mjs` | 在 `.codexhost-staged/<version>/` 原子预装、打补丁并验证目标版本 |
| `codex-history.mjs` | 历史迁移、增量同步、项目与侧栏处理、Windows 同步计划任务 |
| `antigravity-usage.mjs` | 补全 Antigravity 用量、新模型标签、工具展示与大文件读取提示 |
| `sidechat-sidebar.mjs` | 避免持久侧边对话自动进入左侧项目聊天记录，并补全桥接层 `thread/fork` 登记 |
| `enabled-plugins.mjs` | 设置并验证 Host 插件白名单 |
| `renderer-performance.mjs` | 跳过隐藏的 Host 输入框提示控件的尺寸读取，减少强制样式重算 |
| `Watch-CodexToast.ps1` | 监听通知激活产生的新进程，按限定条件处理额外拉起的窗口 |
| `Undo-CodexToastWatcher.ps1` | 撤销通知守护改动，并删除守护脚本及自身 |
| `codex-official.ico` | 启动快捷方式使用的图标 |

`host-state/`、`trial-state/`、`backups/`、`.codexhost-staged/`、依赖和日志已由 `.gitignore` 排除。迁移生成的数据包含本机历史和配置，应保留在本机。
