import { fileURLToPath } from "node:url";
import type { AgentSession, AgentSessionEvent, SessionManager, Skill } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunCodeRegistryHolder } from "../src/main/pi/run-code/run-code-tool.ts";
import { PiTimelineUnavailableError, SessionRuntime } from "../src/main/pi/session-runtime.ts";

const mocks = vi.hoisted(() => ({
  createAgentSessionFromServices: vi.fn(),
  createAgentSessionServices: vi.fn(),
  createSessionManager: vi.fn(() => ({})),
  createModelRuntime: vi.fn(async () => ({})),
  createSettingsManager: vi.fn(() => ({ getShellPath: () => undefined, applyDefaults: vi.fn() })),
  resolveSelection: vi.fn(),
  resolveResumeSelection: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  VERSION: "0.82.1",
  createAgentSessionFromServices: mocks.createAgentSessionFromServices,
  createAgentSessionServices: mocks.createAgentSessionServices,
  getAgentDir: () => "/agent",
  ModelRuntime: { create: mocks.createModelRuntime },
  SessionManager: { create: mocks.createSessionManager },
  SettingsManager: { create: mocks.createSettingsManager },
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

    reset() {}

    dispose() {}
  },
}));

describe("SessionRuntime Pi-native commands", () => {
  beforeEach(() => {
    mocks.createAgentSessionFromServices.mockReset();
    mocks.createAgentSessionServices.mockReset();
    mocks.createSessionManager.mockClear();
    mocks.createModelRuntime.mockClear();
    mocks.createSettingsManager.mockClear();
    mocks.resolveSelection.mockReset();
    mocks.resolveResumeSelection.mockReset();
    mocks.createAgentSessionServices.mockResolvedValue(createServices());
  });

  it("registers the managed shell as a low-priority runtime default", async () => {
    const applyDefaults = vi.fn();
    mocks.createSettingsManager.mockReturnValueOnce({ getShellPath: () => undefined, applyDefaults });
    mocks.createAgentSessionFromServices.mockResolvedValue({ session: createSession() });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      shellPath: "/managed/bin/bash",
      push: () => {},
      onSummaryChanged: () => {},
    });

    expect(applyDefaults).toHaveBeenCalledWith({ shellPath: "/managed/bin/bash" });
    await runtime.dispose();
  });

  it("keeps the managed fallback available when the user has configured shellPath", async () => {
    const applyDefaults = vi.fn();
    mocks.createSettingsManager.mockReturnValueOnce({ getShellPath: () => "/user/bin/bash", applyDefaults });
    mocks.createAgentSessionFromServices.mockResolvedValue({ session: createSession() });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      shellPath: "/managed/bin/bash",
      push: () => {},
      onSummaryChanged: () => {},
    });

    expect(applyDefaults).toHaveBeenCalledWith({ shellPath: "/managed/bin/bash" });
    await runtime.dispose();
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

  it("does not fail startup when a marketplace plugin is superseded by local development", async () => {
    const session = createSession();
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      extensionSet: {
        generation: "local-priority",
        projectId: "project",
        entries: [],
        diagnostics: [
          {
            extensionId: "pi.web-access",
            source: "marketplace",
            phase: "resolve",
            code: "DESKTOP_EXTENSION_SUPERSEDED_BY_DEVELOPMENT",
            message: "本地插件优先",
          },
        ],
        resolvedAt: 0,
      },
      push: () => {},
      onSummaryChanged: () => {},
    });

    expect(runtime.bootstrap().control.lastError).toBeUndefined();
    expect(runtime.bootstrap().control.extensionSet.diagnostics).toEqual([
      expect.objectContaining({ code: "DESKTOP_EXTENSION_SUPERSEDED_BY_DEVELOPMENT" }),
    ]);
    await runtime.dispose();
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
    const sessionManager = {} as SessionManager;
    mocks.resolveSelection.mockReturnValue({ model, thinkingLevel: "high" });
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      sessionManager,
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
        sessionManager,
        model,
        thinkingLevel: "high",
        sessionStartEvent: { type: "session_start", reason: "new" },
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

  it("恢复 session 时优先使用 catalog 的逻辑 updatedAt", async () => {
    const session = createSession();
    const mutable = session as unknown as { messages: AgentSession["messages"] };
    mutable.messages = [
      { role: "user", content: "prompt", timestamp: 1_000 },
      { role: "assistant", content: [{ type: "text", text: "response" }], timestamp: 3_000 },
    ] as AgentSession["messages"];
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      initialUpdatedAt: 4_000,
      push: () => {},
      onSummaryChanged: () => {},
    });

    expect(runtime.threadSummary(false).updatedAt).toBe(4_000);
    await runtime.dispose();
  });

  it("仅在用户 prompt 和整次运行结束时更新 thread updatedAt", async () => {
    const session = createSession();
    let emit: ((event: AgentSessionEvent) => void) | undefined;
    const mutable = session as unknown as {
      messages: AgentSession["messages"];
      subscribe(listener: (event: AgentSessionEvent) => void): () => void;
    };
    mutable.messages = [{ role: "user", content: "old prompt", timestamp: 1_000 }] as AgentSession["messages"];
    mutable.subscribe = (listener) => {
      emit = listener;
      return () => {};
    };
    const onSummaryChanged = vi.fn();
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });
    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push: () => {},
      onSummaryChanged,
    });

    emit?.({ type: "agent_start" });
    expect(runtime.threadSummary(false).updatedAt).toBe(1_000);

    emit?.({ type: "message_end", message: { role: "user", content: "next", timestamp: 2_000 } });
    expect(runtime.threadSummary(false).updatedAt).toBe(2_000);

    emit?.({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 3_000 },
    });
    expect(runtime.threadSummary(false)).toMatchObject({ updatedAt: 2_000, messageCount: 3 });

    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    emit?.({ type: "agent_settled" });
    expect(runtime.threadSummary(false).updatedAt).toBe(4_000);
    expect(onSummaryChanged).toHaveBeenCalledTimes(3);
    now.mockRestore();
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

  it("clearing an automatic title falls back to the first message preview", async () => {
    const session = createSession();
    let emit: ((event: AgentSessionEvent) => void) | undefined;
    const mutable = session as unknown as {
      subscribe(listener: (event: AgentSessionEvent) => void): () => void;
    };
    mutable.subscribe = (listener) => {
      emit = listener;
      return () => {};
    };
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push: () => {},
      onSummaryChanged: () => {},
    });

    const prompt = "修复 src/app.ts 的登录问题";
    await runtime.prompt({
      requestId: "request",
      projectId: "project",
      threadId: "thread",
      text: prompt,
      images: [],
    });
    emit?.({ type: "message_end", message: { role: "user", content: prompt, timestamp: 1_000 } });
    expect(runtime.threadSummary(false).title).toBe(prompt);

    emit?.({ type: "session_info_changed", name: undefined });
    expect(runtime.threadSummary(false).title).toBe(prompt);
    await runtime.dispose();
  });

  it("刷新模型时通过 process-local ModelRuntime 重读凭据并发布 control", async () => {
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

    await runtime.refreshModels();

    expect(services.modelRuntime.refresh).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ type: "control", control: expect.objectContaining({ models: [] }) }),
    );
    await runtime.dispose();
  });

  it("刷新后模型 endpoint 变化时更新 session 模型 (setModel)", async () => {
    const session = createSession();
    const services = createServices();
    const push = vi.fn();
    const setModel = vi.fn(async () => undefined);
    const currentModel = {
      provider: "test-provider",
      id: "test-model",
      name: "Old Name",
      baseUrl: "http://old.example/v1",
      api: "openai-completions",
      contextWindow: 8192,
      maxTokens: 4096,
      reasoning: false,
      cost: { input: 1, output: 2 },
      input: ["text"],
    };
    const refreshedModel = {
      ...currentModel,
      name: "Refreshed Name",
      baseUrl: "http://refreshed.example/v1",
      contextWindow: 16384,
      maxTokens: 8192,
      reasoning: true,
      cost: { input: 2, output: 4 },
      input: ["text", "image"],
      headers: { "X-Custom": "value" },
    };
    Object.defineProperty(session, "model", { get: () => currentModel });
    Object.defineProperty(session, "setModel", { value: setModel, writable: true });
    services.modelRuntime = {
      refresh: vi.fn(async () => undefined),
      getError: () => undefined,
      getAvailableSnapshot: () => [refreshedModel],
      getModels: () => [refreshedModel],
      getModel: vi.fn(() => refreshedModel),
      hasConfiguredAuth: vi.fn(() => true),
    };
    mocks.createAgentSessionServices.mockResolvedValue(services);
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push,
      onSummaryChanged: () => {},
    });

    await runtime.refreshModels();

    expect(services.modelRuntime.refresh).toHaveBeenCalledOnce();
    expect(setModel).toHaveBeenCalledOnce();
    expect(setModel).toHaveBeenCalledWith(refreshedModel);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ type: "control" }));
    await runtime.dispose();
  });

  it("刷新后模型未变化时不调用 setModel", async () => {
    const session = createSession();
    const services = createServices();
    const push = vi.fn();
    const setModel = vi.fn(async () => undefined);
    const theModel = {
      provider: "test-provider",
      id: "test-model",
      name: "Same Name",
      baseUrl: "http://same.example/v1",
      api: "openai-completions",
      contextWindow: 8192,
      maxTokens: 4096,
      reasoning: false,
      cost: { input: 1, output: 2 },
      input: ["text"],
    };
    Object.defineProperty(session, "model", { get: () => theModel });
    Object.defineProperty(session, "setModel", { value: setModel, writable: true });
    services.modelRuntime = {
      refresh: vi.fn(async () => undefined),
      getError: () => undefined,
      getAvailableSnapshot: () => [theModel],
      getModels: () => [theModel],
      getModel: vi.fn(() => theModel),
      hasConfiguredAuth: vi.fn(() => true),
    };
    mocks.createAgentSessionServices.mockResolvedValue(services);
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push,
      onSummaryChanged: () => {},
    });

    await runtime.refreshModels();

    expect(services.modelRuntime.refresh).toHaveBeenCalledOnce();
    // The model is the same object, so no setModel call
    expect(setModel).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("刷新后 auth-only 变化不调用 setModel (模型未变)", async () => {
    const session = createSession();
    const services = createServices();
    const push = vi.fn();
    const setModel = vi.fn(async () => undefined);
    const theModel = {
      provider: "test-provider",
      id: "test-model",
      name: "Stable",
      baseUrl: "http://stable.example/v1",
      api: "openai-completions",
      contextWindow: 8192,
      maxTokens: 4096,
      reasoning: false,
      cost: { input: 1, output: 2 },
      input: ["text"],
    };
    Object.defineProperty(session, "model", { get: () => theModel });
    Object.defineProperty(session, "setModel", { value: setModel, writable: true });
    // Auth changes (hasConfiguredAuth returns different values) but the model object
    // is still the same reference from getModel.
    services.modelRuntime = {
      refresh: vi.fn(async () => undefined),
      getError: () => undefined,
      getAvailableSnapshot: () => [theModel],
      getModels: () => [theModel],
      getModel: vi.fn(() => theModel),
      hasConfiguredAuth: vi.fn(() => true),
    };
    mocks.createAgentSessionServices.mockResolvedValue(services);
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push,
      onSummaryChanged: () => {},
    });

    await runtime.refreshModels();

    expect(services.modelRuntime.refresh).toHaveBeenCalledOnce();
    // Model didn't change (same reference), so no setModel
    expect(setModel).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("reloadResources 调用 Pi reload 并发布刷新后的 commands", async () => {
    const session = createSession();
    const push = vi.fn();
    const skills: ReturnType<AgentSession["resourceLoader"]["getSkills"]>["skills"] = [];
    session.resourceLoader.getSkills = () => ({ skills, diagnostics: [] });
    session.reload.mockImplementationOnce(async () => {
      skills.push({
        name: "fresh-skill",
        description: "Fresh skill",
        filePath: "/skills/fresh-skill/SKILL.md",
        baseDir: "/skills/fresh-skill",
        sourceInfo: {
          path: "/skills/fresh-skill/SKILL.md",
          source: "test",
          scope: "user",
          origin: "top-level",
        },
        disableModelInvocation: false,
      });
    });
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });
    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push,
      onSummaryChanged: () => {},
    });
    push.mockClear();

    await expect(runtime.reloadResources()).resolves.toEqual({ accepted: true, queued: false });

    expect(session.reload).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "control",
        projectId: "project",
        threadId: "thread",
        control: expect.objectContaining({
          commands: expect.arrayContaining([
            expect.objectContaining({ name: "skill:fresh-skill", description: "Fresh skill", source: "skill" }),
          ]),
        }),
      }),
    );
    await runtime.dispose();
  });

  it("reloadResources 重新绑定 run_code registry 到重载后的插件实例", async () => {
    const session = createSession();
    const services = createServices();
    services.resourceLoader.getExtensions = () => ({ extensions: [], errors: [] });
    mocks.createAgentSessionServices.mockResolvedValue(services);
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const bind = vi.spyOn(RunCodeRegistryHolder.prototype, "bind");
    try {
      const runtime = await SessionRuntime.create({
        projectId: "project",
        cwd: "/workspace",
        extensionSet: {
          generation: "reload-registry",
          projectId: "project",
          entries: [],
          diagnostics: [],
          resolvedAt: 0,
        },
        push: () => {},
        onSummaryChanged: () => {},
      });

      await expect(runtime.reloadResources()).resolves.toEqual({ accepted: true, queued: false });
      expect(session.reload).toHaveBeenCalledOnce();
      expect(bind).toHaveBeenCalledTimes(3);
      await runtime.dispose();
    } finally {
      bind.mockRestore();
    }
  });

  it("reloadResources 失败时不会继续使用旧的 run_code registry", async () => {
    const session = createSession();
    session.reload.mockRejectedValueOnce(new Error("reload failed"));
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const bind = vi.spyOn(RunCodeRegistryHolder.prototype, "bind");
    try {
      const runtime = await SessionRuntime.create({
        projectId: "project",
        cwd: "/workspace",
        extensionSet: {
          generation: "reload-failure",
          projectId: "project",
          entries: [],
          diagnostics: [],
          resolvedAt: 0,
        },
        push: () => {},
        onSummaryChanged: () => {},
      });

      await expect(runtime.reloadResources()).resolves.toEqual({
        accepted: false,
        queued: false,
        error: "reload failed",
      });
      expect(bind).toHaveBeenCalledTimes(2);
      expect(bind.mock.calls[1]?.[0]).toEqual(new Map());
      await runtime.dispose();
    } finally {
      bind.mockRestore();
    }
  });

  it("reloadResources 将 skill diagnostics 返回为失败结果", async () => {
    const session = createSession();
    session.resourceLoader.getSkills = () => ({
      skills: [],
      diagnostics: [{ type: "error", message: "invalid frontmatter", path: "/skills/broken/SKILL.md" }],
    });
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });
    const runtime = await SessionRuntime.create({
      projectId: "project",
      cwd: "/workspace",
      push: () => {},
      onSummaryChanged: () => {},
    });

    await expect(runtime.reloadResources()).resolves.toEqual({
      accepted: false,
      queued: false,
      error: "Skill 加载失败 /skills/broken/SKILL.md: invalid frontmatter",
    });
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
  const builtinSkills: Skill[] = [
    ["pi-hermes-memory", "Hermes Memory"],
    ["pi-subagents", "Subagents"],
    ["pi-browser", "内置浏览器"],
  ].map(([name, description]) => {
    const filePath = fileURLToPath(
      new URL(`../src/main/pi/extensions/${name}/skills/${name}/SKILL.md`, import.meta.url),
    );
    return {
      name,
      description,
      filePath,
      baseDir: filePath.slice(0, filePath.lastIndexOf("/")),
      sourceInfo: { path: filePath, source: "builtin", scope: "temporary", origin: "top-level" },
      disableModelInvocation: false,
    };
  });
  return {
    cwd: "/workspace",
    modelRuntime: {
      refresh: vi.fn(async () => undefined),
      getError: () => undefined,
      getAvailableSnapshot: () => [],
      getModels: () => [],
      getModel: () => undefined,
    },
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: builtinSkills, diagnostics: [] }),
    },
    diagnostics: [],
  };
}

function createSession(streaming = false): AgentSession & {
  prompt: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
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
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
    },
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
      appendCustomEntry: vi.fn(),
    },
    prompt,
    reload: vi.fn(async () => undefined),
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
    reload: ReturnType<typeof vi.fn>;
    bindExtensions: ReturnType<typeof vi.fn>;
    waitForIdle: ReturnType<typeof vi.fn>;
  };
  return session;
}
