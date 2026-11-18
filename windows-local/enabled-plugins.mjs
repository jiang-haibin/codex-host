import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// 仅保留当前实际使用的插件；后续需要新增（如 Claude Code）时取消对应注释并重新运行本脚本即可。
export const ENABLED_PLUGINS = [
  "antigravity",
  "workbuddy",
  "codex-usage",
  // "claude-code",
];

async function replaceFile(destination, contents) {
  const temporary = new URL(`${destination.href}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, contents);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function applyEnabledPlugins(enabled = ENABLED_PLUGINS, modules = "node_modules") {
  const pluginsRoot = new URL(
    `./${modules}/@codexhost/cli-${process.platform}-${process.arch}/app/plugins/`,
    import.meta.url,
  );
  const enabledFile = new URL("enabled.json", pluginsRoot);
  const previous = await readFile(enabledFile, "utf8");
  const current = JSON.parse(previous);

  // 验证目标插件目录真实存在，避免写入无效插件 ID。
  for (const id of enabled) {
    await access(new URL(`${id}/manifest.json`, pluginsRoot));
  }

  const next = {
    ...current,
    enabled: [...new Set(enabled)],
  };
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (previous !== serialized) {
    await replaceFile(enabledFile, serialized);
    return { changed: true, enabled: next.enabled };
  }
  return { changed: false, enabled: next.enabled };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const modules = process.argv.includes("--next") ? "node_modules/.codexhost-next/node_modules" : "node_modules";
  const result = await applyEnabledPlugins(ENABLED_PLUGINS, modules);
  console.log(JSON.stringify(result));
}
