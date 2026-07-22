import type { AssistantRuntime } from "@assistant-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piSessionBus } from "../src/renderer/src/runtime/pi-session-bus.ts";
import {
  type DesktopThreadActions,
  type PreparedThread,
  usePiRuntime,
} from "../src/renderer/src/runtime/use-pi-runtime.ts";
import type {
  Project,
  SessionAttachInput,
  SessionAttachment,
  SessionBootstrap,
  Thread,
  WorkbenchState,
} from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

const targetProject: Project = {
  id: "project",
  name: "Project",
  cwd: "/tmp/project",
  lastOpenedAt: 1,
  available: true,
};

describe("usePiRuntime attachment commit", () => {
  let attach: ReturnType<typeof vi.fn>;
  let clearQueue: ReturnType<typeof vi.fn>;
  let detach: ReturnType<typeof vi.fn>;
  let remove: ReturnType<typeof vi.fn>;
  let archive: ReturnType<typeof vi.fn>;
  let prompt: ReturnType<typeof vi.fn>;
  let rename: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    attach = vi.fn(async (input: SessionAttachInput) => sessionAttachment(input.projectId, input.threadId));
    clearQueue = vi.fn(async () => ({ steering: [], followUp: [] }));
    detach = vi.fn();
    remove = vi.fn(async () => undefined);
    archive = vi.fn(async () => undefined);
    prompt = vi.fn(async () => ({ accepted: true, queued: false }));
    rename = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          attach,
          clearQueue,
          detach,
          flush: vi.fn(),
          remove,
          archive,
          prompt,
          rename,
        },
        workbench: {
          get: vi.fn(async (projectId: string, threadId: string) => workbench(projectId, threadId)),
        },
      },
    });
    piSessionBus.detach();
    detach.mockClear();
  });

  afterEach(() => {
    piSessionBus.detach();
    vi.unstubAllGlobals();
  });

  it("route remount 后即使 assistant-ui 已选中 active thread 也会重新 hydrate", async () => {
    const { actions } = renderPiRuntime([thread("active")], "active");

    const prepared = await actions.open(targetProject, "active");

    expect(attach).toHaveBeenCalledWith(expectedAttachInput("active"), expect.any(Function));
    expect(prepared.bootstrap.threadId).toBe("active");
  });

  it("打开当前 assistant-ui catalog 尚未包含的 fork thread 时直接 hydrate", async () => {
    const { actions } = renderPiRuntime([thread("existing")]);

    const prepared = await actions.open(targetProject, "forked");

    expect(attach).toHaveBeenCalledWith(expectedAttachInput("forked"), expect.any(Function));
    expect(prepared.bootstrap.threadId).toBe("forked");
  });

  it("官方 thread item rename 会落到 Desktop session IPC", async () => {
    const { actions } = renderPiRuntime([thread("rename-target")]);

    await actions.rename(targetProject, "rename-target", "重命名后");

    expect(rename).toHaveBeenCalledWith("project", "rename-target", "重命名后");
  });

  it("route remount hydrate 后 commit 可清队列并发送", async () => {
    const { runtime, actions } = renderPiRuntime([thread("active")], "active");

    const prepared = await actions.open(targetProject, "active");
    actions.commit(prepared);

    await actions.clearQueue();
    runtime.thread.append({ role: "user", content: [{ type: "text", text: "send after remount" }] });

    expect(clearQueue).toHaveBeenCalledWith("project", "active");
    await vi.waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project", threadId: "active", text: "send after remount" }),
      ),
    );
  });

  it("prepared thread 未提交时仍以最后 committed thread 作为失败恢复目标", async () => {
    const { actions } = renderPiRuntime([thread("committed"), thread("prepared"), thread("failed")]);
    const committed = await actions.open(targetProject, "committed");
    actions.commit(committed);
    await actions.open(targetProject, "prepared");
    attach.mockRejectedValueOnce(new Error("attach failed"));

    await expect(actions.open(targetProject, "failed")).rejects.toThrow("attach failed");

    expect(attach).toHaveBeenLastCalledWith(expectedAttachInput("committed"), expect.any(Function));
  });

  it("较新的 switch 提交后忽略迟到的 committed thread recovery", async () => {
    const restore = deferred<SessionAttachment>();
    const { actions } = renderPiRuntime([thread("committed"), thread("failed"), thread("latest")]);
    const committed = await actions.open(targetProject, "committed");
    actions.commit(committed);
    attach.mockRejectedValueOnce(new Error("attach failed"));
    attach.mockImplementationOnce(() => restore.promise);

    const failed = actions.open(targetProject, "failed");
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(3));
    const latest = await actions.open(targetProject, "latest");
    actions.commit(latest);
    restore.resolve(sessionAttachment("project", "committed", "restore-committed"));

    await expect(failed).rejects.toThrow("attach failed");
    await actions.clearQueue();
    expect(clearQueue).toHaveBeenLastCalledWith("project", "latest");
  });

  it("删除 active committed thread 后清理 target 与 attachment", async () => {
    const { actions } = renderPiRuntime([thread("active")]);
    const active = await actions.open(targetProject, "active");
    actions.commit(active);

    await actions.remove(targetProject, "active");

    expect(remove).toHaveBeenCalledWith("project", "active");
    expect(detach).toHaveBeenCalledOnce();
    expect(piSessionBus.store.getSnapshot().threadId).toBe("");
  });

  it("删除 committed thread 时不破坏更新 generation 的 attachment", async () => {
    const removal = deferred<void>();
    const nextAttachment = deferred<SessionAttachment>();
    const { actions } = renderPiRuntime([thread("active"), thread("latest")]);
    const active = await actions.open(targetProject, "active");
    actions.commit(active);
    remove.mockImplementationOnce(() => removal.promise);

    const deleting = actions.remove(targetProject, "active");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    attach.mockImplementationOnce(() => nextAttachment.promise);
    const switching = actions.open(targetProject, "latest");
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));

    removal.resolve(undefined);
    await deleting;
    expect(detach).not.toHaveBeenCalled();

    nextAttachment.resolve(sessionAttachment("project", "latest", "latest-attachment"));
    const latest = await switching;
    actions.commit(latest);
    expect(piSessionBus.store.getSnapshot().threadId).toBe("latest");
  });

  it("committed recovery 迟到时不重新提交已删除的 baseline", async () => {
    const recovery = deferred<SessionAttachment>();
    const { actions } = renderPiRuntime([thread("baseline"), thread("failed")]);
    const baseline = await actions.open(targetProject, "baseline");
    actions.commit(baseline);
    attach.mockRejectedValueOnce(new Error("attach failed"));
    attach.mockImplementationOnce(() => recovery.promise);

    const failed = actions.open(targetProject, "failed");
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(3));
    await actions.remove(targetProject, "baseline");
    recovery.resolve(sessionAttachment("project", "baseline", "baseline-recovery"));

    await expect(failed).rejects.toThrow("attach failed");
    expect(piSessionBus.store.getSnapshot().threadId).toBe("");
  });

  it("draft baseline 被删除后 discard 不再恢复该 thread", async () => {
    const { actions } = renderPiRuntime([thread("baseline")]);
    const baseline = await actions.open(targetProject, "baseline");
    actions.commit(baseline);
    await actions.enterDraft();
    attach.mockClear();

    await actions.remove(targetProject, "baseline");
    const restored = await actions.discardDraft();

    expect(restored).toBeNull();
    expect(attach).not.toHaveBeenCalled();
  });

  it("draft baseline 被归档后 discard 不再恢复该 thread", async () => {
    const { actions } = renderPiRuntime([thread("baseline")]);
    const baseline = await actions.open(targetProject, "baseline");
    actions.commit(baseline);
    await actions.enterDraft();
    attach.mockClear();

    await actions.archive(targetProject, "baseline", true);
    const restored = await actions.discardDraft();

    expect(archive).toHaveBeenCalledWith("project", "baseline", true);
    expect(restored).toBeNull();
    expect(attach).not.toHaveBeenCalled();
  });

  it("归档请求尚未完成时 discard 也不会恢复旧 baseline", async () => {
    const archiveRequest = deferred<void>();
    const { actions } = renderPiRuntime([thread("baseline")]);
    const baseline = await actions.open(targetProject, "baseline");
    actions.commit(baseline);
    await actions.enterDraft();
    archive.mockImplementationOnce(() => archiveRequest.promise);
    attach.mockClear();

    const archiving = actions.archive(targetProject, "baseline", true);
    await vi.waitFor(() => expect(archive).toHaveBeenCalledWith("project", "baseline", true));
    const restored = await actions.discardDraft();
    archiveRequest.resolve(undefined);
    await archiving;

    expect(restored).toBeNull();
    expect(attach).not.toHaveBeenCalled();
  });

  it("归档失败时保留 committed baseline，draft discard 可以恢复", async () => {
    const { actions } = renderPiRuntime([thread("baseline")]);
    const baseline = await actions.open(targetProject, "baseline");
    actions.commit(baseline);
    await actions.enterDraft();
    archive.mockRejectedValueOnce(new Error("archive failed"));
    attach.mockClear();

    await expect(actions.archive(targetProject, "baseline", true)).rejects.toThrow("archive failed");
    const restored = await actions.discardDraft();

    expect(restored?.bootstrap.threadId).toBe("baseline");
    expect(attach).toHaveBeenCalledWith(expectedAttachInput("baseline"), expect.any(Function));
  });

  it("归档进行中删除 baseline 后迟到失败不会恢复已删除 thread", async () => {
    const archiveRequest = deferred<void>();
    const { actions } = renderPiRuntime([thread("baseline")]);
    const baseline = await actions.open(targetProject, "baseline");
    actions.commit(baseline);
    await actions.enterDraft();
    archive.mockImplementationOnce(() => archiveRequest.promise);
    attach.mockClear();

    const archiving = actions.archive(targetProject, "baseline", true);
    await vi.waitFor(() => expect(archive).toHaveBeenCalledWith("project", "baseline", true));
    await actions.remove(targetProject, "baseline");
    archiveRequest.reject(new Error("archive failed"));
    await expect(archiving).rejects.toThrow("archive failed");

    const restored = await actions.discardDraft();
    expect(restored).toBeNull();
    expect(attach).not.toHaveBeenCalled();
  });

  it("归档 thread 不允许被直接打开", async () => {
    const archived = { ...thread("archived"), archived: true };
    const { actions } = renderPiRuntime([archived]);

    await expect(actions.open(targetProject, "archived")).rejects.toThrow("已归档 session 不可打开");
    expect(attach).not.toHaveBeenCalled();
  });
});

