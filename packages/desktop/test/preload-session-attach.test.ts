import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../src/shared/channels.ts";
import type { SessionAttachment, SessionBootstrap, SessionPush, SessionPushPayload } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";
import type { DesktopApi } from "../src/shared/desktop-api.ts";
import "../src/preload/index.ts";

const electron = vi.hoisted(() => ({
  exposed: undefined as DesktopApi | undefined,
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  invoke: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: DesktopApi) => {
      electron.exposed = api;
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    sendSync: electron.sendSync,
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      electron.listeners.set(channel, listener);
    },
    removeListener: electron.removeListener,
  },
}));

describe("preload desktop bridge", () => {
  it("映射模型配置调用并同步提交 dirty 状态", async () => {
    const api = electron.exposed;
    if (!api) throw new Error("DesktopApi 未暴露");
    electron.invoke.mockReset().mockResolvedValue(undefined);
    electron.sendSync.mockReset().mockReturnValue(true);
    const input = { expectedRevision: "revision", providers: [] };

    await api.models.getConfig();
    await api.models.getConfigRevision();
    await api.models.saveConfig(input);
    await api.models.openConfigExternally();
    expect(api.models.setEditorDirty(true)).toBe(true);

    expect(electron.invoke.mock.calls).toEqual([
      [CHANNELS.modelsGetConfig],
      [CHANNELS.modelsGetConfigRevision],
      [CHANNELS.modelsSaveConfig, input],
      [CHANNELS.modelsOpenConfigExternally],
    ]);
    expect(electron.sendSync).toHaveBeenCalledWith(CHANNELS.modelsSetEditorDirty, true);
  });

  it("映射窗口控制并订阅最大化状态", () => {
    const api = electron.exposed;
    if (!api) throw new Error("DesktopApi 未暴露");
    electron.send.mockReset();
    electron.removeListener.mockReset();
    const listener = vi.fn();

    api.windowControls.minimize();
    api.windowControls.toggleMaximize();
    api.windowControls.close();
    const unsubscribe = api.windowControls.onMaximizedChanged(listener);
    electron.listeners.get(CHANNELS.windowMaximizedChanged)?.({}, true);

    expect(electron.send.mock.calls).toEqual([
      [CHANNELS.windowMinimize],
      [CHANNELS.windowToggleMaximize],
      [CHANNELS.windowClose],
    ]);
    expect(listener).toHaveBeenCalledWith(true);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(
      CHANNELS.windowMaximizedChanged,
      electron.listeners.get(CHANNELS.windowMaximizedChanged),
    );
  });

  it("通过 main 解析并打开工具文件路径", async () => {
    const api = electron.exposed;
    if (!api) throw new Error("DesktopApi 未暴露");
    electron.invoke.mockReset().mockResolvedValueOnce("/project/src/main.ts").mockResolvedValueOnce(undefined);

    await expect(api.files.resolvePath("src/main.ts")).resolves.toBe("/project/src/main.ts");
    await api.files.open("src/main.ts");

    expect(electron.invoke.mock.calls).toEqual([
      [CHANNELS.filesResolvePath, "src/main.ts"],
      [CHANNELS.filesOpen, "src/main.ts"],
    ]);
  });

  it("将真实 Composer 文本同步到当前 Pi session", async () => {
    const api = electron.exposed;
    if (!api) throw new Error("DesktopApi 未暴露");
    electron.invoke.mockReset().mockResolvedValue(undefined);

    await api.sessions.setEditorText("project", "thread", "draft");

    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.sessionsSetEditorText, "project", "thread", "draft");
  });

  it("hydrate 前按 attachment token 缓存 push，并保护新 attachment 不被 stale detach 清理", async () => {
    const api = electron.exposed;
    if (!api) throw new Error("DesktopApi 未暴露");
    electron.invoke.mockReset();
    electron.send.mockReset();
    const first = deferred<SessionAttachment>();
    electron.invoke.mockReturnValueOnce(first.promise);
    const received: SessionPushPayload[] = [];
    const attaching = api.sessions.attach("project", "thread", (update) => received.push(update));

    push(controlPush("attachment-1", 1));
    first.resolve(attachment("attachment-1", 1));
    await attaching;
    push(controlPush("attachment-1", 2));
    expect(received).toEqual([]);

    api.sessions.flush();
    expect(received.map((update) => (update.type === "control" ? update.control.revision : -1))).toEqual([1, 2]);
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.sessionsAck, "attachment-1", "worker-1", 1);
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.sessionsAck, "attachment-1", "worker-2", 2);

    const stale = deferred<SessionAttachment>();
    const current = deferred<SessionAttachment>();
    electron.invoke.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const staleAttach = api.sessions.attach("project", "stale", () => {});
    const currentReceived: SessionPushPayload[] = [];
    const currentAttach = api.sessions.attach("project", "current", (update) => currentReceived.push(update));
    current.resolve(attachment("attachment-current", 3, "current"));
    await currentAttach;
    stale.resolve(attachment("attachment-stale", 2, "stale"));
    await expect(staleAttach).rejects.toMatchObject({ name: "AbortError" });

    push(controlPush("attachment-current", 4, "current"));
    api.sessions.flush();
    expect(currentReceived).toHaveLength(1);
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.sessionsDetach, "attachment-stale");

    const superseded = deferred<SessionAttachment>();
    const failed = deferred<SessionAttachment>();
    electron.invoke.mockReturnValueOnce(superseded.promise).mockReturnValueOnce(failed.promise);
    const supersededAttach = api.sessions.attach("project", "superseded", () => {});
    const failedAttach = api.sessions.attach("project", "failed", () => {});
    failed.reject(new Error("attach failed"));
    await expect(failedAttach).rejects.toThrow("attach failed");
    push(controlPush("attachment-current", 5, "current"));
    expect(currentReceived.at(-1)).toMatchObject({ type: "control", control: { revision: 5 } });

    superseded.resolve(attachment("attachment-superseded", 5, "superseded"));
    await expect(supersededAttach).rejects.toMatchObject({ name: "AbortError" });
    push(controlPush("attachment-current", 6, "current"));
    expect(currentReceived.at(-1)).toMatchObject({ type: "control", control: { revision: 6 } });

    api.sessions.detach();
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.sessionsDetach, "attachment-current");
  });

  it("缓存溢出后按 session target 自动更换 attachment", async () => {
    const api = electron.exposed;
    if (!api) throw new Error("DesktopApi 未暴露");
    electron.invoke.mockReset().mockReturnValueOnce(Promise.resolve(attachment("overflow-1", 1)));
    electron.send.mockReset();
    await api.sessions.attach("project", "thread", () => {});

    for (let revision = 1; revision <= 129; revision += 1) push(controlPush("overflow-1", revision));

    electron.invoke
      .mockReturnValueOnce(Promise.resolve(attachment("overflow-2", 2)))
      .mockReturnValueOnce(Promise.resolve(attachment("overflow-3", 3)));
    const received: SessionPushPayload[] = [];
    await api.sessions.attach("project", "thread", (update) => received.push(update));
    push(controlPush("overflow-3", 4));
    api.sessions.flush();

    expect(received).toHaveLength(1);
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.sessionsDetach, "overflow-1");
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.sessionsDetach, "overflow-2");
  });
});

function push(update: SessionPush): void {
  electron.listeners.get(CHANNELS.sessionsPush)?.({}, update);
}

function attachment(attachmentId: string, cursor: number, threadId = "thread"): SessionAttachment {
  return { protocolVersion: PROTOCOL_VERSION, attachmentId, bootstrap: bootstrap(cursor, threadId) };
}

function controlPush(attachmentId: string, revision: number, threadId = "thread"): SessionPush {
  return {
    attachmentId,
    workerInstanceId: `worker-${revision}`,
    sidecarSequence: revision,
    type: "control",
    projectId: "project",
    threadId,
    control: { ...bootstrap(0, threadId).control, revision },
  };
}

function bootstrap(cursor: number, threadId: string): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId,
    timeline: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId,
      cursor,
      headId: null,
      nodes: [],
      queue: [],
      phase: "idle",
    },
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: "project",
      threadId,
      title: threadId,
      updatedAt: 0,
      cwd: "/workspace",
      running: false,
      queueModes: { steering: "one-at-a-time", followUp: "one-at-a-time" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionUi: { statuses: {}, workingVisible: true, editorRevision: 0, toolsExpanded: false, widgets: [] },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(error) {
      rejectPromise?.(error);
    },
  };
}
