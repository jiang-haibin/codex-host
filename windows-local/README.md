# CodexHost Windows 本机定制

## 我添加的功能

- **独立的数据目录与历史迁移**。将 Codex 历史、项目侧栏和部分 Harness 原生历史迁移到本目录的 `host-state/`，启动器统一使用该目录。
- **官方 Codex 与 Host 的历史同步**。支持增量导入、GPT 会话回写、并发写入检查和冲突报告，保留外部 Harness 的独立历史。可手动同步，也可安装每分钟运行的 Windows 计划任务。
- **Antigravity 用量与模型补全**（`antigravity-usage.mjs`）。优先使用上游统计，从原生会话数据库和转录文件补全缺失的模型与缓存统计，补充模型切换及新模型标签识别（含 `Gemini 4 Neon`、`Gemini 4 Carbon`、`Orchestrator (Neon/Carbon/Argon)` 等）。
- **工具调用与文件修改展示**（`antigravity-usage.mjs`）。沿用 ACP 原生差异，修补 `plugins/antigravity/plugin.mjs` 与 `host-runtime.mjs` 补充 PascalCase 参数、`manage_task`、`search_web`、读取文件与命令执行的展示，补充大文件先搜索后读取的 `read_file` 提示，并将 `dangerously-skip-permissions` 权限按钮样式与文案调整为中性样式和“完全访问”（完整保留 `0.26.0` 新会话默认跳过权限确认的 `defaultModeId`）。
- **持久侧边对话侧栏隔离与桌面扩展状态落盘去重**（`sidechat-sidebar.mjs`）。在 `0.25.1+`（上游 #1052 已于 `host-runtime.mjs` 原生拦截带 `attachedToThreadId` 的 `thread/started` 广播）中自动识别上游内置修复并跳过 `host-runtime.mjs` 改写，保留对 `desktop-controller.mjs` 桥接层 `observeBridgeResult` 的 `thread/fork` 归属登记补丁（旧版 `0.24.0` / `0.22.0` 仍兼容修补两处）；同时对 `0.24.0` 起新增的 `RendererDesktopExtensions.#publish()` 补充按有效载荷（`controllerPid`、`targetId`、`extensions`、`surfaces`）去重，消除每 5 秒创建 `.tmp` 并覆写 `desktop-extensions-v1.json` 的高频磁盘写入循环，避免触发卡巴斯基等杀毒软件的 `PDM` 行为拦截；另提供 `node --disable-warning=ExperimentalWarning .\sidechat-sidebar.mjs --prune-catalog` 清理 `host-state/codex/sqlite/codex.db` 中此前残留的侧栏缓存行。
- **本机插件白名单**（`enabled-plugins.mjs`）。写入并验证 `plugins/enabled.json`，启用 `antigravity`、`workbuddy` 与 `codex-usage`。
- **渲染器性能优化**（`renderer-performance.mjs`）。修补 `renderer-extension.js`，跳过对隐藏的 Host 输入框提示控件读取几何尺寸，减少强制样式重算。
- **无项目新聊天落点收进 Host 数据目录**（`projectless-workspace.mjs`）。修补 `host-runtime.mjs` 的 `allocateProjectlessWorkspace`，未选项目的新聊天默认工作区由 `%USERPROFILE%\Documents\Codex\<日期>\<标题>` 改为 `%CODEXHOST_DATA_DIR%\workspaces\<日期>\<标题>`（即 `host-state/host/workspaces/`），对话正文与产物都留在 Host 数据目录；环境变量缺失时保留上游默认路径，显式选择项目目录的行为不变。
- **简约风桌面壳启动主题保留**（`classic-shell-theme.mjs`）。在保留 `0.27.0` 全部后端服务与新版主界面的前提下，按官方 SHA-256 校验将 `libexec/codexhost-shell.exe` 替换为 `0.25.1` 原版简约风桌面壳（优先复用本地 `0.25.1` 槽位并缓存至 `host-state/shell-theme/`，兜底从官方 npm 包提取；支持在 Windows 运行中通过同卷重命名无感替换；注：如需启用 `0.27.0` 原生桌面壳新增的 50%–200% 统一缩放、语音输入或全新海湾水獭主题，可移除该补丁后重装或切回官方壳）。
- **自带客户端对话删除功能**（`session-delete.mjs`）。在 `host-runtime.mjs` 开放客户端通道的 `thread/delete` 路由（兼容官方 Codex 与外部 Harness，自动联动清理挂载的侧边对话与树状态，采用动态变量匹配与自包含对象判断以屏蔽跨版本打包重命名），在 `web-modules/server.mjs` 提供 `codexhost/deleteSession` RPC、实时 `thread/deleted` 同步与防复活目录过滤，并在 `web/plugins/deepseek-ai__dsh-client-ui-codexhost/client.js`（采用动态标识符匹配，兼容跨版本重打包）向侧栏会话右键/更多菜单补充带二次确认弹窗的“删除会话”入口（支持活跃、已归档和空白草稿会话，删除当前会话后自动清空主视图）。
- **版本化安全更新、防误杀自愈与零锁冲突切换**（`resolve-codexhost.mjs`、`stage-codexhost.mjs`）。三个启动器统一按 `package.json` 锁定版本解析 CLI（优先标准 `node_modules/`，其次根目录 `.codexhost-staged/<version>/`，兼容旧 `node_modules/.codexhost-next/`），在启动前通过 `resolve-codexhost.mjs --prune-stale-owner` 清理已退出或被系统服务复用的陈旧 `local-host-runtime-owner-v1/owner` 租约记录，避免运行中 Windows 文件锁冲突、误启动旧版或 `os error 5` 启动阻断；同时自动将系统 `node.exe` 同步至本目录排除范围内的 `host-state/node/node.exe`（附 `node_modules/npm` 目录联接）并在启动器中置顶到 `PATH`，使运行 `desktop-controller.mjs` 的进程映像同样位于本目录排除路径内；若杀毒软件误隔离 `app/` 下的核心脚本（如 `desktop-controller.mjs`），启动解析会自动调用 `stage-codexhost.mjs` 从官方 tarball 原地恢复缺失脚本并重打补丁，无需替换运行中锁定的 `.exe`。
- **Windows 启动与通知适配**（`Start-CodexHost*`、`Watch-CodexToast.ps1` / `Undo-CodexToastWatcher.ps1`）。提供普通启动、独立试用目录和静默启动入口，启动前统一检测并清理旧的 `ChatGPT.exe`、`codexhost.exe` 与原生桌面壳 `codexhost-shell.exe`，配置 WorkBuddy、Antigravity 路径与代理例外，并拦截系统通知点击额外拉起的官方窗口。

