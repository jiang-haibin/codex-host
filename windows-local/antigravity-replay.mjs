import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REPLAY_CHECK_ANCHOR = `  const check2 = () => {
    if (received.users === expected.users && received.text === expected.text && received.thought === expected.thought && received.tools === expected.tools && received.usage && received.sessionInfo)
      resolve();
  };`;

const REPLAY_CHECK_PATCHED = `  // codexhost-antigravity-replay-fix-v1: 无标题会话不会发送 session_info_update，
  // 且 agy 1.5.11+ 会在回放文本段前补充空行导致字符数大于数据库原始统计。
  const check2 = () => {
    if (received.users >= expected.users && received.text >= expected.text && received.thought >= expected.thought && received.tools >= expected.tools && received.usage)
      resolve();
  };`;

const REPLAY_SIZE_ANCHOR = `const replay = input.kind === "load" && input.sessionId ? nativeReplayCompletion(await readNativeReplaySize(input.sessionId, antigravityHome(this.options.environment ?? process.env))) : void 0;`;

const REPLAY_SIZE_PATCHED = `// codexhost-antigravity-replay-size-v1
      const replay = input.kind === "load" && input.sessionId ? nativeReplayCompletion(await readNativeReplaySize(input.sessionId, antigravityHome(this.options.environment ?? process.env)).catch(() => ({ users: 0, text: 0, thought: 0, tools: 0 }))) : void 0;`;

const REPLAY_WAIT_ANCHOR = `      if (replay)
        await this.#request(replay.complete, "session/load replay");`;

const REPLAY_WAIT_PATCHED = `      if (replay) {
        // codexhost-antigravity-replay-settle-v1: 防止空会话或后续格式微调长期阻塞 readerPool 队列。
        let replayTimer;
        const settled = Promise.race([
          replay.complete,
          new Promise((done) => {
            replayTimer = setTimeout(done, 1500);
          })
        ]).finally(() => clearTimeout(replayTimer));
        await this.#request(settled, "session/load replay");
      }`;

function replaceOnce(source, target, replacement, label) {
  const parts = source.split(target);
  if (parts.length !== 2) {
    throw new Error(`Unable to patch ${label}: expected one matching anchor (found ${parts.length - 1})`);
  }
  return source.replace(target, () => replacement);
}

/**
 * 修补 Antigravity 插件的 session/load 回放完成判定，避免因缺少标题更新或文本前缀差异导致队列死锁。
 */
export function patchPluginReplaySource(source) {
  // 0.20.0 等旧版本没有 nativeReplayCompletion，直接跳过以保持兼容。
  if (!source.includes("function nativeReplayCompletion(")) {
    return source;
  }

  let result = source;
  if (!result.includes("codexhost-antigravity-replay-fix-v1")) {
    result = replaceOnce(result, REPLAY_CHECK_ANCHOR, REPLAY_CHECK_PATCHED, "plugin.mjs nativeReplayCompletion");
  }
  if (!result.includes("codexhost-antigravity-replay-size-v1")) {
    result = replaceOnce(result, REPLAY_SIZE_ANCHOR, REPLAY_SIZE_PATCHED, "plugin.mjs readNativeReplaySize");
  }
  if (!result.includes("codexhost-antigravity-replay-settle-v1")) {
    result = replaceOnce(result, REPLAY_WAIT_ANCHOR, REPLAY_WAIT_PATCHED, "plugin.mjs session/load replay");
  }
  return result;
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

export async function applyAntigravityReplayPatch(modules = "node_modules") {
  const pluginFile = new URL(
    `./${modules}/@codexhost/cli-${process.platform}-${process.arch}/app/plugins/antigravity/plugin.mjs`,
    import.meta.url,
  );
  const original = await readFile(pluginFile, "utf8");
  if (!original.includes("function nativeReplayCompletion(")) {
    return { changed: false, skipped: "no nativeReplayCompletion" };
  }
  const patched = patchPluginReplaySource(original);
  if (patched === original) {
    return { changed: false };
  }
  await replaceFile(pluginFile, patched);
  return { changed: true };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const modules = process.argv.includes("--next") ? "node_modules/.codexhost-next/node_modules" : "node_modules";
  const result = await applyAntigravityReplayPatch(modules);
  console.log(JSON.stringify(result));
}
