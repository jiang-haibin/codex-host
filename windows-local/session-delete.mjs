import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SESSION_DELETE_MARKER = "codexhost-session-delete-v1";

function replaceOnce(source, target, replacement, label) {
  const parts = source.split(target);
  if (parts.length !== 2) {
    throw new Error(`Session delete patch needs review (${label}): expected 1 match, found ${parts.length - 1}`);
  }
  return parts[0] + replacement + parts[1];
}

// 1. 开放 host-runtime.mjs 的客户端通道 thread/delete，并联动清理附属侧聊与内部状态
export function patchHostRuntimeSource(source) {
  if (source.includes(SESSION_DELETE_MARKER)) return source;

  let out = source;

  // 1a. CLIENT_CHANNEL_METHODS 加入 "thread/delete"
  out = replaceOnce(
    out,
    '  THREAD_ARCHIVE_CONFIRM_METHOD,\n  "thread/unarchive",\n',
    '  THREAD_ARCHIVE_CONFIRM_METHOD,\n  "thread/unarchive",\n  "thread/delete",\n',
    "host-runtime CLIENT_CHANNEL_METHODS",
  );

  // 1b. OFFICIAL_METHODS 加入 "thread/delete": "native"
  out = replaceOnce(
    out,
    '  "thread/archive": "native",\n  "thread/unarchive": "native",\n',
    '  "thread/archive": "native",\n  "thread/unarchive": "native",\n  "thread/delete": "native",\n',
    "host-runtime OFFICIAL_METHODS",
  );

  // 1c. NativeClientChannel CHANGED_METHODS 加入 "thread/delete"
  out = replaceOnce(
    out,
    '  "thread/archive",\n  "thread/unarchive",\n',
    '  "thread/archive",\n  "thread/unarchive",\n  "thread/delete",\n',
    "host-runtime CHANGED_METHODS",
  );

  // 1d. NativeClientChannel.observeMessage 收到 thread/deleted 时清理状态并触发 onDeleted
  out = replaceOnce(
    out,
    '      if (value2.method === "thread/closed") this.#resumedThreads.delete(threadId3);',
    `      if (value2.method === "thread/closed") this.#resumedThreads.delete(threadId3);
      if (value2.method === "thread/deleted") {
        this.#knownThreads.delete(threadId3);
        this.#resumedThreads.delete(threadId3);
        this.#configuration.delete(threadId3);
        this.#interactionErrors.delete(threadId3);
        for (const pending2 of this.#pending.values()) {
          if (pending2.threadId === threadId3) this.#deletePending(pending2.requestId);
        }
        this.#host.onDeleted?.(threadId3);
      }`,
    "host-runtime NativeClientChannel.observeMessage",
  );

  // 1e. NativeClientChannel.observeResponse 处理 thread/delete 成功响应（避免重新 noteThread）
  out = replaceOnce(
    out,
    `    if (threadId3) {
      this.noteThread(threadId3);
      if (method === "thread/resume") this.#resumedThreads.add(threadId3);
      if (method === "thread/archive") this.#resumedThreads.delete(threadId3);
    }`,
    `    if (threadId3) {
      if (method === "thread/delete") {
        this.#knownThreads.delete(threadId3);
        this.#resumedThreads.delete(threadId3);
        this.#configuration.delete(threadId3);
        this.#interactionErrors.delete(threadId3);
        for (const pending2 of this.#pending.values()) {
          if (pending2.threadId === threadId3) this.#deletePending(pending2.requestId);
        }
        this.#host.onDeleted?.(threadId3);
      } else {
        this.noteThread(threadId3);
        if (method === "thread/resume") this.#resumedThreads.add(threadId3);
        if (method === "thread/archive") this.#resumedThreads.delete(threadId3);
      }
    }`,
    "host-runtime NativeClientChannel.observeResponse",
  );

  // 1f. NativeClientChannel.#request 成功后对 thread/delete 广播 thread/deleted（兼容已归档线程不主动推送通知）
  out = replaceOnce(
    out,
    `    if (threadId3 && CHANGED_METHODS.has(method) && !("error" in reply2))
      this.#host.events.changed(threadId3, method);`,
    `    if (threadId3 && CHANGED_METHODS.has(method) && !("error" in reply2))
      this.#host.events.changed(threadId3, method === "thread/delete" ? "thread/deleted" : method);`,
    "host-runtime NativeClientChannel.#request changed event",
  );

  // 1g. ClientChannelHost.observeDesktopMessage 转发 thread/deleted 并从 #clientOwnedThreads 移除
  out = replaceOnce(
    out,
    `      if (typeof id3 === "string" && (this.#clientOwnedThreads.has(id3) || thread3?.modelProvider === "codexhost" || this.#host.loadedThread(id3))) {
        this.#clientOwnedThreads.add(id3);
        this.clientEvents.changed(id3, value2.method);
      }`,
    `      if (typeof id3 === "string" && value2.method === "thread/deleted") {
        this.#clientOwnedThreads.delete(id3);
        this.clientEvents.changed(id3, value2.method);
      } else if (typeof id3 === "string" && (this.#clientOwnedThreads.has(id3) || thread3?.modelProvider === "codexhost" || this.#host.loadedThread(id3))) {
        this.#clientOwnedThreads.add(id3);
        this.clientEvents.changed(id3, value2.method);
      }`,
    "host-runtime ClientChannelHost.observeDesktopMessage",
  );

  // 1h. ClientChannelHost native 回调增加 onDeleted，联动清理委派关系与树监控
  out = replaceOnce(
    out,
    `          desktopConnected: () => this.#options.desktopConnected?.() ?? false`,
    `          desktopConnected: () => this.#options.desktopConnected?.() ?? false,
          onDeleted: (threadId3) => void this.#forgetDeletedThread(threadId3).catch((error51) => this.#diagnose(error51))`,
    "host-runtime ClientChannelHost native onDeleted",
  );

  // 1i. #requestClientNative 删除官方线程前自动清理其挂载的外部/官方侧聊线程
  out = replaceOnce(
    out,
    `  async #requestClientNative(method, params2) {
    try {
      const response = await this.#requestOfficial(method, params2, false);`,
    `  async #requestClientNative(method, params2) {
    try {
      // ${SESSION_DELETE_MARKER}
      if (method === "thread/delete" && isRecord23(params2) && typeof params2.threadId === "string") {
        const targetId = params2.threadId;
        const attachedExternal = (await this.#repository.listSummaries().catch(() => [])).filter(
          ({ attachedToThreadId, hostThreadId }) => attachedToThreadId === targetId && hostThreadId !== targetId
        );
        for (const attached of attachedExternal) {
          if (!this.#externalRuntime) break;
          const childThread = this.#externalRuntime.get(attached.hostThreadId);
          await this.#externalRuntime.deleteThread(attached.hostThreadId);
          this.#announcedExternalThreadIds.delete(attached.hostThreadId);
          if (childThread) await this.#resolveThreadInteractions(childThread);
          this.#routeObservationTracker.forgetThread(attached.hostThreadId);
          this.#externalQueue.clear(attached.hostThreadId);
          this.#queuedTurnStarts.delete(attached.hostThreadId);
          this.clientEvents.changed(attached.hostThreadId, "thread/deleted");
          await this.#forgetDeletedThread(attached.hostThreadId).catch((error51) => this.#diagnose(error51));
        }
        const deletedAttached = new Set();
        for (let attempt = 0; attempt < 8; attempt++) {
          const response = await this.#requestOfficial(method, params2, false);
          if (isRecord23(response.error)) {
            const msg = typeof response.error.message === "string" ? response.error.message : "";
            const attachedMatch = /while attached thread ([0-9a-fA-F-]+) exists/u.exec(msg);
            if (attachedMatch && attachedMatch[1] !== targetId && !deletedAttached.has(attachedMatch[1])) {
              deletedAttached.add(attachedMatch[1]);
              const childRes = await this.#requestOfficial("thread/delete", { threadId: attachedMatch[1] }, false);
              if (!isRecord23(childRes.error)) {
                this.clientEvents.changed(attachedMatch[1], "thread/deleted");
                await this.#forgetDeletedThread(attachedMatch[1]).catch((error51) => this.#diagnose(error51));
                continue;
              }
            }
            return {
              error: {
                code: typeof response.error.code === "number" ? response.error.code : -32603,
                message: msg || "Native Codex request failed"
              }
            };
          }
          return { result: response.result ?? null };
        }
      }
      const response = await this.#requestOfficial(method, params2, false);`,
    "host-runtime #requestClientNative thread/delete",
  );

  // 1j. #deleteExternalThread 自动清理挂载在该外部线程上的侧聊线程，并通知客户端通道
  out = replaceOnce(
    out,
    `  async #deleteExternalThread(request, location) {
    const attached = (await this.#repository.listSummaries()).find(
      ({ attachedToThreadId, state }) => attachedToThreadId === location.record.hostThreadId && state === "ready"
    );
    if (attached) {
      await this.#writer.json(
        rpcError(
          request,
          -32602,
          \`Cannot delete a Thread while attached Thread \${attached.hostThreadId} exists\`
        )
      );
      return;
    }`,
    `  async #deleteExternalThread(request, location) {
    const attachedThreads = (await this.#repository.listSummaries()).filter(
      ({ attachedToThreadId, hostThreadId }) =>
        attachedToThreadId === location.record.hostThreadId && hostThreadId !== location.record.hostThreadId
    );
    for (const attached of attachedThreads) {
      const childThread = this.#externalRuntime?.get(attached.hostThreadId);
      try {
        await this.#externalRuntime.deleteThread(attached.hostThreadId);
      } catch (error51) {
        if (!(error51 instanceof ExternalSessionReleaseError) && childThread)
          await this.#resolveThreadInteractions(childThread);
        await this.#writer.json(
          error51 instanceof ExternalSessionReleaseError
            ? rpcError(request, -32075, error51.message)
            : rpcError(request, -32081, "Attached external Thread could not be removed")
        );
        return;
      }
      this.#announcedExternalThreadIds.delete(attached.hostThreadId);
      if (childThread) await this.#resolveThreadInteractions(childThread);
      this.#routeObservationTracker.forgetThread(attached.hostThreadId);
      this.#externalQueue.clear(attached.hostThreadId);
      this.#queuedTurnStarts.delete(attached.hostThreadId);
      await this.#writer.json({
        method: "thread/deleted",
        params: { threadId: attached.hostThreadId }
      });
      await this.#forgetDeletedThread(attached.hostThreadId).catch(
        (error51) => this.#diagnose(error51)
      );
    }`,
    "host-runtime #deleteExternalThread attached cleanup",
  );

  return out;
}

