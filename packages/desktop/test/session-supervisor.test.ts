import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSupervisor } from "../src/main/pi/session-supervisor.ts";
import type { ProjectStore } from "../src/main/store/project-store.ts";
import type {
  DraftSessionConfig,
  SessionBootstrap,
  SessionCreateInput,
  SessionPush,
  SessionPushPayload,
  Thread,
} from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  open: vi.fn(),
  create: vi.fn(),
  loadDraftConfig: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { list: mocks.list, open: mocks.open },
}));

vi.mock("../src/main/pi/session-runtime.ts", () => ({
  SessionRuntime: { create: mocks.create },
}));

vi.mock("../src/main/pi/session-configuration.ts", () => ({
  loadDraftSessionConfig: mocks.loadDraftConfig,
}));

describe("SessionSupervisor", () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.open.mockReset();
    mocks.create.mockReset();
    mocks.loadDraftConfig.mockReset();
    mocks.list.mockResolvedValue([sessionInfo()]);
    mocks.open.mockReturnValue({ getSessionDir: () => "/missing/sessions" });
    mocks.create.mockResolvedValue(runtime());
    mocks.loadDraftConfig.mockResolvedValue(draftConfig());
  });

  it("并发打开同一 session 只创建一个 runtime", async () => {
    const supervisor = new SessionSupervisor(projectStore());
    const [left, right] = await Promise.all([
      supervisor.attach(1, "project", "thread", () => {}),
      supervisor.attach(2, "project", "thread", () => {}),
    ]);

    expect(left.bootstrap.threadId).toBe("thread");
    expect(right.bootstrap.threadId).toBe("thread");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    await supervisor.dispose();
  });

  it("catalog 命中后 list 不重复扫描 JSONL", async () => {
    const supervisor = new SessionSupervisor(projectStore());
    await supervisor.list("project");
    await supervisor.list("project");

    expect(mocks.list).toHaveBeenCalledTimes(1);
    await supervisor.dispose();
  });

  it("draft config 不创建 runtime，首次 create 原样转发 model 和 thinking", async () => {
    const supervisor = new SessionSupervisor(projectStore());
    const input: SessionCreateInput = {
      projectId: "project",
      model: { provider: "openai", id: "gpt" },
      thinkingLevel: "high",
    };

    await expect(supervisor.getDraftConfig("project")).resolves.toEqual(draftConfig());
    expect(mocks.create).not.toHaveBeenCalled();
    await supervisor.create(input);

    expect(mocks.loadDraftConfig).toHaveBeenCalledWith("/workspace");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project", createInput: input }));
    await supervisor.dispose();
  });

  it("创建失败会清除 pending，允许后续重试", async () => {
    mocks.create.mockRejectedValueOnce(new Error("create failed")).mockResolvedValueOnce(runtime());
    const supervisor = new SessionSupervisor(projectStore());
    await expect(supervisor.attach(1, "project", "thread", () => {})).rejects.toThrow("create failed");
    await expect(supervisor.attach(1, "project", "thread", () => {})).resolves.toMatchObject({
      bootstrap: { threadId: "thread" },
    });

    expect(mocks.create).toHaveBeenCalledTimes(2);
    await supervisor.dispose();
  });

  it("新 attachment 原子替换旧 attachment，stale detach 不会清理新订阅", async () => {
    let publish: ((update: SessionPushPayload) => void) | undefined;
    mocks.create.mockImplementation(async (options: { push(update: SessionPushPayload): void }) => {
      publish = options.push;
      return runtime();
    });
    const supervisor = new SessionSupervisor(projectStore());
    const oldPush = vi.fn<(update: SessionPush) => void>();
    const nextPush = vi.fn<(update: SessionPush) => void>();
    const oldAttachment = await supervisor.attach(1, "project", "thread", oldPush);
    const nextAttachment = await supervisor.attach(1, "project", "thread", nextPush);

    supervisor.detach(1, oldAttachment.attachmentId);
    publish?.({ type: "control", projectId: "project", threadId: "thread", control: runtime().bootstrap().control });

    expect(oldPush).not.toHaveBeenCalled();
    expect(nextPush).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: nextAttachment.attachmentId }));
    await supervisor.dispose();
  });

  it("切换后继续接收非 active session 的 control，但不接收其数据面事件", async () => {
    mocks.list.mockResolvedValue([sessionInfo("running"), sessionInfo("active")]);
    let publishRunning: ((update: SessionPushPayload) => void) | undefined;
    mocks.create
      .mockImplementationOnce(async (options: { push(update: SessionPushPayload): void }) => {
        publishRunning = options.push;
        return runtime("running");
      })
      .mockResolvedValueOnce(runtime("active"));
    const supervisor = new SessionSupervisor(projectStore());
    await supervisor.attach(1, "project", "running", () => {});
    const activePush = vi.fn<(update: SessionPush) => void>();
    const activeAttachment = await supervisor.attach(1, "project", "active", activePush);

    publishRunning?.({
      type: "control",
      projectId: "project",
      threadId: "running",
      control: runtime("running").bootstrap().control,
    });
    publishRunning?.({
      type: "tool",
      projectId: "project",
      threadId: "running",
      update: { toolCallId: "tool", status: "complete" },
    });

    expect(activePush).toHaveBeenCalledOnce();
    expect(activePush).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "control",
        threadId: "running",
        attachmentId: activeAttachment.attachmentId,
      }),
    );
    await supervisor.dispose();
  });

  it("较早 attach 晚到且最新 attach 失败时保留原订阅", async () => {
    mocks.list.mockResolvedValue([sessionInfo("current"), sessionInfo("stale"), sessionInfo("failed")]);
    const staleRuntime = deferred<ReturnType<typeof runtime>>();
    let publish: ((update: SessionPushPayload) => void) | undefined;
    mocks.create
      .mockImplementationOnce(async (options: { push(update: SessionPushPayload): void }) => {
        publish = options.push;
        return runtime("current");
      })
      .mockImplementationOnce(() => staleRuntime.promise)
      .mockRejectedValueOnce(new Error("latest attach failed"));
    const supervisor = new SessionSupervisor(projectStore());
    const currentPush = vi.fn<(update: SessionPush) => void>();
    const stalePush = vi.fn<(update: SessionPush) => void>();
    const failedPush = vi.fn<(update: SessionPush) => void>();
    const current = await supervisor.attach(1, "project", "current", currentPush);
    const stale = supervisor.attach(1, "project", "stale", stalePush);
    const failed = supervisor.attach(1, "project", "failed", failedPush);

    await expect(failed).rejects.toThrow("latest attach failed");
    staleRuntime.resolve(runtime("stale"));
    const staleAttachment = await stale;
    supervisor.detach(1, staleAttachment.attachmentId);
    publish?.({
      type: "control",
      projectId: "project",
      threadId: "current",
      control: runtime("current").bootstrap().control,
    });

    expect(currentPush).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: current.attachmentId }));
    expect(stalePush).not.toHaveBeenCalled();
    expect(failedPush).not.toHaveBeenCalled();
    await supervisor.dispose();
  });
});

