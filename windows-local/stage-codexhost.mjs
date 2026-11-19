import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLATFORM_PACKAGE,
  REPO_ROOT,
  inspectInstallation,
  readTargetVersion,
  verifyInstalledPatches,
} from "./resolve-codexhost.mjs";

const PATCH_SCRIPTS = [
  "antigravity-usage.mjs",
  "sidechat-sidebar.mjs",
  "enabled-plugins.mjs",
  "renderer-performance.mjs",
];

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(" ")}\n${detail}`);
  }
  return result;
}

function readLockedVersion(repoRoot = REPO_ROOT) {
  const lockPath = path.join(repoRoot, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const rootSpec = lock?.packages?.[""]?.dependencies?.["@codexhost/cli"];
  const pkgVersion = lock?.packages?.["node_modules/@codexhost/cli"]?.version;
  const platVersion = lock?.packages?.[`node_modules/${PLATFORM_PACKAGE}`]?.version;
  if (!pkgVersion || pkgVersion !== platVersion || (rootSpec && rootSpec.replace(/^[~^=v]+/u, "") !== pkgVersion)) {
    throw new Error(
      `package-lock.json 版本不一致: root=${rootSpec ?? "missing"}, cli=${pkgVersion ?? "missing"}, ${PLATFORM_PACKAGE}=${platVersion ?? "missing"}`,
    );
  }
  return pkgVersion;
}

function applyAllPatches(modulesDir, repoRoot = REPO_ROOT) {
  for (const script of PATCH_SCRIPTS) {
    runOrThrow(process.execPath, [path.join(repoRoot, script), "--modules", modulesDir], { cwd: repoRoot });
  }
  // 再次执行验证幂等性
  for (const script of PATCH_SCRIPTS) {
    runOrThrow(process.execPath, [path.join(repoRoot, script), "--modules", modulesDir], { cwd: repoRoot });
  }
}

function syntaxCheckInstalled(modulesDir) {
  const appRoot = path.join(modulesDir, PLATFORM_PACKAGE, "app");
  const files = [
    path.join(appRoot, "plugins", "antigravity", "plugin.mjs"),
    path.join(appRoot, "plugins", "antigravity", "antigravity-usage.mjs"),
    path.join(appRoot, "host-runtime.mjs"),
    path.join(appRoot, "desktop-controller.mjs"),
    path.join(appRoot, "renderer-extension.js"),
  ];
  for (const file of files) {
    runOrThrow(process.execPath, ["--check", file]);
  }
}

function verifyCliVersion(modulesDir, expectedVersion) {
  const cliJs = path.join(modulesDir, "@codexhost", "cli", "bin", "codexhost.js");
  const res = runOrThrow(process.execPath, [cliJs, "--version"]);
  const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  if (!output.includes(expectedVersion)) {
    throw new Error(`codexhost --version 输出未包含 ${expectedVersion}: ${output}`);
  }
  return output;
}

export function stageCodexHost(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const force = Boolean(options.force);
  const targetVersion = readTargetVersion(repoRoot);
  const lockedVersion = readLockedVersion(repoRoot);
  if (targetVersion !== lockedVersion) {
    throw new Error(`package.json (${targetVersion}) 与 package-lock.json (${lockedVersion}) 版本不一致，请先同步锁文件`);
  }

  const stagedRoot = path.join(repoRoot, ".codexhost-staged");
  const finalDir = path.join(stagedRoot, targetVersion);
  const finalModules = path.join(finalDir, "node_modules");

  // 如果该版本已存在于暂存槽位且未要求 --force，直接校验并原地幂等刷新补丁。
  if (!force && fs.existsSync(finalModules)) {
    const existing = inspectInstallation(finalModules, "staged");
    if (existing.hasBin && existing.version === targetVersion) {
      applyAllPatches(finalModules, repoRoot);
      syntaxCheckInstalled(finalModules);
      const patches = verifyInstalledPatches(finalModules, repoRoot);
      if (!patches.ok) {
        throw new Error(`补丁校验失败:\n- ${patches.issues.join("\n- ")}`);
      }
      const versionOutput = verifyCliVersion(finalModules, targetVersion);
      return {
        action: "verified-existing",
        version: targetVersion,
        stagedDir: finalDir,
        cliCmd: existing.cliCmd,
        versionOutput,
      };
    }
  }

  fs.mkdirSync(stagedRoot, { recursive: true });
  const tmpDir = path.join(stagedRoot, `.tmp-${targetVersion}-${process.pid}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const stagedPkg = {
      name: rootPkg.name ?? "codexhost-staged",
      private: true,
      dependencies: {
        "@codexhost/cli": targetVersion,
      },
    };
    fs.writeFileSync(path.join(tmpDir, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);
    fs.copyFileSync(path.join(repoRoot, "package-lock.json"), path.join(tmpDir, "package-lock.json"));

    if (process.platform === "win32") {
      runOrThrow(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/c", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: tmpDir },
      );
    } else {
      runOrThrow("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tmpDir });
    }

    const tmpModules = path.join(tmpDir, "node_modules");
    const installed = inspectInstallation(tmpModules, "staged");
    if (!installed.hasBin || installed.version !== targetVersion) {
      throw new Error(`暂存安装版本异常: 预期 ${targetVersion}，实际 ${installed.version ?? "unknown"}`);
    }

    applyAllPatches(tmpModules, repoRoot);
    syntaxCheckInstalled(tmpModules);
    const patches = verifyInstalledPatches(tmpModules, repoRoot);
    if (!patches.ok) {
      throw new Error(`暂存目录补丁校验失败:\n- ${patches.issues.join("\n- ")}`);
    }
    const versionOutput = verifyCliVersion(tmpModules, targetVersion);

    let backupOld = null;
    if (fs.existsSync(finalDir)) {
      backupOld = path.join(stagedRoot, `.old-${targetVersion}-${process.pid}`);
      try {
        fs.renameSync(finalDir, backupOld);
      } catch (error) {
        throw new Error(
          `无法替换已有暂存目录 ${finalDir}（可能正被运行中的 CodexHost 锁定）: ${error.message}`,
        );
      }
    }
    try {
      fs.renameSync(tmpDir, finalDir);
    } catch (error) {
      if (backupOld && fs.existsSync(backupOld) && !fs.existsSync(finalDir)) {
        fs.renameSync(backupOld, finalDir);
      }
      throw error;
    }
    if (backupOld && fs.existsSync(backupOld)) {
      fs.rmSync(backupOld, { recursive: true, force: true });
    }

    const finalInfo = inspectInstallation(finalModules, "staged");
    return {
      action: "staged",
      version: targetVersion,
      stagedDir: finalDir,
      cliCmd: finalInfo.cliCmd,
      versionOutput,
    };
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const force = process.argv.includes("--force");
  const result = stageCodexHost({ force });
  console.log(JSON.stringify(result, null, 2));
}
