import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CLASSIC_SHELL_VERSION = "0.25.1";
export const CLASSIC_SHELL_PLATFORM = "win32-x64";
export const CLASSIC_SHELL_SHA256 =
  "caec766cd38a6d2e9ee64be94e05d157b362954b88cff7673b6090db4745a01e";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

export function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

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

function resolveModulesDir(argv) {
  const index = argv.indexOf("--modules");
  if (index !== -1) {
    const custom = argv[index + 1];
    if (!custom) throw new Error("Missing path after --modules");
    return path.resolve(custom);
  }
  if (argv.includes("--next")) {
    return path.join(REPO_ROOT, "node_modules", ".codexhost-next", "node_modules");
  }
  return path.join(REPO_ROOT, "node_modules");
}

function ensureClassicShellBinary(repoRoot = REPO_ROOT) {
  const cacheDir = path.join(repoRoot, "host-state", "shell-theme");
  const cacheFile = path.join(cacheDir, `codexhost-shell-${CLASSIC_SHELL_VERSION}.exe`);
  if (fs.existsSync(cacheFile) && sha256File(cacheFile) === CLASSIC_SHELL_SHA256) {
    return cacheFile;
  }

  // 优先复用本机已保留的 0.25.1 暂存槽位中的官方二进制，避免重复联网下载。
  const stagedSource = path.join(
    repoRoot,
    ".codexhost-staged",
    CLASSIC_SHELL_VERSION,
    "node_modules",
    `@codexhost/cli-${CLASSIC_SHELL_PLATFORM}`,
    "libexec",
    "codexhost-shell.exe",
  );
  if (fs.existsSync(stagedSource) && sha256File(stagedSource) === CLASSIC_SHELL_SHA256) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmpCache = `${cacheFile}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(stagedSource, tmpCache);
      fs.renameSync(tmpCache, cacheFile);
    } finally {
      fs.rmSync(tmpCache, { force: true });
    }
    return cacheFile;
  }

  // 兜底从官方 npm 包提取并严格校验 SHA-256。
  fs.mkdirSync(cacheDir, { recursive: true });
  const unpackDir = path.join(cacheDir, `.unpack-${CLASSIC_SHELL_VERSION}-${process.pid}`);
  fs.rmSync(unpackDir, { recursive: true, force: true });
  fs.mkdirSync(unpackDir, { recursive: true });
  try {
    const spec = `@codexhost/cli-${CLASSIC_SHELL_PLATFORM}@${CLASSIC_SHELL_VERSION}`;
    const packRes =
      process.platform === "win32"
        ? runOrThrow(process.env.ComSpec || "cmd.exe", ["/d", "/c", "npm", "pack", spec, "--quiet"], {
            cwd: unpackDir,
          })
        : runOrThrow("npm", ["pack", spec, "--quiet"], { cwd: unpackDir });
    const tgzName =
      String(packRes.stdout ?? "")
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .pop() || fs.readdirSync(unpackDir).find((name) => name.endsWith(".tgz"));
    if (!tgzName) {
      throw new Error(`npm pack ${spec} 未生成 tarball`);
    }
    runOrThrow("tar", ["-xzf", path.join(unpackDir, tgzName), "-C", unpackDir], { cwd: unpackDir });

    const extracted = path.join(unpackDir, "package", "libexec", "codexhost-shell.exe");
    if (!fs.existsSync(extracted)) {
      throw new Error(`官方包 ${spec} 中未找到 package/libexec/codexhost-shell.exe`);
    }
    const actualHash = sha256File(extracted);
    if (actualHash !== CLASSIC_SHELL_SHA256) {
      throw new Error(
        `官方 ${spec} codexhost-shell.exe SHA-256 校验失败: 实际 ${actualHash}，预期 ${CLASSIC_SHELL_SHA256}`,
      );
    }
    const tmpCache = `${cacheFile}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(extracted, tmpCache);
      fs.renameSync(tmpCache, cacheFile);
    } finally {
      fs.rmSync(tmpCache, { force: true });
    }
    return cacheFile;
  } finally {
    fs.rmSync(unpackDir, { recursive: true, force: true });
  }
}

function cleanupStaleReplacedBinaries(libexecDir) {
  for (const name of fs.readdirSync(libexecDir)) {
    if (!/^codexhost-shell\.exe\.replaced\.\d+\.old$/u.test(name)) continue;
    try {
      fs.rmSync(path.join(libexecDir, name), { force: true });
    } catch {
      // 旧实例尚未退出时仍被占用，留待下次清理。
    }
  }
}

function replaceExecutableSafely(sourcePath, destPath) {
  const libexecDir = path.dirname(destPath);
  cleanupStaleReplacedBinaries(libexecDir);
  const tmpDest = `${destPath}.${process.pid}.tmp`;
  fs.copyFileSync(sourcePath, tmpDest);
  try {
    try {
      fs.renameSync(tmpDest, destPath);
      return { displacedRunningBinary: false };
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) {
        throw error;
      }
      // Windows 允许在同一卷内重命名运行中的 .exe，不影响当前已启动进程，下次重启即生效。
      const displaced = path.join(libexecDir, `codexhost-shell.exe.replaced.${process.pid}.old`);
      fs.renameSync(destPath, displaced);
      try {
        fs.renameSync(tmpDest, destPath);
      } catch (renameErr) {
        if (!fs.existsSync(destPath) && fs.existsSync(displaced)) {
          fs.renameSync(displaced, destPath);
        }
        throw renameErr;
      }
      try {
        fs.rmSync(displaced, { force: true });
      } catch {
        // 当前窗口仍在使用旧映像，退出后下次会自动清理。
      }
      return { displacedRunningBinary: true };
    }
  } finally {
    fs.rmSync(tmpDest, { force: true });
  }
}

export function applyClassicShellTheme(modulesDir, repoRoot = REPO_ROOT) {
  const platformKey = `${process.platform}-${process.arch}`;
  if (platformKey !== CLASSIC_SHELL_PLATFORM) {
    return { changed: false, skipped: `unsupported-platform:${platformKey}` };
  }
  const destPath = path.join(
    modulesDir,
    `@codexhost/cli-${platformKey}`,
    "libexec",
    "codexhost-shell.exe",
  );
  if (!fs.existsSync(destPath)) {
    return { changed: false, skipped: "no-desktop-shell" };
  }
  cleanupStaleReplacedBinaries(path.dirname(destPath));
  if (sha256File(destPath) === CLASSIC_SHELL_SHA256) {
    return { changed: false, version: CLASSIC_SHELL_VERSION, sha256: CLASSIC_SHELL_SHA256 };
  }
  const sourcePath = ensureClassicShellBinary(repoRoot);
  const { displacedRunningBinary } = replaceExecutableSafely(sourcePath, destPath);
  if (sha256File(destPath) !== CLASSIC_SHELL_SHA256) {
    throw new Error("替换后 codexhost-shell.exe SHA-256 校验失败");
  }
  return {
    changed: true,
    version: CLASSIC_SHELL_VERSION,
    sha256: CLASSIC_SHELL_SHA256,
    displacedRunningBinary,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const modulesDir = resolveModulesDir(process.argv.slice(2));
  const result = applyClassicShellTheme(modulesDir);
  console.log(JSON.stringify(result));
}