// 2. 在 web-modules/server.mjs 中打通 thread/delete、防复活缓存过滤与 codexhost/deleteSession RPC
export function patchWebServerSource(source) {
  if (source.includes(SESSION_DELETE_MARKER)) return source;

  let out = source;

  // 2a. CLIENT_CHANNEL_METHODS 加入 "thread/delete"
  out = replaceOnce(
    out,
    '  THREAD_ARCHIVE_CONFIRM_METHOD,\n  "thread/unarchive",\n',
    '  THREAD_ARCHIVE_CONFIRM_METHOD,\n  "thread/unarchive",\n  "thread/delete",\n',
    "web-server CLIENT_CHANNEL_METHODS",
  );

  // 2b. ch-host-client METHODS 白名单加入 "thread/delete"
  out = replaceOnce(
    out,
    '  "thread/archive",\n  "thread/unarchive",\n',
    '  "thread/archive",\n  "thread/unarchive",\n  "thread/delete",\n',
    "web-server ch-host-client METHODS",
  );

  // 2c. ChRealtime.receive 收到 thread/deleted 时触发 deleted 回调，不再调度单线程重读
  out = replaceOnce(
    out,
    `        (event.method === "thread/archived" || event.method === "thread/unarchived") && this.callbacks.archived?.(event.threadId, event.method === "thread/archived"), this.watched.has(event.threadId) && this.schedule(`,
    `        if (event.method === "thread/deleted" || event.method === "thread/delete") {
          this.callbacks.deleted?.(event.threadId), this.catalogReason = "changed", this.schedule("", 100);
          return;
        }
        (event.method === "thread/archived" || event.method === "thread/unarchived") && this.callbacks.archived?.(event.threadId, event.method === "thread/archived"), this.watched.has(event.threadId) && this.schedule(`,
    "web-server ChRealtime.receive thread/deleted",
  );

  // 2d. ChSessionRuntime realtime 回调增加 deleted 处理
  out = replaceOnce(
    out,
    `      archived: (id2, archived) => {
        this.archiveOperations.delete(id2), this.updateArchive(id2, archived);
      },`,
    `      archived: (id2, archived) => {
        this.archiveOperations.delete(id2), this.updateArchive(id2, archived);
      },
      deleted: (id2) => {
        this.evictDeletedSession(id2), this.syncWorkspace().catch(() => {
        });
      },`,
    "web-server ChSessionRuntime realtime deleted callback",
  );

  // 2e. ChSessionRuntime 增加 deletedSessionIds 字段与 evictDeletedSession / deleteSession 方法
  out = replaceOnce(
    out,
    `  archiveOperations = /* @__PURE__ */ new Map();`,
    `  archiveOperations = /* @__PURE__ */ new Map();
  deletedSessionIds = /* @__PURE__ */ new Set(); // ${SESSION_DELETE_MARKER}
  evictDeletedSession(id2) {
    if (this.deletedSessionIds.add(id2), this.deletedSessionIds.size > 4096) {
      let oldest = this.deletedSessionIds.values().next().value;
      oldest !== void 0 && this.deletedSessionIds.delete(oldest);
    }
    this.titleRequests.delete(id2), this.archiveOperations.delete(id2);
    let existingView = this.threads.view(id2);
    existingView && this.threads.discardView(id2, existingView);
    let tracked = this.threads.get(id2);
    tracked && (delete tracked.harnessId, delete tracked.reading, delete tracked.configurationRevision, this.threads.prune(id2)), this.rows.delete(id2), this.publishedCatalog?.delete(id2), this.updateArchive(id2, !1), this.events.emit("api-session/removed", id2), this.events.emit("codexhost/session-deleted", id2);
  }
  async deleteSession(sessionId) {
    if (typeof sessionId != "string" || !sessionId)
      throw new SessionRuntimeError("session/delete-invalid", "Invalid session id.");
    if (sessionId.startsWith("web-remote:") || sessionId.startsWith("remote-control:"))
      throw new SessionRuntimeError("remote/unsupported", "Remote sessions cannot be deleted from this Host.");
    let id2 = this.id(sessionId), draft = this.drafts.get(sessionId) ?? this.drafts.get(id2);
    if (draft && !draft.canonicalId) {
      if (draft.creating)
        throw new SessionRuntimeError("session/busy", "Session creation is in progress.");
      return this.drafts.delete(draft.id), this.events.emit("api-session/removed", draft.id), this.events.emit("codexhost/session-deleted", draft.id), await this.syncWorkspace().catch(() => {
      }), { deleted: !0, sessionId: draft.id };
    }
    let liveView = this.threads.view(id2), activeTurnId = liveView?.ownerSnapshot?.activeTurnId ?? liveView?.thread.turns.find((value) => value.status === "inProgress")?.id;
    activeTurnId && await this.host.request("turn/interrupt", { threadId: id2, turnId: activeTurnId }).catch(() => {
    });
    let wasPinned = this.workspaces.pinnedSessionIds().includes(id2);
    return wasPinned && await this.pins.sync({ threadId: id2, pinned: !1 }).catch(() => {
    }), await this.host.request("thread/delete", { threadId: id2 }), id2 !== sessionId && this.drafts.delete(sessionId), this.evictDeletedSession(id2), await this.syncWorkspace().catch(() => {
    }), wasPinned && await this.pins.refresh().catch(() => {
    }), await this.refresh().catch(() => {
    }), { deleted: !0, sessionId: id2 };
  }`,
    "web-server ChSessionRuntime delete helpers",
  );

  // 2f. ChSessionRuntime.listAll 过滤已删除 ID，防止并发刷新或官方分页保留逻辑复活已删会话
  out = replaceOnce(
    out,
    `    let found = new Map(snapshot.threads.map((row) => [row.id, row])), snapshotArchives = new Set(snapshot.archivedThreadIds), archivedIds = new Set(this.workspaces.localArchivedSessionIds());`,
    `    let found = new Map(snapshot.threads.filter((row) => !this.deletedSessionIds.has(row.id)).map((row) => [row.id, row])), snapshotArchives = new Set(snapshot.archivedThreadIds.filter((id2) => !this.deletedSessionIds.has(id2))), archivedIds = new Set(this.workspaces.localArchivedSessionIds().filter((id2) => !this.deletedSessionIds.has(id2)));`,
    "web-server ChSessionRuntime.listAll filter found/archived",
  );

  out = replaceOnce(
    out,
    `      for (let thread2 of threads)
        if (!(typeof thread2.id != "string" || thread2.archived === !0)) {`,
    `      for (let thread2 of threads)
        if (!(typeof thread2.id != "string" || thread2.archived === !0 || this.deletedSessionIds.has(thread2.id))) {`,
    "web-server ChSessionRuntime.listAll filter threadSections",
  );

  out = replaceOnce(
    out,
    `    let rows = new Map([...found].filter(([id2]) => ownership.has(id2)));
    for (let [id2, row] of this.rows) {
      let harnessId = this.threads.harnessId(id2);
      found.has(id2) || !harnessId || cursor === void 0 && harnessId !== "codex" && known.has(id2) && !archiveChanges.has(id2) && (includeArchived || !archivedIds.has(id2)) || (rows.set(id2, row), ownership.set(id2, harnessId));
    }`,
    `    let rows = new Map([...found].filter(([id2]) => ownership.has(id2) && !this.deletedSessionIds.has(id2)));
    for (let [id2, row] of this.rows) {
      if (this.deletedSessionIds.has(id2)) continue;
      let harnessId = this.threads.harnessId(id2);
      found.has(id2) || !harnessId || cursor === void 0 && harnessId !== "codex" && known.has(id2) && !archiveChanges.has(id2) && (includeArchived || !archivedIds.has(id2)) || (rows.set(id2, row), ownership.set(id2, harnessId));
    }`,
    "web-server ChSessionRuntime.listAll filter retained rows",
  );

  // 2g. 注册 codexhost/deleteSession RPC
  out = replaceOnce(
    out,
    `}), rpc2.register("codexhost/editMessage", async (args) => {`,
    `}), rpc2.register("codexhost/deleteSession", async (args) => {
      let request3 = requestOf(args);
      return this.deleteSession(request3.sessionId);
    }), rpc2.register("codexhost/editMessage", async (args) => {`,
    "web-server register codexhost/deleteSession",
  );

  return out;
}