function projectStore(): ProjectStore {
  return {
    getCwd: () => "/workspace",
    isArchived: () => false,
  } as unknown as ProjectStore;
}

function sessionInfo(id = "thread") {
  return {
    path: `/missing/sessions/${id}.jsonl`,
    id,
    cwd: "/workspace",
    created: new Date(1),
    modified: new Date(2),
    messageCount: 1,
    firstMessage: "question",
    allMessagesText: "question",
  };
}

function runtime(id = "thread") {
  const summary: Thread = {
    id,
    projectId: "project",
    title: "question",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    preview: "question",
    archived: false,
    running: false,
  };
  return {
    id,
    projectId: "project",
    cwd: "/workspace",
    file: `/missing/sessions/${id}.jsonl`,
    session: { isStreaming: false, sessionManager: { getSessionDir: () => "/missing/sessions" } },
    bootstrap: (): SessionBootstrap => ({
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId: id,
      cursor: 0,
      messages: [],
      state: {},
      control: {
        protocolVersion: PROTOCOL_VERSION,
        revision: 0,
        projectId: "project",
        threadId: id,
        title: "question",
        cwd: "/workspace",
        running: false,
        compacting: false,
        queue: { steering: [], followUp: [] },
        models: [],
        commands: [],
        thinkingLevel: "off",
        thinkingLevels: ["off"],
        readiness: { state: "ready" },
        hostRequests: [],
        extensionUi: { statuses: {}, workingVisible: true, toolsExpanded: false, widgets: [] },
      },
    }),
    threadSummary: () => summary,
    dispose: vi.fn(async () => {}),
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

function draftConfig(): DraftSessionConfig {
  return {
    models: [],
    model: null,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    readiness: { state: "missing-model" },
  };
}
