import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENABLED_PLUGINS } from "./enabled-plugins.mjs";
import { CLASSIC_SHELL_PLATFORM, CLASSIC_SHELL_SHA256, sha256File } from "./classic-shell-theme.mjs";

export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PLATFORM_PACKAGE = `@codexhost/cli-${process.platform}-${process.arch}`;
export const CLI_BIN_NAME = process.platform === "win32" ? "codexhost.cmd" : "codexhost";

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

export function readTargetVersion(repoRoot = REPO_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const spec = pkg?.dependencies?.["@codexhost/cli"];
  if (typeof spec !== "string" || !spec.trim()) {
    throw new Error("package.json 缺少 dependencies[\"@codexhost/cli\"]");
  }
  return spec.trim().replace(/^[~^=v]+/u, "");
}

export function inspectInstallation(modulesDir, kind) {
  const cliPkg = readJsonIfExists(path.join(modulesDir, "@codexhost", "cli", "package.json"));
  const platformPkg = readJsonIfExists(path.join(modulesDir, PLATFORM_PACKAGE, "package.json"));
  const cliCmd = path.join(modulesDir, ".bin", CLI_BIN_NAME);
  const cliJs = path.join(modulesDir, "@codexhost", "cli", "bin", "codexhost.js");
  const hasBin = fs.existsSync(cliCmd) && fs.existsSync(cliJs);
  const cliVersion = cliPkg?.version ?? null;
  const platformVersion = platformPkg?.version ?? null;
  const version = cliVersion && cliVersion === platformVersion ? cliVersion : null;
  return {
    kind,
    modulesDir,
    cliCmd,
    cliJs,
    cliVersion,
    platformVersion,
    version,
    hasBin,
  };
}

export function listCandidates(targetVersion, repoRoot = REPO_ROOT) {
  return [
    inspectInstallation(path.join(repoRoot, "node_modules"), "node_modules"),
    inspectInstallation(path.join(repoRoot, ".codexhost-staged", targetVersion, "node_modules"), "staged"),
    inspectInstallation(path.join(repoRoot, "node_modules", ".codexhost-next", "node_modules"), "legacy-next"),
  ];
}

