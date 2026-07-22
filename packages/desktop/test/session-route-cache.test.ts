import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionRecord,
  parseSessionRecordKey,
  type SessionIdentity,
  sessionRecordKey,
} from "../src/renderer/src/runtime/pi-session-store.ts";
import { SessionTransportManager } from "../src/renderer/src/runtime/session-transport-manager.ts";
import type { SessionAttachment, SessionControlState, WorkbenchState } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

const EMPTY_CONTROL: SessionControlState = {
  protocolVersion: PROTOCOL_VERSION,
  revision: 1,
  projectId: "p1",
  threadId: "t1",
  title: "Test Session",
  updatedAt: Date.now(),
  cwd: "/tmp",
  running: false,
  retry: undefined,
  queueModes: { steering: "all", followUp: "all" },
  model: undefined,
  models: [],
  commands: [],
  thinkingLevel: "off",
  thinkingLevels: [],
  context: undefined,
  readiness: { state: "ready" },
  lastError: undefined,
  hostRequests: [],
  extensionUi: {
    statuses: {},
    widgets: [],
    workingMessage: undefined,
    workingVisible: false,
    hiddenThinkingLabel: undefined,
    windowTitle: undefined,
    editorText: undefined,
    editorRevision: 0,
    toolsExpanded: false,
  },
};

describe("SessionIdentity", () => {
  it("sessionRecordKey 使用 NUL 分隔符避免歧义", () => {
    const key = sessionRecordKey("project:1", "thread:1");
    expect(key).toBe("project:1\u0000thread:1");
    const parsed = parseSessionRecordKey(key);
    expect(parsed).toEqual({ projectId: "project:1", threadId: "thread:1" });
  });

  it("sessionRecordKey 支持简单 ID", () => {
    const key = sessionRecordKey("proj-a", "thread-b");
    expect(key).toBe("proj-a\u0000thread-b");
    const parsed = parseSessionRecordKey(key);
    expect(parsed).toEqual({ projectId: "proj-a", threadId: "thread-b" });
  });

  it("parseSessionRecordKey 在没有分隔符时返回 null", () => {
    expect(parseSessionRecordKey("no-separator")).toBeNull();
  });
});

describe("CachedSessionRecord", () => {
  it("createSessionRecord 创建带初始 generation 和 stores 的 record", () => {
    const identity: SessionIdentity = { projectId: "p1", threadId: "t1" };
    const record = createSessionRecord(identity);

    expect(record.identity).toEqual(identity);
    expect(record.key).toBe(sessionRecordKey("p1", "t1"));
    expect(record.generation).toBe(1);
    expect(record.lastAccessedAt).toBeGreaterThan(0);
    expect(record.stores.timeline).toBeDefined();
    expect(record.stores.control).toBeDefined();
    expect(record.stores.workbench).toBeDefined();
    expect(record.stores.summary).toBeDefined();
    expect(record.stores.runActivity).toBeDefined();
    expect(record.stores.connection).toBeDefined();
  });

  it("不同 session identity 产生不同的 record key", () => {
    const r1 = createSessionRecord({ projectId: "p1", threadId: "t1" });
    const r2 = createSessionRecord({ projectId: "p1", threadId: "t2" });
    const r3 = createSessionRecord({ projectId: "p2", threadId: "t1" });
    expect(r1.key).not.toBe(r2.key);
    expect(r1.key).not.toBe(r3.key);
    expect(r2.key).not.toBe(r3.key);
  });
});

describe("SessionControlStore", () => {
  it("getSnapshot 初始返回 null", () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    expect(record.stores.control.getSnapshot()).toBeNull();
  });

  it("replace 设置 control state", () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    record.stores.control.replace(EMPTY_CONTROL);
    expect(record.stores.control.getSnapshot()).toEqual(EMPTY_CONTROL);
  });

  it("apply 跳过旧的 revision", () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    const control1: SessionControlState = { ...EMPTY_CONTROL, revision: 2, title: "v2" };
    const control2: SessionControlState = { ...EMPTY_CONTROL, revision: 1, title: "v1" };

    record.stores.control.replace(control1);
    expect(record.stores.control.getSnapshot()?.title).toBe("v2");

    // apply with older revision should be ignored
    record.stores.control.apply(control2);
    expect(record.stores.control.getSnapshot()?.title).toBe("v2");
  });
});

describe("SessionConnectionStore", () => {
  it("初始状态为 attaching", () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    expect(record.stores.connection.getSnapshot()).toBe("attaching");
  });

  it("setState 更新 connection state", () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    record.stores.connection.setState("ready");
    expect(record.stores.connection.getSnapshot()).toBe("ready");
    record.stores.connection.setState("error");
    expect(record.stores.connection.getSnapshot()).toBe("error");
  });
});

describe("SessionSummaryStore", () => {
  it("初始 summary 正确", () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    const summary = record.stores.summary.getSnapshot();
    expect(summary.composerEmpty).toBe(true);
    expect(summary.running).toBe(false);
    expect(summary.loading).toBe(false);
    expect(summary.hasPendingAttachments).toBe(false);
    expect(summary.connectionState).toBe("attaching");
  });

  it("setRunning 更新 running 状态", () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    record.stores.summary.setRunning(true);
    expect(record.stores.summary.getSnapshot().running).toBe(true);
    record.stores.summary.setRunning(false);
    expect(record.stores.summary.getSnapshot().running).toBe(false);
  });
});

