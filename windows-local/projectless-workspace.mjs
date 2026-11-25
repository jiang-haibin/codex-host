import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PROJECTLESS_WORKSPACE_MARKER = "codexhost-projectless-workspace-v1";

// The bundled path module alias changes between versions (path37, path44, ...).
const workspaceRootPattern = /const workspaceRoot = options\.root \?\? ([A-Za-z_$][\w$]*)\.join\(home, "Documents", "Codex"\);/u;

// Keep files created by projectless new chats inside the Host data directory.
export function patchProjectlessWorkspaceSource(source) {
  if (source.includes(PROJECTLESS_WORKSPACE_MARKER)) return source;
  const matches = [...source.matchAll(new RegExp(workspaceRootPattern.source, "gu"))];
  if (matches.length !== 1) {
    throw new Error("Projectless workspace patch needs review: missing or ambiguous default workspace root");
  }
  return source.replace(workspaceRootPattern, (match, pathModule) => `const workspaceRoot = options.root ?? (environment.CODEXHOST_DATA_DIR
    ? ${pathModule}.join(environment.CODEXHOST_DATA_DIR, "workspaces")
    : ${pathModule}.join(home, "Documents", "Codex")); // ${PROJECTLESS_WORKSPACE_MARKER}`);
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const modulesUrl = resolveModulesUrl(process.argv.slice(2));
  const file = new URL(`@codexhost/cli-${process.platform}-${process.arch}/app/host-runtime.mjs`, modulesUrl);
  const source = await readFile(file, "utf8");
  const patched = patchProjectlessWorkspaceSource(source);
  if (patched !== source) {
    const temporary = new URL(`${file.href}.${process.pid}.tmp`);
    try {
      await writeFile(temporary, patched);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