本目录使用 npm 安装的 `@codexhost/cli@0.27.0`。本次由 `0.26.1` 升级至 `0.27.0`，带来跨 Harness 上下文交接、分段思考摘要预览、跨主机远端委派、Web 工作区与原生 Codex 项目双向同步、Codex 风格审批卡片、Antigravity 原生同轮 Steer 与精准上下文占比投影，以及大列表场景下的显著性能与内存优化；外部 Harness 的临时和持久侧聊使用上游实现，沿用来源 Harness（原实验性 `sidechat-gpt.mjs` 与 `0.21.0` 专用的 `antigravity-replay.mjs` 均已退役移除）。[0.27.0 发布说明](https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.27.0)

## 当前启用的运行时补丁

运行 `npm ci` 时会通过 `package.json` 的 `postinstall` 按序自动应用以下 7 个补丁脚本（支持 `--modules <目录>` 指定任意安装槽位，同时保留 `--next` 兼容）：

| 补丁脚本 | 修改目标 | 作用说明 |
| --- | --- | --- |
| `antigravity-usage.mjs` | `plugins/antigravity/manifest.json`、`plugin.mjs`、`host-runtime.mjs` | 补全 Antigravity 模型/缓存统计与新模型标签，补充工具参数、任务/搜索/读取展示、`read_file` 提示及“完全访问”权限按钮样式文案 |
| `sidechat-sidebar.mjs` | `desktop-controller.mjs`（旧版含 `host-runtime.mjs`） | `0.25.1` 起自动识别上游 #1052 的 `host-runtime.mjs` 过滤并保留 `desktop-controller.mjs` 桥接层 `thread/fork` 归属登记与 `RendererDesktopExtensions.#publish` 落盘去重（兼容 `0.24.0` / `0.22.0`），附 `--prune-catalog` 清理工具 |
| `enabled-plugins.mjs` | `plugins/enabled.json` | 锁定仅启用 `antigravity`、`workbuddy`、`codex-usage` |
| `renderer-performance.mjs` | `renderer-extension.js` | 隐藏提示控件时跳过 `scrollWidth/clientWidth` 读取 |
| `projectless-workspace.mjs` | `host-runtime.mjs` | 无项目新聊天默认工作区改到 `%CODEXHOST_DATA_DIR%\workspaces`，产物不再落入 `Documents\Codex` |
| `classic-shell-theme.mjs` | `libexec/codexhost-shell.exe` | 按官方 SHA-256 校验保留 `0.25.1` 简约风启动选择页与加载页主题（不影响 `0.27.0` 主界面与后端） |
| `session-delete.mjs` | `host-runtime.mjs`、`web-modules/server.mjs`、`web/plugins/deepseek-ai__dsh-client-ui-codexhost/client.js` | 为自带客户端补齐对话永久删除（菜单入口、二次确认弹窗、自动清理侧聊与目录防复活） |

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