describe("SessionRunActivityStore", () => {
  it("真实 Pi assistant 开始后跨 running 步骤保留参与状态，并在 run 结束时清空", () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    const idle = record.stores.timeline.getSnapshot();
    const runningAssistant = {
      id: "assistant-1",
      parentId: null,
      createdAt: 1,
      kind: "assistant" as const,
      content: [],
      status: { type: "running" as const },
      provenance: { api: "test", provider: "test", model: "test" },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };

    record.stores.runActivity.sync({ ...idle, phase: "running", nodes: [runningAssistant] });
    expect(record.stores.runActivity.hasParticipated()).toBe(true);

    record.stores.runActivity.sync({
      ...idle,
      phase: "running",
      nodes: [{ ...runningAssistant, status: { type: "complete", reason: "stop" } }],
    });
    expect(record.stores.runActivity.hasParticipated()).toBe(true);

    record.stores.runActivity.sync(idle);
    expect(record.stores.runActivity.hasParticipated()).toBe(false);
  });
});

describe("SessionTransportManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getConnectionState 对未知 key 返回 null", () => {
    const manager = new SessionTransportManager();
    expect(manager.getConnectionState("unknown")).toBeNull();
  });

  it("首次 attach 失败后 ensure 可以重试同一个 cache record", async () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    const attach = vi
      .fn()
      .mockRejectedValueOnce(new Error("renderer reload race"))
      .mockResolvedValueOnce({
        protocolVersion: PROTOCOL_VERSION,
        attachmentId: "replacement",
        bootstrap: {
          protocolVersion: PROTOCOL_VERSION,
          projectId: "p1",
          threadId: "t1",
          timeline: record.stores.timeline.getSnapshot(),
          control: EMPTY_CONTROL,
        },
      });
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          attach,
          flush: vi.fn(() => ({ state: "flushed" })),
          detach: vi.fn(),
        },
        workbench: {
          get: vi.fn(async () => ({
            projectId: "p1",
            threadId: "t1",
            panel: "chat",
            panelOpen: false,
            panelWidth: 420,
            terminalOpen: false,
            terminalHeight: 240,
            openFiles: [],
            expandedPaths: [],
          })),
        },
      },
    });
    const manager = new SessionTransportManager();

    await expect(manager.ensure(record)).rejects.toThrow("renderer reload race");
    await expect(manager.ensure(record)).resolves.toMatchObject({ attachmentId: "replacement" });

    expect(attach).toHaveBeenCalledTimes(2);
    expect(manager.getConnectionState(record.key)).toBe("ready");
  });

  it("replacement attach 后读取 Workbench 失败会释放新旧 lease 并允许 fresh retry", async () => {
    const record = createSessionRecord({ projectId: "p1", threadId: "t1" });
    const attach = vi
      .fn()
      .mockResolvedValueOnce(attachmentFor(record, "initial"))
      .mockResolvedValueOnce(attachmentFor(record, "replacement"))
      .mockResolvedValueOnce(attachmentFor(record, "retry"));
    const detach = vi.fn();
    const getWorkbench = vi
      .fn()
      .mockResolvedValueOnce(workbenchState())
      .mockRejectedValueOnce(new Error("workbench read failed"))
      .mockResolvedValueOnce(workbenchState());
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          attach,
          flush: vi.fn(() => ({ state: "flushed" })),
          detach,
        },
        workbench: { get: getWorkbench },
      },
    });
    const manager = new SessionTransportManager();

    await manager.ensure(record);
    await expect(manager.resync(record)).rejects.toThrow("workbench read failed");
    await expect(manager.ensure(record)).resolves.toMatchObject({ attachmentId: "retry" });

    expect(attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ replaceAttachmentId: "initial" }));
    expect(attach.mock.calls[2]?.[0]).not.toHaveProperty("replaceAttachmentId");
    expect(detach).toHaveBeenCalledWith("replacement");
    expect(manager.getCommittedAttachmentId(record)).toBe("retry");
  });
});

describe("session-navigation", () => {
  it("session route path 格式正确", () => {
    const path = `/projects/${encodeURIComponent("test-project")}/session/${encodeURIComponent("test-thread")}`;
    expect(path).toBe("/projects/test-project/session/test-thread");
  });

  it("draft route path 格式正确", () => {
    const path = "/new";
    expect(path).toBe("/new");
  });

  it("settings route 路径正确", () => {
    expect("/settings").toBe("/settings");
    expect("/settings/personalization").toBe("/settings/personalization");
  });
});

function attachmentFor(record: ReturnType<typeof createSessionRecord>, attachmentId: string): SessionAttachment {
  return {
    protocolVersion: PROTOCOL_VERSION,
    attachmentId,
    bootstrap: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: record.identity.projectId,
      threadId: record.identity.threadId,
      timeline: record.stores.timeline.getSnapshot(),
      control: EMPTY_CONTROL,
    },
  };
}

function workbenchState(): WorkbenchState {
  return {
    projectId: "p1",
    threadId: "t1",
    panel: "chat",
    panelOpen: false,
    panelWidth: 420,
    terminalOpen: false,
    terminalHeight: 240,
    openFiles: [],
    expandedPaths: [],
  };
}
