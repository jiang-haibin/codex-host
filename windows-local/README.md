# CodexHost Windows 本机定制

## 我添加的功能

- **独立的数据目录与历史迁移**。将 Codex 历史、项目侧栏和部分 Harness 原生历史迁移到本目录的 `host-state/`，启动器统一使用该目录。
- **官方 Codex 与 Host 的历史同步**。支持增量导入、GPT 会话回写、并发写入检查和冲突报告，保留外部 Harness 的独立历史。可手动同步，也可安装每分钟运行的 Windows 计划任务。
- **Antigravity 用量补全**。从原生会话数据库和转录文件补全模型、缓存读取与缓存写入统计，兼容模型切换记录。
- **工具调用与文件修改展示**。补充 Antigravity 文件参数识别、编辑差异，以及任务管理、搜索、读取文件和命令执行的展示。
- **Windows 启动与通知适配**。提供普通启动、独立试用目录和静默启动入口，配置 WorkBuddy、Antigravity 路径与代理例外。通知守护脚本处理通知点击额外拉起官方窗口的问题。
- **GPT 临时侧聊补丁（实验性）**。外部 Harness 的主聊天可以创建使用 GPT 的临时侧聊，并传入有长度限制的参考上下文。已修正响应编号覆盖和桌面回复事件订阅问题，完整界面发送流程仍需加载补丁后验证。

本目录使用 npm 安装的 `@codexhost/cli@0.19.0`。上游源码和产品说明见 [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host)。

## 首次使用

适用于 Windows。需要 Node.js 24、官方 Codex Desktop，以及已有历史记录的 `%USERPROFILE%\.codex`。建议等运行中的任务结束并退出 Desktop 后迁移历史。

从完整源码仓库使用时，先进入 `windows-local`。在本机独立目录使用时，直接打开本目录的终端。

```powershell
node --disable-warning=ExperimentalWarning .\codex-history.mjs migrate
npm ci
.\Start-CodexHost.cmd
```

`migrate` 只用于首次初始化，已有 `host-state/` 时会拒绝覆盖。安装依赖时会自动运行两个补丁脚本。侧聊补丁需要先有 `host-state/codex/config.toml` 中配置的原生 GPT 模型，因此首次迁移应在 `npm ci` 前执行。

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

## 补丁更新与侧聊状态

修改补丁脚本后可重新应用。

```powershell
node .\antigravity-usage.mjs
node .\sidechat-gpt.mjs
```

补丁针对当前安装包的代码结构，升级 CodexHost 后需要重新核验。侧聊已通过原始请求编号保留、桌面连接创建归属和普通请求隔离的回归检查。使用临时父会话和真实 GPT 的独立协议测试已完成创建、上下文注入、发送、回复内容及完成事件的验证。用户界面此前出现过持续加载或一直显示“正在思考”，完整界面流程仍需重启加载补丁后验证。

应用运行时补丁需要完整重启 Host 服务。等任务结束后在本目录的独立 PowerShell 中执行，再按原方式启动。

```powershell
$env:CODEXHOST_DATA_DIR = Join-Path $PWD 'host-state\host'
.\node_modules\.bin\codexhost.cmd stop
.\Start-CodexHost.cmd
```

## 文件作用

| 文件 | 作用 |
| --- | --- |
| `Start-CodexHost.cmd` | 使用 `host-state/` 启动，迁移项目侧栏并执行一次历史同步 |
| `Start-CodexHost-Silent.vbs` | 隐藏终端启动，也为计划任务提供隐藏同步入口 |
| `Start-CodexHost-Trial.cmd` | 使用独立的 `trial-state/` 配置启动试用实例 |
| `codex-history.mjs` | 历史迁移、增量同步、项目与侧栏处理、Windows 同步计划任务 |
| `antigravity-usage.mjs` | 补全 Antigravity 用量，并修补工具与文件修改的展示 |
| `sidechat-gpt.mjs` | 将外部 Harness 的临时侧聊接到原生 GPT，应用创建与路由补丁 |
| `Watch-CodexToast.ps1` | 监听通知激活产生的新进程，按限定条件处理额外拉起的窗口 |
| `Undo-CodexToastWatcher.ps1` | 撤销通知守护改动，并删除守护脚本及自身 |
| `codex-official.ico` | 启动快捷方式使用的图标 |

`host-state/`、`trial-state/`、`backups/`、依赖和日志已由 `.gitignore` 排除。迁移生成的数据包含本机历史和配置，应保留在本机。
