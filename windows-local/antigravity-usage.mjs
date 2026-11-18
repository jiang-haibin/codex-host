import { createReadStream } from "node:fs";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const modelAliases = new Map([
  ["gemini-3.8-flash-n", "gemini-3.8-flash"],
  ["gemini-4-argon-trial", "gemini-4-argon"],
]);
const modelLabels = Object.freeze({
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-4-hydrogen": "Gemini 4 Hydrogen",
  "gemini-pro-orchestrator-g1-pro": "Orchestrator (Argon)",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "gpt-oss-120b": "GPT-OSS 120B",
});
const modelIdsByLabel = new Map(Object.entries(modelLabels).map(([id, label]) => [label, id]));
// These models have only implicit caching in the Gemini Developer API.
const implicitCacheModels = new Set(["gemini-4-argon", "gemini-4-hydrogen"]);

function normalizeModelId(value) {
  const aliased = modelAliases.get(value) ?? value;
  if (aliased.startsWith("claude-")) {
    return aliased.replace(/(?:-thinking)?(?:-(?:low|medium|high|xhigh))?$/u, "");
  }
  return aliased.replace(/-(?:low|medium|high|xhigh)$/u, "");
}

function modelProvider(model) {
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") && !model.startsWith("gpt-oss-")) return "openai";
  return undefined;
}

function hasImplicitZeroCacheWrite(model) {
  return implicitCacheModels.has(model) || model.startsWith("gemini-") || model.startsWith("gpt-");
}
const decoder = new TextDecoder();
const fixedFieldLengths = { 1: 8, 5: 4 };

function readVarint(bytes, cursor) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10 && cursor.offset < bytes.length; i += 1) {
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
    scale *= 128;
  }
  throw new SyntaxError("Invalid Antigravity protobuf varint");
}

function* fields(bytes) {
  if (!bytes) return;
  const cursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const tag = readVarint(bytes, cursor);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (!field || tag > 0xffffffff) throw new SyntaxError("Invalid Antigravity protobuf tag");
    if (wire === 0) {
      yield [field, readVarint(bytes, cursor)];
      continue;
    }
    const length = wire === 2 ? readVarint(bytes, cursor) : fixedFieldLengths[wire];
    const end = cursor.offset + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      throw new SyntaxError("Invalid Antigravity protobuf field length");
    }
    if (wire === 2) yield [field, bytes.subarray(cursor.offset, end)];
    cursor.offset = end;
  }
}

function modelId(bytes) {
  if (!(bytes instanceof Uint8Array)) return undefined;
  const value = decoder.decode(bytes);
  if (!/^[a-z\d][a-z\d._:/@-]{0,511}$/iu.test(value)) return undefined;
  return normalizeModelId(value);
}

function* generationSteps(generation) {
  for (const [field, value] of generation) {
    if (field !== 2) continue;
    if (typeof value === "number") {
      yield value;
    } else {
      const cursor = { offset: 0 };
      while (cursor.offset < value.length) yield readVarint(value, cursor);
    }
  }
}

// Host's request ID ends with the step index, input, cache reads and output.
function requestStep(entry) {
  return Number(entry.id.split(":").at(-4));
}

function withCacheUsage(entry, encodedUsage) {
  if (!(encodedUsage instanceof Uint8Array)) return entry;
  // ModelUsageStats stores input, output, cache writes and cache reads separately.
  // Its proto3 counters default to zero only when the containing message exists.
  const usage = new Map(fields(encodedUsage));
  const input = usage.get(2) ?? 0;
  const output = usage.get(3) ?? 0;
  const written = usage.get(4) ?? 0;
  const read = usage.get(5) ?? 0;
  if (
    input !== entry.inputTokens - (entry.cachedInputTokens ?? 0) ||
    output !== entry.outputTokens ||
    (entry.cachedInputTokens !== undefined && read !== entry.cachedInputTokens) ||
    !Number.isSafeInteger(written) ||
    !Number.isSafeInteger(read) ||
    !Number.isSafeInteger(input + read + written)
  ) return entry;
  return {
    ...entry,
    inputTokens: input + read + written,
    cachedInputTokens: read,
    cacheWriteInputTokens: written,
  };
}

