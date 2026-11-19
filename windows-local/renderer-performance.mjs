import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const oldVisibility = 'const visibility = root.scrollWidth > root.clientWidth ? "hidden" : "visible";';
const newVisibility = 'const visibility = visible && root.scrollWidth > root.clientWidth ? "hidden" : "visible";';

// Reading geometry on a hidden chip may force styles for the whole document to flush.
export function patchRendererSource(source) {
  if (source.includes(newVisibility)) return source;
  if (source.split(oldVisibility).length !== 2) {
    throw new Error("Renderer performance patch needs review: missing or ambiguous indicator visibility code");
  }
  return source.replace(oldVisibility, newVisibility);
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
  const file = new URL(`@codexhost/cli-${process.platform}-${process.arch}/app/renderer-extension.js`, modulesUrl);
  const source = await readFile(file, "utf8");
  const patched = patchRendererSource(source);
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