export function verifyInstalledPatches(modulesDir, repoRoot = REPO_ROOT) {
  const appRoot = path.join(modulesDir, PLATFORM_PACKAGE, "app");
  const issues = [];

  const manifestPath = path.join(appRoot, "plugins", "antigravity", "manifest.json");
  const manifest = readJsonIfExists(manifestPath);
  if (manifest?.entry !== "antigravity-usage.mjs") {
    issues.push(`antigravity/manifest.json entry 为 ${manifest?.entry ?? "缺失"}，预期为 antigravity-usage.mjs`);
  }

  const expectedUsage = fs.readFileSync(path.join(repoRoot, "antigravity-usage.mjs"), "utf8");
  const installedUsagePath = path.join(appRoot, "plugins", "antigravity", "antigravity-usage.mjs");
  if (!fs.existsSync(installedUsagePath) || fs.readFileSync(installedUsagePath, "utf8") !== expectedUsage) {
    issues.push("plugins/antigravity/antigravity-usage.mjs 缺失或与仓库版本不一致");
  }

  const pluginPath = path.join(appRoot, "plugins", "antigravity", "plugin.mjs");
  if (!fs.existsSync(pluginPath)) {
    issues.push("plugins/antigravity/plugin.mjs 缺失");
  } else {
    const pluginSource = fs.readFileSync(pluginPath, "utf8");
    if (!pluginSource.includes('if (compact === "managetask")')) {
      issues.push("plugin.mjs 缺少 manage_task/search_web 命令展示补丁");
    }
    if (!pluginSource.includes("codexhost-antigravity-read-file-instruction-v1")) {
      issues.push("plugin.mjs 缺少 read_file 大文件提示补丁");
    }
    if (!pluginSource.includes("codexhost-antigravity-permission-label-v1")) {
      issues.push("plugin.mjs 缺少完全访问按钮文案与样式补丁");
    }
  }

  const runtimePath = path.join(appRoot, "host-runtime.mjs");
  if (!fs.existsSync(runtimePath)) {
    issues.push("host-runtime.mjs 缺失");
  } else {
    const runtimeSource = fs.readFileSync(runtimePath, "utf8");
    if (!runtimeSource.includes("function toolCommandActions(")) {
      issues.push("host-runtime.mjs 缺少 toolCommandActions 补丁");
    }
    if (!runtimeSource.includes('nestedString(args, ["Target", "target"')) {
      issues.push("host-runtime.mjs 缺少 fileChangeFromTool PascalCase 补丁");
    }
    if (!runtimeSource.includes("commandActions: toolCommandActions(")) {
      issues.push("host-runtime.mjs 缺少 projectItem commandActions 补丁");
    }
    const hasUpstreamSideChatGuard =
      /async #notifyExternalThreadStarted\((thread\d*)\) \{\r?\n\s*if \(typeof \1\.attachedToThreadId === "string"\) return;/u.test(
        runtimeSource,
      );
    if (!runtimeSource.includes("codexhost-sidechat-sidebar-fix-v1") && !hasUpstreamSideChatGuard) {
      issues.push("host-runtime.mjs 缺少侧边对话 thread/started 过滤补丁");
    }
    if (runtimeSource.includes("observeBridgeResult") && !runtimeSource.includes('request.method === "thread/fork"')) {
      issues.push("host-runtime.mjs 缺少 observeBridgeResult thread/fork 归属登记补丁");
    }
  }

  const controllerPath = path.join(appRoot, "desktop-controller.mjs");
  if (!fs.existsSync(controllerPath)) {
    issues.push("desktop-controller.mjs 缺失");
  } else {
    const controllerSource = fs.readFileSync(controllerPath, "utf8");
    if (!controllerSource.includes('request.method === "thread/fork"')) {
      issues.push("desktop-controller.mjs 缺少 observeBridgeResult thread/fork 归属登记补丁");
    }
    if (
      controllerSource.includes("desktop-extensions-v1.json") &&
      !controllerSource.includes("codexhost-desktop-extensions-publish-dedup-v1")
    ) {
      issues.push("desktop-controller.mjs 缺少 desktop-extensions-v1.json 落盘去重补丁");
    }
  }

  const enabledPath = path.join(appRoot, "plugins", "enabled.json");
  const enabledJson = readJsonIfExists(enabledPath);
  const expectedEnabled = [...new Set(ENABLED_PLUGINS)];
  if (!Array.isArray(enabledJson?.enabled) || JSON.stringify(enabledJson.enabled) !== JSON.stringify(expectedEnabled)) {
    issues.push(`plugins/enabled.json 与本地白名单不一致: ${JSON.stringify(enabledJson?.enabled ?? null)}`);
  }

  const rendererPath = path.join(appRoot, "renderer-extension.js");
  if (!fs.existsSync(rendererPath)) {
    issues.push("renderer-extension.js 缺失");
  } else {
    const rendererSource = fs.readFileSync(rendererPath, "utf8");
    if (!rendererSource.includes('const visibility = visible && root.scrollWidth > root.clientWidth ? "hidden" : "visible";')) {
      issues.push("renderer-extension.js 缺少隐藏控件尺寸跳过补丁");
    }
  }

  if (`${process.platform}-${process.arch}` === CLASSIC_SHELL_PLATFORM) {
    const shellExePath = path.join(modulesDir, PLATFORM_PACKAGE, "libexec", "codexhost-shell.exe");
    if (fs.existsSync(shellExePath) && sha256File(shellExePath) !== CLASSIC_SHELL_SHA256) {
      issues.push("libexec/codexhost-shell.exe 未使用 0.25.1 简约风启动主题（SHA-256 不匹配）");
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * 在 Windows 上安全清理已失效或被系统进程复用的 local-host-runtime-owner-v1/owner，
 * 避免 upstream shim 读取高权限进程启动时间时因 ERROR_ACCESS_DENIED (os error 5) 退出。
 */
export function ensureLocalNodeBinary(repoRoot = REPO_ROOT) {
  if (process.platform !== "win32") return null;
  const localNodeDir = path.join(repoRoot, "host-state", "node");
  const localNodeExe = path.join(localNodeDir, "node.exe");
  const srcNodeExe = process.execPath;
  if (!srcNodeExe || !fs.existsSync(srcNodeExe)) return null;
  if (path.resolve(srcNodeExe).toLowerCase() === path.resolve(localNodeExe).toLowerCase()) {
    return localNodeExe;
  }
  try {
    fs.mkdirSync(localNodeDir, { recursive: true });
    const srcStat = fs.statSync(srcNodeExe);
    const dstStat = fs.existsSync(localNodeExe) ? fs.statSync(localNodeExe) : null;
    if (!dstStat || dstStat.size !== srcStat.size || Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) > 1000) {
      fs.copyFileSync(srcNodeExe, localNodeExe);
      fs.utimesSync(localNodeExe, srcStat.atime, srcStat.mtime);
    }
    const srcNpmDir = path.join(path.dirname(srcNodeExe), "node_modules", "npm");
    const dstNpmParent = path.join(localNodeDir, "node_modules");
    const dstNpmDir = path.join(dstNpmParent, "npm");
    if (fs.existsSync(srcNpmDir) && !fs.existsSync(path.join(dstNpmDir, "bin", "npm-cli.js"))) {
      fs.mkdirSync(dstNpmParent, { recursive: true });
      fs.rmSync(dstNpmDir, { recursive: true, force: true });
      fs.symlinkSync(srcNpmDir, dstNpmDir, "junction");
    }
    return localNodeExe;
  } catch {
    return null;
  }
}

export function pruneStaleLocalOwner(dataDir = process.env.CODEXHOST_DATA_DIR) {
  ensureLocalNodeBinary();
  if (process.platform !== "win32") {
    return { pruned: false, reason: "non-win32" };
  }
  if (!dataDir) {
    return { pruned: false, reason: "no-data-dir" };
  }
  const ownerPath = path.join(dataDir, "local-host-runtime-owner-v1", "owner");
  if (!fs.existsSync(ownerPath)) {
    return { pruned: false, reason: "no-owner" };
  }
  const raw = fs.readFileSync(ownerPath, "utf8");
  const pidMatch = /^process_id=(\d+)\s*$/mu.exec(raw);
  const pid = pidMatch ? Number(pidMatch[1]) : 0;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { pruned: false, reason: "unparseable" };
  }

  const result = spawnSync("tasklist.exe", ["/NH", "/FO", "CSV", "/FI", `PID eq ${pid}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return { pruned: false, reason: "tasklist-failed", pid };
  }

  let imageName = null;
  for (const line of String(result.stdout ?? "").split(/\r?\n/u)) {
    const m = /^"([^"]+)","(\d+)"/u.exec(line.trim());
    if (m && Number(m[2]) === pid) {
      imageName = m[1];
      break;
    }
  }
  if (!imageName) {
    fs.rmSync(ownerPath, { force: true });
    return { pruned: true, reason: "pid-missing", pid };
  }
  if (imageName.toLowerCase() !== "codexhost-shim.exe") {
    fs.rmSync(ownerPath, { force: true });
    return { pruned: true, reason: "pid-reused", pid, imageName };
  }
  return { pruned: false, reason: "live-shim", pid, imageName };
}

export function resolveCodexHost(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const targetVersion = options.targetVersion ?? readTargetVersion(repoRoot);
  const override = options.override ?? process.env.CODEXHOST_CLI_OVERRIDE;
  if (override) {
    const resolved = path.resolve(override);
    if (!fs.existsSync(resolved)) {
      throw new Error(`CODEXHOST_CLI_OVERRIDE 指向的文件不存在: ${resolved}`);
    }
    return {
      targetVersion,
      selected: { kind: "override", cliCmd: resolved, version: targetVersion, modulesDir: null, hasBin: true },
      candidates: [],
    };
  }

  const candidates = listCandidates(targetVersion, repoRoot);
  const selected = candidates.find((item) => item.hasBin && item.version === targetVersion) ?? null;
  return { targetVersion, selected, candidates };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const pruneIdx = args.indexOf("--prune-stale-owner");
  if (pruneIdx !== -1) {
    const nextArg = args[pruneIdx + 1];
    const dataDir = nextArg && !nextArg.startsWith("--") ? nextArg : process.env.CODEXHOST_DATA_DIR;
    console.log(JSON.stringify(pruneStaleLocalOwner(dataDir)));
    process.exit(0);
  }
  const verIdx = args.indexOf("--version");
  const targetVersion = verIdx !== -1 ? args[verIdx + 1] : undefined;
  const isCheck = args.includes("--check");
  const isInfo = args.includes("--info") || isCheck;

  const resolved = resolveCodexHost({ targetVersion });
  const patches = resolved.selected?.modulesDir
    ? verifyInstalledPatches(resolved.selected.modulesDir)
    : null;

  if (isInfo) {
    const summary = {
      targetVersion: resolved.targetVersion,
      selected: resolved.selected,
      patches,
      candidates: resolved.candidates.map(({ kind, version, cliVersion, platformVersion, hasBin, modulesDir }) => ({
        kind,
        version,
        cliVersion,
        platformVersion,
        hasBin,
        modulesDir,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!resolved.selected || (isCheck && patches && !patches.ok)) {
      process.exit(1);
    }
  } else {
    if (!resolved.selected) {
      const seen = resolved.candidates
        .map((c) => `${c.kind}=${c.version ?? (c.cliVersion ? `cli:${c.cliVersion}/plat:${c.platformVersion}` : "missing")}`)
        .join(", ");
      console.error(
        `CodexHost ${resolved.targetVersion} is not installed yet (${seen}). ` +
        `Run "node stage-codexhost.mjs" (safe while running) or "npm ci" (after stopping CodexHost).`,
      );
      process.exit(1);
    }
    if (patches && !patches.ok && resolved.selected.kind === "staged") {
      const repair = spawnSync(process.execPath, [path.join(REPO_ROOT, "stage-codexhost.mjs")], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (repair.status !== 0) {
        const detail = [repair.stdout, repair.stderr].filter(Boolean).join("\n").trim();
        console.error(`Failed to auto-repair staged CodexHost ${resolved.targetVersion}:\n${detail}`);
        process.exit(repair.status ?? 1);
      }
    }
    process.stdout.write(`${resolved.selected.cliCmd}\n`);
  }
}