async function addRequestMetadata(databasePath, entries, signal) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("BEGIN");
    const models = new Map();
    const generations = entries.some((entry) => !entry.model)
      ? db.prepare("SELECT data FROM gen_metadata").iterate()
      : [];
    for (const { data } of generations) {
      signal.throwIfAborted();
      try {
        // The generation links to transcript steps in field 2. Fields 1 and 3
        // carry the response (serving model 19) and request options (model 28).
        const generation = [...fields(data)];
        const response = generation.find(([field]) => field === 1)?.[1];
        const options = generation.find(([field]) => field === 3)?.[1];
        const served = [...fields(response)].find(([field]) => field === 19)?.[1];
        const selected = [...fields(options)].find(([field]) => field === 28)?.[1];
        const model = modelId(served) ?? modelId(selected);
        if (!model) continue;
        for (const step of [...generationSteps(generation)]) {
          // Conflicting model records for the same step are ambiguous.
          const known = models.get(step);
          models.set(step, known === undefined || known === model ? model : null);
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }

    const readStep = db.prepare("SELECT metadata FROM steps WHERE idx = ? AND step_type = 15");
    const enrichedEntries = entries.map((entry) => {
      signal.throwIfAborted();
      if (entry.model && entry.cacheWriteInputTokens !== undefined) return entry;
      const step = requestStep(entry);
      const model = models.get(step);
      let enriched = entry;
      try {
        const metadata = new Map(fields(readStep.get(step)?.metadata));
        const timestamp = metadata.get(1);
        const seconds = [...fields(timestamp)].find(([field]) => field === 1)?.[1];
        // A rollback can reuse step indices. Match the request's creation time too.
        if (seconds !== Math.floor(entry.occurredAtMs / 1000)) return entry;
        if (!entry.model && model) {
          const provider = entry.provider ?? modelProvider(model);
          enriched = { ...entry, model, ...(provider ? { provider } : {}) };
        }
        if (enriched.cacheWriteInputTokens === undefined) {
          return withCacheUsage(enriched, metadata.get(9));
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      return enriched;
    });
    return { entries: enrichedEntries, models };
  } finally {
    db.close();
  }
}

function conversationDatabase(transcript) {
  const session = resolve(transcript, "../../..");
  return join(resolve(session, "../.."), "conversations", `${basename(session)}.db`);
}

async function fileInfo(file) {
  try {
    const info = await lstat(file);
    return info.isFile() ? info : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

async function databaseState(file) {
  const database = await fileInfo(file);
  if (!database) return null;
  const wal = await fileInfo(`${file}-wal`);
  const stamp = ({ ino, size, mtimeMs, ctimeMs }) => `${ino}:${size}:${mtimeMs}:${ctimeMs}`;
  const hasWal = Boolean(wal?.size);
  return { hasWal, fingerprint: `${stamp(database)}:${hasWal ? stamp(wal) : "-"}` };
}

async function readWithMetadata(file, entries, signal, listedFingerprint) {
  const state = await databaseState(file);
  if (listedFingerprint !== undefined && (state?.fingerprint ?? null) !== listedFingerprint) {
    throw new SourceChangedError();
  }
  if (!state) return { entries };
  let result;
  try {
    try {
      result = await addRequestMetadata(file, entries, signal);
    } catch (error) {
      // SQLite can require a writable directory for a WAL-mode read.
      if ((error.errcode & 0xff) !== 14 || state.hasWal) throw error;
      const snapshot = pathToFileURL(file);
      snapshot.searchParams.set("immutable", "1");
      result = await addRequestMetadata(snapshot, entries, signal);
    }
  } catch (error) {
    if (error.code !== "ERR_SQLITE_ERROR") throw error;
    if (![5, 6, 8, 10, 14].includes(error.errcode & 0xff)) return { entries };
  }
  if (!result || (await databaseState(file))?.fingerprint !== state.fingerprint) {
    throw new SourceChangedError();
  }
  return result;
}

function transcriptModelChange(record) {
  const { content, truncated_fields: truncated } = record;
  if (
    typeof content !== "string" || !content.startsWith("<USER_REQUEST>") ||
    (Array.isArray(truncated) && truncated.includes("content"))
  ) return null;
  const boundary = "</USER_REQUEST>";
  const end = content.lastIndexOf(boundary);
  if (end < 0) return null;
  // Antigravity appends model changes after the user request and its metadata.
  const metadata = /^\s*<ADDITIONAL_METADATA>[^<]*<\/ADDITIONAL_METADATA>(?:\s*<USER_SETTINGS_CHANGE>([^<]*)<\/USER_SETTINGS_CHANGE>)?\s*$/u
    .exec(content.slice(end + boundary.length));
  if (!metadata) return null;
  const settings = metadata[1];
  if (!settings?.includes("`Model Selection`")) return undefined;
  const changes = settings.matchAll(/The user changed setting `Model Selection` from [^\r\n]+? to (.+?)\.(?=\s|$)/gu);
  const label = [...changes].at(-1)?.[1];
  return modelIdsByLabel.get(label?.replace(/\s+\((?:low|medium|high|xhigh|max)\)$/iu, "")) ?? null;
}

async function readTranscriptModels(file, entries, signal, fingerprint) {
  const unresolved = new Set(entries.map(({ id }) => id));
  const models = new Map();
  let selectedModel = null;
  let previousStep = -1;
  try {
    const lines = createInterface({
      input: createReadStream(file, { encoding: "utf8", signal }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      signal.throwIfAborted();
      if (!line.includes('"USER_INPUT"') && !line.includes('"PLANNER_RESPONSE"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        if (line.includes('"USER_INPUT"')) selectedModel = null;
        continue;
      }
      const step = record?.step_index;
      if (!Number.isSafeInteger(step) || step < 0) continue;
      if (step < previousStep) selectedModel = null;
      previousStep = step;
      if (record.type === "USER_INPUT" && record.source === "USER_EXPLICIT") {
        const change = transcriptModelChange(record);
        if (change !== undefined) selectedModel = change;
      } else if (record.type === "PLANNER_RESPONSE") {
        const { input_tokens: input, output_tokens: output, cache_read_tokens: read } = record;
        if (typeof input !== "number" || typeof output !== "number") continue;
        const cached = Number.isSafeInteger(read) && read >= 0 ? read : "-";
        // Match the same request ID as the built-in transcript reader.
        const id = `${record.created_at}:${step}:${input}:${cached}:${output}`;
        if (unresolved.has(id)) models.set(id, selectedModel);
      }
    }
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new SourceChangedError("Antigravity transcript disappeared while reading");
    }
    throw error;
  }
  const info = await fileInfo(file);
  if (!info || (fingerprint !== undefined && `${info.ino}:${info.size}:${info.mtimeMs}` !== fingerprint)) {
    throw new SourceChangedError("Antigravity transcript changed while reading");
  }
  return models;
}

class SourceChangedError extends Error {
  code = "HARNESS_USAGE_SOURCE_CHANGED";

  constructor(message = "Antigravity conversation database changed or is busy") {
    super(message);
  }
}

export async function createHarnessAdapter(context) {
  const plugin = await import("./plugin.mjs");
  const adapter = plugin.createHarnessAdapter(context);
  const usage = adapter.usageStatistics;
  let listedSources = new Map();
  adapter.usageStatistics = Object.freeze({
    ...usage,
    async readModelLabels(...args) {
      const upstreamLabels = await usage.readModelLabels?.(...args);
      return { ...modelLabels, ...upstreamLabels };
    },
    async listSources(signal) {
      const sources = await usage.listSources(signal);
      const fingerprints = new Map();
      const enriched = [];
      for (const source of sources) {
        signal.throwIfAborted();
        const state = await databaseState(conversationDatabase(source.id));
        const database = state?.fingerprint ?? null;
        fingerprints.set(source.id, { database, transcript: source.fingerprint });
        enriched.push({ ...source, fingerprint: `${source.fingerprint}:antigravity-usage-v3:${database ?? "-"}` });
      }
      listedSources = fingerprints;
      return enriched;
    },
    async readSource(id, signal) {
      const listed = listedSources.get(id);
      const entries = await usage.readSource(id, signal);
      if (entries.every((entry) => entry.model && entry.cacheWriteInputTokens !== undefined)) {
        return entries;
      }
      const { entries: enriched, models } = await readWithMetadata(
        conversationDatabase(id), entries, signal, listed?.database,
      );
      // Leave conflicting native models unresolved even if a selection appears in the transcript.
      const unresolved = enriched.filter((entry) => !entry.model && models?.get(requestStep(entry)) !== null);
      const transcriptModels = unresolved.length
        ? await readTranscriptModels(id, unresolved, signal, listed?.transcript)
        : null;
      return enriched.map((entry) => {
        const model = entry.model ?? transcriptModels?.get(entry.id);
        if (!model) return entry;
        const provider = entry.provider ?? modelProvider(model);
        const withModel = entry.model
          ? entry
          : { ...entry, model, ...(provider ? { provider } : {}) };
        if (
          withModel.cacheWriteInputTokens === undefined &&
          withModel.cachedInputTokens !== undefined &&
          hasImplicitZeroCacheWrite(model)
        ) {
          return { ...withModel, cacheWriteInputTokens: 0 };
        }
        return withModel;
      });
    },
  });
  return adapter;
}

export async function warmup(adapter) {
  const plugin = await import("./plugin.mjs");
  return plugin.warmup(adapter);
}

function replaceOnce(source, target, replacement, label) {
  if (source.split(target).length !== 2) {
    throw new Error(`Unable to patch ${label}: expected one matching anchor`);
  }
  return source.replace(target, () => replacement);
}

export function patchPluginSource(source) {
  let result = source;

  // ACP 原生文件差异由上游处理，这里补充工具名称和命令展示。
  if (!result.includes(`if (compact === "managetask")`)) {
    const fnMatch = /function synthesizeAntigravityCommand\(toolName, params, cwd\) \{[\s\S]*?\r?\n\}/u.exec(result);
    if (!fnMatch) {
      throw new Error("Unable to patch plugin.mjs synthesizeAntigravityCommand: function boundary not found");
    }
    const fnBody = fnMatch[0];
    const recordMatch = /const (record\d*) = unwrapParameters\(params\);/u.exec(fnBody);
    const tailMatch = /(    return \{ command: commandLine, \.\.\.resolvedCwd \? \{ cwd: resolvedCwd \} : \{\} \};\r?\n  \}\r?\n  return null;\r?\n\})/u.exec(fnBody);
    if (!recordMatch || !tailMatch) {
      throw new Error("Unable to patch plugin.mjs synthesizeAntigravityCommand: anchor not found");
    }
    const recordVar = recordMatch[1];
    const eol = tailMatch[0].includes("\r\n") ? "\r\n" : "\n";
    const patchedBody = fnBody.replace(
      tailMatch[1],
      [
        `    return { command: commandLine, ...resolvedCwd ? { cwd: resolvedCwd } : {} };`,
        `  }`,
        `  if (compact === "managetask") {`,
        `    const action = extractString(${recordVar}, ["Action", "action"])?.trim();`,
        `    const taskId = extractString(${recordVar}, ["TaskId", "taskId", "task_id"])?.trim();`,
        `    const parts = ["manage_task", action, taskId].filter(Boolean);`,
        `    return { command: parts.join(" "), ...cwd ? { cwd } : {} };`,
        `  }`,
        `  if (compact === "searchweb") {`,
        `    const query = extractString(${recordVar}, ["query", "Query"])?.trim();`,
        `    const command = query ? \`search_web \${query}\` : "search_web";`,
        `    return { command, ...cwd ? { cwd } : {} };`,
        `  }`,
        `  return null;`,
        `}`,
      ].join(eol)
    );
    result = replaceOnce(result, fnBody, patchedBody, "plugin.mjs synthesizeAntigravityCommand");
  }

  // 通过 ACP systemPromptAppend 保留大文件先搜索定位的提示。
  const readFileGuideline =
    "When inspecting large files or truncated command outputs, NEVER call read_file repeatedly chunk-by-chunk; " +
    "first run a targeted search command (e.g., rg -n or node) to locate exact line numbers, then call read_file only on the needed line range.";
  if (!result.includes("codexhost-antigravity-read-file-instruction-v1")) {
    const delegationAnchor = `  #delegationPrompt() {
    const prompt = antigravityDelegationInstructions(this.#options.environment);
    return prompt ? { systemPromptAppend: prompt } : {};
  }`;
    const delegationPatched = `  #delegationPrompt() {
    // codexhost-antigravity-read-file-instruction-v1
    const prompt = [
      antigravityDelegationInstructions(this.#options.environment),
      ${JSON.stringify(`[System Instruction: ${readFileGuideline}]`)}
    ].filter(Boolean).join("\\n\\n");
    return prompt ? { systemPromptAppend: prompt } : {};
  }`;
    result = replaceOnce(result, delegationAnchor, delegationPatched, "plugin.mjs #delegationPrompt");
  }

  return result;
}

export function patchHostRuntimeSource(source) {
  let result = source;

  // 1. 扩展 toolCommandLine 并补充 toolCommandActions
  const oldToolCommandLine = `function toolCommandLine(toolName, args) {
  const lower = toolName.toLowerCase().replaceAll(/[_-]/g, "");
  const command = nestedString(args, ["command", "cmd", "script", "commandLine", "command_line"]);
  if (command && ["bash", "exec", "terminal", "run", "shell", "powershell", "pwsh", "command"].includes(lower)) {
    return command;
  }
  const filePath = nestedString(args, [
    "path",
    "file_path",
    "filePath",
    "file",
    "filename",
    "target",
    "uri"
  ]);
  const pattern = nestedString(args, ["pattern", "glob", "glob_pattern", "query", "regex"]);
  if (["read", "readfile", "fileread", "view"].includes(lower)) {
    return filePath ? \`read \${filePath}\` : void 0;
  }
  if (["glob", "find", "findfiles"].includes(lower)) {
    const target2 = pattern ?? filePath;
    return target2 ? \`glob \${target2}\` : void 0;
  }
  if (["grep", "grepsearch"].includes(lower)) {
    if (!pattern)
      return void 0;
    return filePath ? \`grep \${pattern} \${filePath}\` : \`grep \${pattern}\`;
  }
  return void 0;
}`;
  const newToolCommandLine = `function toolCommandLine(toolName, args) {
  const lower = toolName.toLowerCase().replaceAll(/[_-]/g, "");
  const command = nestedString(args, ["CommandLine", "command", "cmd", "script", "commandLine", "command_line"]);
  if (command && ["bash", "exec", "terminal", "run", "shell", "powershell", "pwsh", "command"].includes(lower)) {
    return command;
  }
  const filePath = nestedString(args, [
    "Path",
    "TargetFile",
    "targetFile",
    "target_file",
    "AbsolutePath",
    "absolutePath",
    "absolute_path",
    "path",
    "file_path",
    "filePath",
    "file",
    "filename",
    "target",
    "uri"
  ]);
  const pattern = nestedString(args, ["Pattern", "Query", "pattern", "glob", "glob_pattern", "query", "regex"]);
  if (["read", "readfile", "fileread", "view", "viewfile"].includes(lower)) {
    return filePath ? \`read \${filePath}\` : void 0;
  }
  if (["glob", "find", "findfiles"].includes(lower)) {
    const target2 = pattern ?? filePath;
    return target2 ? \`glob \${target2}\` : void 0;
  }
  if (["grep", "grepsearch"].includes(lower)) {
    if (!pattern)
      return void 0;
    return filePath ? \`grep \${pattern} \${filePath}\` : \`grep \${pattern}\`;
  }
  if (lower === "managetask") {
    const action = nestedString(args, ["Action", "action"]);
    const taskId = nestedString(args, ["TaskId", "taskId", "task_id"]);
    return ["manage_task", action, taskId].filter(Boolean).join(" ");
  }
  if (lower === "searchweb") {
    const query = nestedString(args, ["query", "Query"]);
    return query ? \`search_web \${query}\` : "search_web";
  }
  return void 0;
}
function toolCommandActions(toolName, args, command) {
  const lower = toolName.toLowerCase().replaceAll(/[_-]/g, "");
  const filePath = nestedString(args, [
    "Path",
    "TargetFile",
    "targetFile",
    "target_file",
    "AbsolutePath",
    "absolutePath",
    "absolute_path",
    "path",
    "file_path",
    "filePath",
    "file",
    "filename",
    "target",
    "uri"
  ]);
  const pattern = nestedString(args, ["Pattern", "Query", "pattern", "glob", "glob_pattern", "query", "regex"]);
  if (["read", "readfile", "fileread", "view", "viewfile"].includes(lower) && filePath) {
    return [{
      type: "read",
      command,
      name: filePath.replace(/[/\\\\]+$/u, "").split(/[/\\\\]/u).pop() || filePath,
      path: filePath
    }];
  }
  if (["glob", "find", "findfiles"].includes(lower)) {
    return [{
      type: "listFiles",
      command,
      path: filePath ?? null
    }];
  }
  if (["grep", "grepsearch"].includes(lower)) {
    return [{
      type: "search",
      command,
      query: pattern ?? null,
      path: filePath ?? null
    }];
  }
  return [];
}`;
  if (!result.includes("function toolCommandActions(")) {
    result = replaceOnce(result, oldToolCommandLine, newToolCommandLine, "host-runtime.mjs toolCommandLine");
  }
  // 2. 扩展 fileChangeFromTool 支持 PascalCase 参数
  const oldFileChangeFromTool = `function fileChangeFromTool(toolName, args) {
  if (!isFileMutatingTool(toolName))
    return null;
  const displayedPath = nestedString(args, ["path", "file_path", "filePath", "file"]);
  if (!displayedPath)
    return null;
  if (isWriteTool(toolName)) {
    const content = nestedString(args, ["content", "new_string", "newString", "newText", "file_text", "text", "new"], true);
    if (content === void 0)
      return null;
    return [
      {
        path: displayedPath,
        kind: "add",
        diffScope: "fragment",
        unifiedDiff: simpleUnifiedDiff(displayedPath, "", content, "add")
      }
    ];
  }
  const oldText = nestedString(args, ["old_string", "oldString", "oldText", "old_text", "old"], true);
  const newText = nestedString(args, ["new_string", "newString", "newText", "new_text", "content", "new"], true);`;
  const newFileChangeFromTool = `function fileChangeFromTool(toolName, args) {
  if (!isFileMutatingTool(toolName))
    return null;
  const displayedPath = nestedString(args, [
    "Path",
    "TargetFile",
    "targetFile",
    "target_file",
    "AbsolutePath",
    "absolutePath",
    "absolute_path",
    "path",
    "file_path",
    "filePath",
    "file"
  ]);
  if (!displayedPath)
    return null;
  if (isWriteTool(toolName)) {
    const content = nestedString(args, ["Content", "Replacement", "content", "new_string", "newString", "newText", "file_text", "text", "new"], true);
    if (content === void 0)
      return null;
    return [
      {
        path: displayedPath,
        kind: "add",
        diffScope: "fragment",
        unifiedDiff: simpleUnifiedDiff(displayedPath, "", content, "add")
      }
    ];
  }
  const oldText = nestedString(args, ["Target", "target", "old_string", "oldString", "oldText", "old_text", "old"], true);
  const newText = nestedString(args, ["Replacement", "replacement", "Content", "new_string", "newString", "newText", "new_text", "content", "new"], true);`;
  if (!result.includes(`nestedString(args, ["Target", "target"`)) {
    result = replaceOnce(result, oldFileChangeFromTool, newFileChangeFromTool, "host-runtime.mjs fileChangeFromTool");
  }

  // 3. 在 projectItem 中填充 toolCommandActions
  const oldProjectToolExecution = `    case "toolExecution": {
      const command = toolCommandLine(item.toolName, item.arguments);
      if (command) {
        return {
          id: item.itemId,
          type: "commandExecution",
          command,
          cwd: toolWorkingDirectory(item.arguments, defaultCwd),
          processId: null,
          source: "agent",
          status: itemStatus(outcome),
          commandActions: [],
          aggregatedOutput: includeCommandOutput ? toolOutputText(item) : null,
          exitCode: null,
          durationMs: item.durationMs ?? null
        };
      }`;
  const newProjectToolExecution = `    case "toolExecution": {
      const command = toolCommandLine(item.toolName, item.arguments);
      if (command) {
        return {
          id: item.itemId,
          type: "commandExecution",
          command,
          cwd: toolWorkingDirectory(item.arguments, defaultCwd),
          processId: null,
          source: "agent",
          status: itemStatus(outcome),
          commandActions: toolCommandActions(item.toolName, item.arguments, command),
          aggregatedOutput: includeCommandOutput ? toolOutputText(item) : null,
          exitCode: null,
          durationMs: item.durationMs ?? null
        };
      }`;
  if (!result.includes(`commandActions: toolCommandActions(`)) {
    result = replaceOnce(result, oldProjectToolExecution, newProjectToolExecution, "host-runtime.mjs projectItem");
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const modules = process.argv.includes("--next") ? "node_modules/.codexhost-next/node_modules" : "node_modules";
  const appRoot = new URL(`./${modules}/@codexhost/cli-${process.platform}-${process.arch}/app/`, import.meta.url);
  const pluginRoot = new URL("plugins/antigravity/", appRoot);
  const manifestFile = new URL("manifest.json", pluginRoot);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const entry = "antigravity-usage.mjs";
  if (!["plugin.mjs", entry].includes(manifest.entry)) {
    throw new Error(`Unexpected upstream Antigravity plugin entry: ${manifest.entry}`);
  }
  const bundles = await Promise.all([
    [new URL("plugin.mjs", pluginRoot), patchPluginSource],
    [new URL("host-runtime.mjs", appRoot), patchHostRuntimeSource],
  ].map(async ([file, patch]) => {
    const original = await readFile(file, "utf8");
    return { file, original, patched: patch(original) };
  }));
  // 在确认两个入口都兼容后写入，最后切换插件清单。
  for (const { file, original, patched } of bundles) {
    if (patched !== original) await replaceFile(file, patched);
  }
  const wrapper = new URL(entry, pluginRoot);
  const contents = await readFile(new URL(import.meta.url), "utf8");
  if (await readFile(wrapper, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
  }) !== contents) await replaceFile(wrapper, contents);
  if (manifest.entry !== entry) {
    manifest.entry = entry;
    await replaceFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
