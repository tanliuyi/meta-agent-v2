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
import type { Project, SessionBootstrap, Thread, WorkbenchState } from "../src/shared/contracts.ts";
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

  beforeEach(() => {
    attach = vi.fn(async (projectId: string, threadId: string) => bootstrap(projectId, threadId));
    clearQueue = vi.fn(async () => ({ steering: [], followUp: [] }));
    detach = vi.fn();
    remove = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          attach,
          clearQueue,
          detach,
          flush: vi.fn(),
          remove,
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

  it("prepared thread 未提交时仍以最后 committed thread 作为失败恢复目标", async () => {
    const { actions } = renderPiRuntime([thread("committed"), thread("prepared"), thread("failed")]);
    const committed = await actions.open(targetProject, "committed");
    actions.commit(committed);
    await actions.open(targetProject, "prepared");
    attach.mockRejectedValueOnce(new Error("attach failed"));

    await expect(actions.open(targetProject, "failed")).rejects.toThrow("attach failed");

    expect(attach).toHaveBeenLastCalledWith("project", "committed", expect.any(Function));
  });

  it("较新的 switch 提交后忽略迟到的 committed thread recovery", async () => {
    const restore = deferred<SessionBootstrap>();
    const { actions } = renderPiRuntime([thread("committed"), thread("failed"), thread("latest")]);
    const committed = await actions.open(targetProject, "committed");
    actions.commit(committed);
    attach.mockRejectedValueOnce(new Error("attach failed"));
    attach.mockImplementationOnce(() => restore.promise);

    const failed = actions.open(targetProject, "failed");
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(3));
    const latest = await actions.open(targetProject, "latest");
    actions.commit(latest);
    restore.resolve(bootstrap("project", "committed"));

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
    const nextAttachment = deferred<SessionBootstrap>();
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

    nextAttachment.resolve(bootstrap("project", "latest"));
    const latest = await switching;
    actions.commit(latest);
    expect(piSessionBus.store.getSnapshot().threadId).toBe("latest");
  });

  it("committed recovery 迟到时不重新提交已删除的 baseline", async () => {
    const recovery = deferred<SessionBootstrap>();
    const { actions } = renderPiRuntime([thread("baseline"), thread("failed")]);
    const baseline = await actions.open(targetProject, "baseline");
    actions.commit(baseline);
    attach.mockRejectedValueOnce(new Error("attach failed"));
    attach.mockImplementationOnce(() => recovery.promise);

    const failed = actions.open(targetProject, "failed");
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(3));
    await actions.remove(targetProject, "baseline");
    recovery.resolve(bootstrap("project", "baseline"));

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
});

function renderPiRuntime(threads: Thread[]): { runtime: AssistantRuntime; actions: DesktopThreadActions } {
  let result: { runtime: AssistantRuntime; actions: DesktopThreadActions } | undefined;
  function RuntimeProbe() {
    result = usePiRuntime({
      projects: [targetProject],
      project: targetProject,
      threadCatalogs: { [targetProject.id]: threads },
      threadId: null,
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}
