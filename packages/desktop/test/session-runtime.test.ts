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

vi.mock("../src/main/pi/desktop-extension-host.ts", () => ({
  DesktopExtensionCompatibilityError: class extends Error {
    readonly code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  DesktopExtensionHost: class {
    readonly requests = [];
    readonly hostState = { statuses: {}, widgets: [] };

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

  it("fails worker startup before AgentSession creation when a curated extension cannot load", async () => {
    const services = createServices();
    services.resourceLoader.getExtensions = () => ({
      extensions: [],
      errors: [{ path: "/approved/broken.ts", error: "syntax error" }],
    });
    mocks.createAgentSessionServices.mockResolvedValue(services);

    await expect(
      SessionRuntime.create({
        projectId: "project",
        cwd: "/workspace",
        extensionSet: {
          generation: "broken",
          projectId: "project",
          entries: [
            {
              id: "curated:broken",
              displayName: "Broken",
              source: "curated",
              entryPath: "/approved/broken.ts",
              hostProfileVersion: 1,
              capabilities: [],
            },
          ],
          diagnostics: [],
          resolvedAt: 0,
        },
        push: () => {},
        onSummaryChanged: () => {},
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_EXTENSION_STARTUP_FAILED" });
    expect(mocks.createAgentSessionFromServices).not.toHaveBeenCalled();
  });

  it("fails worker startup when controlled provider registration fails", async () => {
    const services = createServices();
    services.diagnostics.push({
      type: "error",
      message: 'Extension "<inline:desktop-provider>" error: duplicate provider',
    });
    mocks.createAgentSessionServices.mockResolvedValue(services);

    await expect(
      SessionRuntime.create({
        projectId: "project",
        cwd: "/workspace",
        push: () => {},
        onSummaryChanged: () => {},
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_EXTENSION_STARTUP_FAILED" });
  });

  it("fails worker startup when a session_start handler crashes", async () => {
    const session = createSession();
    session.bindExtensions.mockImplementationOnce(
      async (bindings: { onError?(error: { extensionPath: string; error: string }): void }) => {
        bindings.onError?.({ extensionPath: "development:broken", error: "session start crashed" });
      },
    );
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    await expect(
      SessionRuntime.create({
        projectId: "project",
        cwd: "/workspace",
        extensionSet: {
          generation: "broken-start",
          projectId: "project",
          entries: [
            {
              id: "development:broken",
              displayName: "Broken",
              source: "development",
              entryPath: "/approved/broken.ts",
              hostProfileVersion: 1,
              capabilities: [],
            },
          ],
          diagnostics: [],
          resolvedAt: 0,
        },
        push: () => {},
        onSummaryChanged: () => {},
      }),
    ).rejects.toMatchObject({ code: "DESKTOP_EXTENSION_STARTUP_FAILED" });
  });

  it("创建新 session 时加载 Pi 默认 services 并传递显式 model 和 thinking", async () => {
    const session = createSession();
    const model = { provider: "openai", id: "gpt" };
    mocks.resolveSelection.mockReturnValue({ model, thinkingLevel: "high" });
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      createInput: {
        projectId: "project",
        createRequestId: "create",
        extensionSetGeneration: "desktop-builtins-only",
        model,
        thinkingLevel: "max",
      },
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

  it("binds real waitForIdle and fails unsupported command actions closed", async () => {
    const session = createSession();
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push: () => {},
      onSummaryChanged: () => {},
    });
    const bindings = session.bindExtensions.mock.calls[0]?.[0];
    if (!bindings?.commandContextActions) throw new Error("Command context actions were not bound");

    await bindings.commandContextActions.waitForIdle();
    expect(session.waitForIdle).toHaveBeenCalledOnce();
    await expect(bindings.commandContextActions.reload()).rejects.toMatchObject({
      code: "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE",
    });
    await expect(bindings.commandContextActions.newSession()).rejects.toMatchObject({
      code: "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE",
    });
    await runtime.dispose();
  });

  it("binds real waitForIdle and fail-closed session-changing command actions", async () => {
    const session = createSession();
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });
    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push: () => {},
      onSummaryChanged: () => {},
    });
    const binding = session.bindExtensions.mock.calls[0]?.[0] as {
      commandContextActions: Record<string, (...args: unknown[]) => Promise<unknown>>;
    };

    await binding.commandContextActions.waitForIdle?.();
    expect(session.waitForIdle).toHaveBeenCalledOnce();
    for (const action of ["newSession", "fork", "navigateTree", "switchSession", "reload"]) {
      await expect(binding.commandContextActions[action]?.()).rejects.toMatchObject({
        code: "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE",
      });
    }
    await runtime.dispose();
  });

  it("emits session_shutdown before disposing the controlled extension runtime", async () => {
    const session = createSession();
    const runner = session.extensionRunner as unknown as {
      hasHandlers: ReturnType<typeof vi.fn>;
      emit: ReturnType<typeof vi.fn>;
    };
    runner.hasHandlers.mockReturnValue(true);
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });
    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push: () => {},
      onSummaryChanged: () => {},
    });

    await runtime.dispose();

    expect(runner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
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

  it("刷新模型时重载 sidecar 凭据、刷新 registry 并发布 control", async () => {
    const session = createSession();
    const services = createServices();
    const push = vi.fn();
    mocks.createAgentSessionServices.mockResolvedValue(services);
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });
    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push,
      onSummaryChanged: () => {},
    });

    runtime.refreshModels();

    expect(services.modelRegistry.authStorage.reload).toHaveBeenCalledOnce();
    expect(services.modelRegistry.refresh).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ type: "control", control: expect.objectContaining({ models: [] }) }),
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
    modelRegistry: {
      authStorage: { reload: vi.fn() },
      refresh: vi.fn(),
      getError: () => undefined,
      getAvailable: () => [],
      getAll: () => [],
    },
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
    },
    diagnostics: [],
  };
}

function createSession(streaming = false): AgentSession & {
  prompt: ReturnType<typeof vi.fn>;
  bindExtensions: ReturnType<typeof vi.fn>;
  waitForIdle: ReturnType<typeof vi.fn>;
} {
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
    extensionRunner: {
      getRegisteredCommands: () => [],
      hasHandlers: vi.fn(() => false),
      emit: vi.fn(async () => undefined),
    },
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
    waitForIdle: vi.fn(async () => undefined),
    bindExtensions: vi.fn(async () => undefined),
    subscribe: () => () => {},
    dispose() {},
  } as unknown as AgentSession & {
    prompt: ReturnType<typeof vi.fn>;
    bindExtensions: ReturnType<typeof vi.fn>;
    waitForIdle: ReturnType<typeof vi.fn>;
  };
  return session;
}
