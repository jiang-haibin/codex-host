import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "codexhost-sidechat-sidebar-fix-v1";

const OLD_NOTIFY_STARTED = `  async #notifyExternalThreadStarted(thread3) {
    await this.#writer.json({
      method: "thread/started",
      emittedAtMs: Date.now(),
      params: { thread: { ...thread3, turns: [] } }
    });
  }`;

const NEW_NOTIFY_STARTED = `  async #notifyExternalThreadStarted(thread3) {
    // ${MARKER}: 持久侧边对话不应广播 thread/started（与官方 codex.exe 一致），避免前端误加入左侧项目列表。
    if (thread3?.attachedToThreadId) return;
    await this.#writer.json({
      method: "thread/started",
      emittedAtMs: Date.now(),
      params: { thread: { ...thread3, turns: [] } }
    });
  }`;

const OLD_OBSERVE_FORK =
  'if (request.method === "thread/start" || request.method === "thread/read" || request.method === "thread/resume") {';

const NEW_OBSERVE_FORK =
  'if (request.method === "thread/start" || request.method === "thread/fork" || request.method === "thread/read" || request.method === "thread/resume") {';

function replaceOnce(source, target, replacement, label) {
  const parts = source.split(target);
  if (parts.length !== 2) {
    throw new Error(`Unable to patch ${label}: expected one matching anchor (found ${parts.length - 1})`);
  }
  return source.replace(target, () => replacement);
}

export function patchHostRuntimeSideChatSource(source) {
  let result = source;
  if (!result.includes(MARKER)) {
    result = replaceOnce(result, OLD_NOTIFY_STARTED, NEW_NOTIFY_STARTED, "host-runtime.mjs #notifyExternalThreadStarted");
  }
  if (!result.includes(NEW_OBSERVE_FORK)) {
    result = replaceOnce(result, OLD_OBSERVE_FORK, NEW_OBSERVE_FORK, "host-runtime.mjs observeBridgeResult");
  }
  return result;
}

export function patchDesktopControllerSideChatSource(source) {
  if (source.includes(NEW_OBSERVE_FORK)) return source;
  return replaceOnce(source, OLD_OBSERVE_FORK, NEW_OBSERVE_FORK, "desktop-controller.mjs observeBridgeResult");
}

function resolveModulesUrl(argv) {
  const index = argv.indexOf("--modules");
  if (index !== -1) {
    const custom = argv[index + 1];
    if (!custom) throw new Error("Missing path after --modules");
    return pathToFileURL(`${resolve(custom).replace(/[\\/]+$/u, "")}/`);
  }
  const relative = argv.includes("--next") ? "./node_modules/.codexhost-next/node_modules/" : "./node_modules/";
  return new URL(relative, import.meta.url);
}

async function replaceFile(destination, contents) {
  const temporary = new URL(`${destination.href}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, contents);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function applySideChatSidebarPatch(modulesUrl) {
  const appRoot = new URL(`@codexhost/cli-${process.platform}-${process.arch}/app/`, modulesUrl);
  const targets = [
    [new URL("host-runtime.mjs", appRoot), patchHostRuntimeSideChatSource],
    [new URL("desktop-controller.mjs", appRoot), patchDesktopControllerSideChatSource],
  ];
  const prepared = await Promise.all(
    targets.map(async ([file, patch]) => {
      const original = await readFile(file, "utf8");
      return { file, original, patched: patch(original) };
    }),
  );
  let changed = false;
  for (const { file, original, patched } of prepared) {
    if (patched !== original) {
      await replaceFile(file, patched);
      changed = true;
    }
  }
  return { changed };
}

export async function pruneAttachedSideChatsFromCatalog(repoRoot = dirname(fileURLToPath(import.meta.url))) {
  const threadsDir = join(repoRoot, "host-state", "host", "mapping-store", "threads");
  const sqliteDir = join(repoRoot, "host-state", "codex", "sqlite");
  if (!existsSync(threadsDir) || !existsSync(sqliteDir)) {
    return { attachedCount: 0, removed: [] };
  }
  const attachedIds = [];
  for (const name of await readdir(threadsDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(threadsDir, name), "utf8"));
      if (typeof record?.attachedToThreadId === "string" && record.attachedToThreadId && typeof record?.hostThreadId === "string") {
        attachedIds.push(record.hostThreadId);
      }
    } catch {
    }
  }
  if (attachedIds.length === 0) {
    return { attachedCount: 0, removed: [] };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const removed = new Set();
  for (const dbName of ["codex.db", "codex-dev.db"]) {
    const dbPath = join(sqliteDir, dbName);
    if (!existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const hasTable = (table) => Boolean(
        db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table),
      );
      if (!hasTable("local_thread_catalog")) continue;
      db.exec("BEGIN IMMEDIATE");
      try {
        const removeCatalog = db.prepare("DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?");
        const removeScan = hasTable("local_thread_catalog_scan_entries")
          ? db.prepare("DELETE FROM local_thread_catalog_scan_entries WHERE host_id = 'local' AND thread_id = ?")
          : null;
        let revisionChanged = false;
        for (const id of attachedIds) {
          if (removeCatalog.run(id).changes > 0) {
            removed.add(id);
            revisionChanged = true;
          }
          if (removeScan && removeScan.run(id).changes > 0) {
            removed.add(id);
          }
        }
        if (revisionChanged && hasTable("local_thread_catalog_metadata")) {
          db.exec("UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1");
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }
  return { attachedCount: attachedIds.length, removed: [...removed] };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes("--prune-catalog")) {
    const pruned = await pruneAttachedSideChatsFromCatalog();
    console.log(JSON.stringify(pruned));
  } else {
    const modulesUrl = resolveModulesUrl(args);
    const result = await applySideChatSidebarPatch(modulesUrl);
    console.log(JSON.stringify(result));
  }
}
