import type { AgentSession, AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiTimelineUnavailableError, SessionRuntime } from "../src/main/pi/session-runtime.ts";

const mocks = vi.hoisted(() => ({
  createAgentSessionFromServices: vi.fn(),
  createAgentSessionServices: vi.fn(),
  createSessionManager: vi.fn(() => ({})),
  resolveSelection: vi.fn(),
  resolveResumeSelection: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  VERSION: "0.80.7",
  createAgentSessionFromServices: mocks.createAgentSessionFromServices,
  createAgentSessionServices: mocks.createAgentSessionServices,
  SessionManager: { create: mocks.createSessionManager },
}));

vi.mock("../src/main/pi/session-configuration.ts", () => ({
  resolveSessionCreateSelection: mocks.resolveSelection,
  resolveSessionResumeSelection: mocks.resolveResumeSelection,
  sessionReadiness: () => ({ state: "ready" }),
}));

vi.mock("../src/main/pi/host-ui.ts", () => ({
  HostUi: class {
    readonly requests = [];
    readonly uiState = { statuses: {}, workingVisible: true, toolsExpanded: false, widgets: [] };

    createContext() {
      return {};
    }

    respond() {}

    dispose() {}
  },
}));

describe("SessionRuntime Pi-native commands", () => {
  beforeEach(() => {
    mocks.createAgentSessionFromServices.mockReset();
    mocks.createAgentSessionServices.mockReset();
    mocks.createSessionManager.mockClear();
    mocks.resolveSelection.mockReset();
    mocks.resolveResumeSelection.mockReset();
    mocks.createAgentSessionServices.mockResolvedValue(createServices());
  });

  it("创建新 session 时加载 Pi 默认 services 并传递显式 model 和 thinking", async () => {
    const session = createSession();
    const model = { provider: "openai", id: "gpt" };
    mocks.resolveSelection.mockReturnValue({ model, thinkingLevel: "high" });
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      createInput: { projectId: "project", model, thinkingLevel: "max" },
      push: () => {},
      onSummaryChanged: () => {},
    });

    expect(mocks.createAgentSessionServices).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    expect(mocks.createAgentSessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({
        services: expect.objectContaining({ resourceLoader: expect.any(Object) }),
        model,
        thinkingLevel: "high",
      }),
    );
  });

  it("恢复已有 session 时传递 session 文件中的 model 和 thinking", async () => {
    const session = createSession();
    const sessionManager = {
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
    } as unknown as SessionManager;
    const model = { provider: "anthropic", id: "claude" };
    mocks.resolveResumeSelection.mockReturnValue({ model, thinkingLevel: "medium" });
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      sessionManager,
      push: () => {},
      onSummaryChanged: () => {},
    });

    expect(mocks.resolveResumeSelection).toHaveBeenCalledWith(sessionManager, expect.any(Object));
    expect(mocks.createAgentSessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionManager,
        model,
        thinkingLevel: "medium",
      }),
    );
  });

  it("fork session 摘要使用新 header 时间更新 updatedAt", async () => {
    const session = createSession();
    const mutable = session as unknown as {
      messages: AgentSession["messages"];
      sessionManager: AgentSession["sessionManager"];
    };
    mutable.messages = [
      { role: "user", content: "old prompt", timestamp: 1_000 },
      { role: "assistant", content: [{ type: "text", text: "old response" }], timestamp: 2_000 },
    ] as AgentSession["messages"];
    mutable.sessionManager.getHeader = () => ({
      id: "forked-thread",
      timestamp: "2026-07-22T08:00:00.000Z",
    });
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push: () => {},
      onSummaryChanged: () => {},
    });

    expect(runtime.threadSummary(false).updatedAt).toBe(Date.parse("2026-07-22T08:00:00.000Z"));
    await runtime.dispose();
  });

  it("所有 Composer 输入直接交给 session.prompt，并立即更新首条标题", async () => {
    const session = createSession();
    const push = vi.fn();
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });
    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push,
      onSummaryChanged: () => {},
    });

    await runtime.prompt({
      requestId: "request",
      projectId: "project",
      threadId: "thread",
      text: "/extension arg",
      images: [],
    });

    expect(session.prompt).toHaveBeenCalledWith(
      "/extension arg",
      expect.objectContaining({ source: "interactive", expandPromptTemplates: true }),
    );
    expect(runtime.threadSummary(false).title).toBe("/extension arg");
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ type: "control", control: expect.objectContaining({ title: "/extension arg" }) }),
    );
    await runtime.dispose();
  });

  it("配置 queue 后的 running prompt 仍走 prompt streamingBehavior", async () => {
    const session = createSession(true);
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });
    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push: () => {},
      onSummaryChanged: () => {},
    });

    await runtime.prompt({
      requestId: "request",
      projectId: "project",
      threadId: "thread",
      text: "follow",
      images: [],
      desiredMode: "steer",
    });

    expect(session.prompt).toHaveBeenCalledWith("follow", expect.objectContaining({ streamingBehavior: "steer" }));
    await runtime.dispose();
  });

  it("projector rebuild 失败后 attach 与新 prompt fail fast", async () => {
    const session = createSession();
    let emit: ((event: AgentSessionEvent) => void) | undefined;
    let failBranch = false;
    const mutable = session as unknown as {
      subscribe(listener: (event: AgentSessionEvent) => void): () => void;
      sessionManager: AgentSession["sessionManager"] & {
        getLeafId(): string | null;
        getBranch(): ReturnType<AgentSession["sessionManager"]["getBranch"]>;
      };
    };
    mutable.subscribe = (listener) => {
      emit = listener;
      return () => {};
    };
    mutable.sessionManager.getLeafId = () => (failBranch ? "changed" : null);
    mutable.sessionManager.getBranch = () => {
      if (failBranch) throw new Error("branch unavailable");
      return [];
    };
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });
    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push: () => {},
      onSummaryChanged: () => {},
    });
    failBranch = true;

    emit?.({ type: "agent_start" });

    expect(() => runtime.bootstrap()).toThrow(PiTimelineUnavailableError);
    expect(() =>
      runtime.prompt({
        requestId: "request",
        projectId: "project",
        threadId: "thread",
        text: "blocked",
        images: [],
      }),
    ).toThrow(PiTimelineUnavailableError);
    await runtime.dispose();
  });
});