双方同时修改产生的冲突只报告、不自动合并。确认以官方 Codex 版本为准后，执行 `node --disable-warning=ExperimentalWarning .\codex-history.mjs resolve <会话id> [...]` 用官方副本覆盖 Host 副本；覆盖前 Host 副本与其数据库行备份在 `backups/conflict-resolve-*/`，会话仍在写入时会拒绝执行。

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

从 `0.26.1` 升级到 `0.27.0` 期间，原有的 `0.26.1` 运行目录保留在 `.codexhost-staged/0.26.1/`，脚本与配置快照备份于 `backups/v0.26.1-20261126/`（更早的 `0.26.0`、`0.25.1`、`0.24.0` 与 `0.22.0` 槽位与备份亦保留）。如需回退，只需退出 Host 并将 `package.json` 中的 `@codexhost/cli` 版本改回 `0.26.1`（或恢复该备份目录中的脚本），重新启动即可切回 `0.26.1`。

修改补丁脚本后，可通过 `npm run stage`（针对暂存槽位）或对对应 `--modules` 目录重新应用补丁，并运行 `npm run verify` 确认补丁完整生效。当前 7 个补丁已全面适配 `0.27.0`，并保持对 `0.26.1` 的向后兼容。

## 文件作用

| 文件 | 作用 |
| --- | --- |
| `Start-CodexHost.cmd` | 使用 `host-state/` 启动，迁移项目侧栏、执行历史同步、优先置顶本地 `host-state/node` 并按锁定版本拉起 Host（支持检测清理 `codexhost-shell.exe`） |
| `Start-CodexHost-Silent.vbs` | 隐藏终端启动，也为计划任务提供隐藏同步入口 |
| `Start-CodexHost-Trial.cmd` | 使用独立的 `trial-state/` 配置启动试用实例 |
| `resolve-codexhost.mjs` | 按 `package.json` 锁定版本解析可用 CLI 路径、校验补丁并在缺失时静默自愈、同步本地 `host-state/node/node.exe` 副本，以及安全清理陈旧 `owner` 租约 |
| `stage-codexhost.mjs` | 在 `.codexhost-staged/<version>/` 原子预装、补齐被杀软误删的 `app/` 脚本、打补丁并验证目标版本 |
| `codex-history.mjs` | 历史迁移、增量同步、项目与侧栏处理、Windows 同步计划任务 |
| `antigravity-usage.mjs` | 补全 Antigravity 用量、新模型标签、工具展示、大文件读取提示与“完全访问”权限按钮样式文案 |
| `sidechat-sidebar.mjs` | 补全桥接层 `thread/fork` 归属登记与 `desktop-extensions-v1.json` 落盘去重（旧版同步过滤 `thread/started` 广播），并支持 `--prune-catalog` 清理历史侧栏缓存 |
| `enabled-plugins.mjs` | 设置并验证 Host 插件白名单 |
| `renderer-performance.mjs` | 跳过隐藏的 Host 输入框提示控件的尺寸读取，减少强制样式重算 |
| `projectless-workspace.mjs` | 将无项目新聊天的默认工作区根目录改为 Host 数据目录下的 `workspaces/` |
| `classic-shell-theme.mjs` | 按官方 SHA-256 校验保留 `0.25.1` 简约风桌面壳启动主题 |
| `session-delete.mjs` | 为 CodexHost 自带客户端补齐“删除会话”菜单项、二次确认弹窗与前后端 `thread/delete` 清理链路 |
| `Watch-CodexToast.ps1` | 监听通知激活产生的新进程，按限定条件处理额外拉起的窗口 |
| `Undo-CodexToastWatcher.ps1` | 撤销通知守护改动，并删除守护脚本及自身 |
| `codex-official.ico` | 启动快捷方式使用的图标 |

`host-state/`、`trial-state/`、`backups/`、`.codexhost-staged/`、依赖和日志已由 `.gitignore` 排除。迁移生成的数据包含本机历史和配置，应保留在本机。