function renderPiRuntime(
  threads: Thread[],
  threadId: string | null = null,
): { runtime: AssistantRuntime; actions: DesktopThreadActions } {
  let result: { runtime: AssistantRuntime; actions: DesktopThreadActions } | undefined;
  function RuntimeProbe() {
    result = usePiRuntime({
      projects: [targetProject],
      project: targetProject,
      threadCatalogs: { [targetProject.id]: threads },
      threadId,
      isSendDisabled: false,
    });
    return null;
  }
  renderToStaticMarkup(createElement(RuntimeProbe));
  if (!result) throw new Error("Pi runtime 未初始化");
  return result;
}

function thread(id: string): Thread {
  return {
    id,
    projectId: targetProject.id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: "",
    archived: false,
    running: false,
  };
}

function expectedAttachInput(threadId: string) {
  return expect.objectContaining({ projectId: "project", threadId, requestId: expect.any(String) });
}

function sessionAttachment(
  projectId: string,
  threadId: string,
  attachmentId = `attachment-${threadId}`,
): SessionAttachment {
  return {
    protocolVersion: PROTOCOL_VERSION,
    attachmentId,
    bootstrap: bootstrap(projectId, threadId),
  };
}

function bootstrap(projectId: string, threadId: string): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId,
    threadId,
    timeline: {
      protocolVersion: PROTOCOL_VERSION,
      projectId,
      threadId,
      cursor: 0,
      headId: null,
      nodes: [],
      queue: [],
      phase: "idle",
    },
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId,
      threadId,
      title: threadId,
      updatedAt: 1,
      cwd: targetProject.cwd,
      running: false,
      queueModes: { steering: "one-at-a-time", followUp: "one-at-a-time" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionUi: { statuses: {}, workingVisible: false, editorRevision: 0, toolsExpanded: false, widgets: [] },
    },
  };
}

function workbench(projectId: string, threadId: string): WorkbenchState {
  return {
    projectId,
    threadId,
    panel: "chat",
    panelOpen: false,
    panelWidth: 420,
    terminalOpen: false,
    terminalHeight: 240,
    openFiles: [],
    expandedPaths: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(value: unknown): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(value) {
      rejectPromise?.(value);
    },
  };
}
