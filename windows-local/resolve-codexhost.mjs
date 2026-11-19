import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENABLED_PLUGINS } from "./enabled-plugins.mjs";

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
    if (!runtimeSource.includes("codexhost-sidechat-sidebar-fix-v1")) {
      issues.push("host-runtime.mjs 缺少侧边对话 thread/started 过滤补丁");
    }
    if (!runtimeSource.includes('request.method === "thread/fork"')) {
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

  return { ok: issues.length === 0, issues };
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
    process.stdout.write(`${resolved.selected.cliCmd}\n`);
  }
}