function createServices() {
  return {
    cwd: "/workspace",
    modelRegistry: { getAvailable: () => [], getAll: () => [] },
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
    },
    diagnostics: [],
  };
}

function createSession(streaming = false): AgentSession & { prompt: ReturnType<typeof vi.fn> } {
  const prompt = vi.fn(async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
    options?.preflightResult?.(true);
  });
  const session = {
    sessionId: "thread",
    sessionFile: undefined,
    sessionName: undefined,
    messages: [],
    state: { pendingToolCalls: new Map(), errorMessage: undefined },
    isStreaming: streaming,
    thinkingLevel: "off",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    sessionManager: {
      getLeafId: () => null,
      getBranch: () => [],
      getEntry: () => undefined,
      getLabel: () => undefined,
      getSessionDir: () => "/sessions",
      getCwd: () => "/workspace",
      getHeader: () => ({ id: "thread" }),
      isPersisted: () => true,
      createBranchedSession: () => "/sessions/branch.jsonl",
    },
    prompt,
    sendUserMessage: vi.fn(),
    abort: vi.fn(async () => {}),
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    navigateTree: vi.fn(),
    compact: vi.fn(),
    abortCompaction: vi.fn(),
    abortBranchSummary: vi.fn(),
    getContextUsage: () => undefined,
    getAvailableThinkingLevels: () => ["off"],
    async bindExtensions() {},
    subscribe: () => () => {},
    dispose() {},
  } as unknown as AgentSession & { prompt: ReturnType<typeof vi.fn> };
  return session;
}