// 3. 在 dsh-client-ui-codexhost/client.js 中向侧栏会话菜单注入“删除会话”项与确认弹窗
export function patchCodexHostUiSource(source) {
  if (source.includes(SESSION_DELETE_MARKER)) return source;

  // 提取当前打包文件的核心短标识符，兼容后续小版本重构
  const factoryMatch =
    /let\s+([A-Za-z_$][\w$]*)=e\("react"\),([A-Za-z_$][\w$]*)=e\("@deepseek-ai\/dsh-client-ui-primitives"\),([A-Za-z_$][\w$]*)=e\("react\/jsx-runtime"\),[^;]*,([A-Za-z_$][\w$]*)=e\("@deepseek-ai\/dsh-client-store"\)/u.exec(
      source,
    );
  if (!factoryMatch) {
    throw new Error("Session delete UI patch needs review: unable to locate module imports in dsh-client-ui-codexhost");
  }
  const [, reactVar, uiVar, jsxVar, storeVar] = factoryMatch;

  const rpcMatch = /async function ([A-Za-z_$][\w$]*)\(e,t\)\{let n=await fetch\(`api\/\$\{e\}`/u.exec(source);
  if (!rpcMatch) {
    throw new Error("Session delete UI patch needs review: unable to locate RPC helper in dsh-client-ui-codexhost");
  }
  const rpcVar = rpcMatch[1];

  const modalClassMatch = /className:([A-Za-z_$][\w$]*)\.confirm,footer:[\s\S]{0,600}?className:\1\.dangerConfirm/u.exec(source);
  if (!modalClassMatch) {
    throw new Error("Session delete UI patch needs review: unable to locate modal style class map");
  }
  const styleVar = modalClassMatch[1];

  // 从插件入口注册语句中动态提取入口函数、上下文参数、命名空间与中英文字典标识符，兼容跨版本打包重命名
  const applyMatch =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{\2\.effect\(\(\)=>\2\.locale\.register\(([A-Za-z_$][\w$]*),\{zh:([A-Za-z_$][\w$]*),en:([A-Za-z_$][\w$]*)\}\),[`"']ui-codexhost: dictionaries[`"']\)/u.exec(
      source,
    );
  if (!applyMatch) {
    throw new Error("Session delete UI patch needs review: unable to locate ui-codexhost apply entry and locale dictionaries");
  }
  const [, applyFn, ctxVar, nsVar, zhDictVar, enDictVar] = applyMatch;

  let out = source;

  // 3a. 英文词典注入
  out = replaceOnce(
    out,
    `${enDictVar}={"file.download":\`Download\`,`,
    `${enDictVar}={"sessionDelete.menu":\`Delete session\`,"sessionDelete.title":\`Delete session\`,"sessionDelete.untitled":\`Untitled session\`,"sessionDelete.desc":\`Permanently delete “{title}”? Its conversation history will be removed from CodexHost and cannot be undone.\`,"sessionDelete.descRunning":\`Permanently delete “{title}”? Active work in this session will be stopped first, and its conversation history cannot be recovered.\`,"sessionDelete.descDraft":\`Discard unsent draft “{title}”?\`,"sessionDelete.cancel":\`Cancel\`,"sessionDelete.confirm":\`Delete\`,"sessionDelete.deleting":\`Deleting…\`,"sessionDelete.deleted":\`Session deleted\`,"sessionDelete.error.forkReferenced":\`Cannot delete: another forked session still references this conversation’s history.\`,"sessionDelete.error.attachedThread":\`Cannot delete: this session still has an attached side chat.\`,"sessionDelete.error.busy":\`This session is still initializing. Please try again in a moment.\`,"sessionDelete.error.generic":\`Delete failed: {message}\`,"file.download":\`Download\`,`,
    "ui-codexhost en dictionary",
  );

  // 3b. 中文词典注入
  out = replaceOnce(
    out,
    `${zhDictVar}={"file.download":\`下载\`,`,
    `${zhDictVar}={"sessionDelete.menu":\`删除会话\`,"sessionDelete.title":\`删除会话\`,"sessionDelete.untitled":\`未命名会话\`,"sessionDelete.desc":\`确定要永久删除「{title}」吗？该会话的对话记录将从 CodexHost 中移除且无法恢复。\`,"sessionDelete.descRunning":\`确定要永久删除「{title}」吗？该会话仍有正在进行的工作，删除前会先尝试停止，移除后无法恢复。\`,"sessionDelete.descDraft":\`确定要移除未发送的空白草稿「{title}」吗？\`,"sessionDelete.cancel":\`取消\`,"sessionDelete.confirm":\`删除\`,"sessionDelete.deleting":\`删除中…\`,"sessionDelete.deleted":\`已删除会话\`,"sessionDelete.error.forkReferenced":\`无法删除：仍有其他分叉会话引用此会话的历史记录，请先删除对应分叉会话。\`,"sessionDelete.error.attachedThread":\`无法删除：该会话仍关联有未清理的侧边对话，请稍后重试。\`,"sessionDelete.error.busy":\`该会话正在初始化中，请稍后再试。\`,"sessionDelete.error.generic":\`删除失败：{message}\`,"file.download":\`下载\`,`,
    "ui-codexhost zh dictionary",
  );

  // 3c. 在模块顶层定义注册函数（避免入口函数内部局部变量遮蔽模块导入），再于入口函数内调用
  const applyAnchor = applyMatch[0];
  const helperFn = `function __codexhostRegisterSessionDelete(e){/* ${SESSION_DELETE_MARKER} */
let _delStore=(0,${storeVar}.createSnapshotStore)(null),_delToast=(0,${storeVar}.createSnapshotStore)(null),_delToastSeq=0;
let _clearIfCurrent=sid=>{
  try{
    let ws=e.uiWorkspace;
    if(!ws)return;
    let cur=ws.selection?.getSnapshot?.();
    if(ws.mainReference?.sessionId===sid||cur?.sessionId===sid||cur?.subagentAddress?.parentSessionId===sid){
      ws.clearMain();
    }
  }catch{}
};
let _formatDelErr=(err,tr)=>{
  let msg=err instanceof Error?err.message:String(err??"");
  if(/forked history still references it/iu.test(msg))return tr("sessionDelete.error.forkReferenced");
  if(/attached thread/iu.test(msg))return tr("sessionDelete.error.attachedThread");
  if(/creation is in progress|session\\/busy/iu.test(msg))return tr("sessionDelete.error.busy");
  return tr("sessionDelete.error.generic",{message:msg||"Unknown error"});
};
function _ChDeleteMenuItem({sessionId:sid,displayTitle:dt,useMenuOpenState:useOpen,sessions:sessStore,t:tr}){
  let[,setOpen]=typeof useOpen=="function"?useOpen():[!1,()=>{}];
  if(typeof sid!="string"||!sid||sid.startsWith("web-remote:")||sid.startsWith("remote-control:"))return null;
  let item=sessStore.getSnapshot().byId[sid];
  if(item&&(item.origin==="subagent"||item.projectionValues?.remoteHost))return null;
  return(0,${jsxVar}.jsx)(${uiVar}.MenuItemButton,{
    separatorBefore:!0,
    danger:!0,
    icon:(0,${jsxVar}.jsx)(${uiVar}.IconTrashOutlineRegular,{size:16}),
    onSelect:()=>{
      setOpen(!1);
      let latest=sessStore.getSnapshot().byId[sid];
      let rawTitle=(typeof dt=="string"&&dt.trim())||(typeof latest?.title=="string"&&latest.title.trim())||tr("sessionDelete.untitled");
      _delStore.set({sessionId:sid,title:rawTitle,running:latest?.running===!0,blank:latest?.blank===!0});
    },
    children:tr("sessionDelete.menu")
  });
}
function _ChDeleteOverlay({t:tr}){
  let target=(0,${reactVar}.useSyncExternalStore)(_delStore.subscribe,_delStore.getSnapshot);
  let toast=(0,${reactVar}.useSyncExternalStore)(_delToast.subscribe,_delToast.getSnapshot);
  let[busy,setBusy]=(0,${reactVar}.useState)(!1);
  let[err,setErr]=(0,${reactVar}.useState)(null);
  (0,${reactVar}.useEffect)(()=>{setBusy(!1),setErr(null)},[target?.sessionId]);
  let close=()=>{busy||_delStore.set(null)};
  let confirm=async()=>{
    if(!target||busy)return;
    setBusy(!0),setErr(null);
    try{
      await ${rpcVar}("codexhost/deleteSession",{request:{sessionId:target.sessionId}});
      _clearIfCurrent(target.sessionId);
      _delStore.set(null);
      _delToast.set({seq:++_delToastSeq,text:tr("sessionDelete.deleted")});
    }catch(error){
      setErr(_formatDelErr(error,tr));
    }finally{
      setBusy(!1);
    }
  };
  let desc=target===null?void 0:tr(target.blank?"sessionDelete.descDraft":target.running?"sessionDelete.descRunning":"sessionDelete.desc",{title:target.title});
  return(0,${jsxVar}.jsxs)(${jsxVar}.Fragment,{children:[
    target!==null&&(0,${jsxVar}.jsx)(${uiVar}.Modal,{
      open:!0,
      onClose:close,
      title:tr("sessionDelete.title"),
      description:desc,
      closeLabel:tr("connectDevices.close"),
      className:${styleVar}.confirm,
      footer:(0,${jsxVar}.jsxs)(${jsxVar}.Fragment,{children:[
        (0,${jsxVar}.jsx)(${uiVar}.Button,{variant:"outline",size:"sm",disabled:busy,onClick:close,children:tr("sessionDelete.cancel")}),
        (0,${jsxVar}.jsx)(${uiVar}.Button,{variant:"primary",size:"sm",className:${styleVar}.dangerConfirm,disabled:busy,"aria-busy":busy,onClick:()=>void confirm(),children:tr(busy?"sessionDelete.deleting":"sessionDelete.confirm")})
      ]}),
      children:err!==null&&(0,${jsxVar}.jsx)("p",{className:${styleVar}.error,role:"alert",children:err})
    }),
    toast!==null&&(0,${jsxVar}.jsx)(${uiVar}.Toast,{text:toast.text,onDone:()=>_delToast.set(null)},toast.seq)
  ]});
}
e.effect(()=>e.remote.$on("codexhost/session-deleted",sid=>{typeof sid=="string"&&_clearIfCurrent(sid)}),"ui-codexhost: clear deleted session");
e.slots.inject("sidebar.workspaces.session.menu.item",()=>e.slots.register({name:"sidebar.workspaces.session.menu.item",id:"codexhost.delete-session",order:500,locale:${nsVar},inject:()=>({sessions:e.sessions.list})},_ChDeleteMenuItem));
e.slots.inject("shell.overlay",()=>e.slots.register({name:"shell.overlay",id:"codexhost.delete-session-dialog",locale:${nsVar}},_ChDeleteOverlay));
}`;

  const overlayPattern = new RegExp(
    `${ctxVar}\\.slots\\.inject\\([\`"']shell\\.overlay[\`"'],\\(\\)=>${ctxVar}\\.slots\\.register\\(\\{name:[\`"']shell\\.overlay[\`"'],id:[\`"']codexhost\\.remote-workspace-dialog[\`"'],locale:${nsVar},inject:\\(\\)=>\\(\\{controller:[A-Za-z_$][\\w$]*\\}\\)\\},[A-Za-z_$][\\w$]*\\)\\)`,
    "gu",
  );
  const overlayMatches = [...out.matchAll(overlayPattern)];
  if (overlayMatches.length !== 1) {
    throw new Error(
      `Session delete patch needs review (ui-codexhost overlay anchor): expected 1 match, found ${overlayMatches.length}`,
    );
  }
  const overlayAnchor = overlayMatches[0][0];

  out = replaceOnce(out, applyAnchor, `${helperFn}${applyAnchor}`, `ui-codexhost ${applyFn}(${ctxVar}) helper declaration`);
  out = replaceOnce(
    out,
    overlayAnchor,
    `${overlayAnchor},__codexhostRegisterSessionDelete(${ctxVar})`,
    `ui-codexhost ${applyFn}(${ctxVar}) session delete invocation`,
  );

  return out;
}

async function atomicPatchFile(fileUrl, patchFn) {
  const source = await readFile(fileUrl, "utf8");
  const patched = patchFn(source);
  if (patched === source) return false;
  const temporary = new URL(`${fileUrl.href}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, patched);
    await rename(temporary, fileUrl);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
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

export async function applySessionDeletePatch(modulesUrl) {
  const appBase = new URL(`@codexhost/cli-${process.platform}-${process.arch}/app/`, modulesUrl);
  const hostRuntimeChanged = await atomicPatchFile(new URL("host-runtime.mjs", appBase), patchHostRuntimeSource);
  const webServerChanged = await atomicPatchFile(new URL("web-modules/server.mjs", appBase), patchWebServerSource);
  const codexHostUiChanged = await atomicPatchFile(
    new URL("web/plugins/deepseek-ai__dsh-client-ui-codexhost/client.js", appBase),
    patchCodexHostUiSource,
  );
  return { hostRuntimeChanged, webServerChanged, codexHostUiChanged };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const modulesUrl = resolveModulesUrl(process.argv.slice(2));
  await applySessionDeletePatch(modulesUrl);
}
