import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiCompatibilityAdapter } from "../src/main/pi/pi-compatibility-adapter.ts";
import type { PiThreadProjector } from "../src/main/pi/pi-thread-projector.ts";

describe("PiCompatibilityAdapter", () => {
  it("edit preflight 失败时返回 rejected result 并恢复旧 leaf", async () => {
    const navigateTree = vi
      .fn()
      .mockResolvedValueOnce({ cancelled: false, editorText: "original" })
      .mockResolvedValueOnce({ cancelled: false });
    const prompt = vi.fn(async (_text: string, options: { preflightResult(success: boolean): void }) => {
      options.preflightResult(false);
      throw new Error("preflight failed");
    });
    const session = createSession({ navigateTree, prompt });
    const projector = createProjector();
    const adapter = new PiCompatibilityAdapter({ session, projector });

    await expect(
      adapter.edit({
        requestId: "request",
        projectId: "project",
        threadId: "thread",
        sourceId: "user",
        text: "edited",
        images: [],
      }),
    ).resolves.toEqual({ accepted: false, queued: false, error: "preflight failed" });

    expect(navigateTree).toHaveBeenNthCalledWith(1, "user", { summarize: false });
    expect(navigateTree).toHaveBeenNthCalledWith(2, "assistant", { summarize: false });
    expect(projector.beginTreeNavigation).toHaveBeenCalledTimes(2);
    expect(projector.endTreeNavigation).toHaveBeenCalledTimes(2);
  });

  it("clearQueue 用同步 scope 区分 clear 与 consumption", () => {
    const session = createSession();
    const projector = createProjector();
    const adapter = new PiCompatibilityAdapter({ session, projector });

    expect(adapter.clearQueue()).toEqual({ steering: ["s"], followUp: ["f"] });
    expect(projector.beginQueueClear).toHaveBeenCalledOnce();
    expect(projector.endQueueClear).toHaveBeenCalledOnce();
  });

  it("fork 使用独立 SessionManager，避免改写 source worker identity", async () => {
    const sourceCreateBranch = vi.fn();
    const session = createSession({
      sessionFile: "/sessions/source.jsonl",
      sessionManager: createSessionManager({
        getEntry: (id: string) =>
          id === "assistant" ? { type: "message", message: { role: "assistant" } } : undefined,
        createBranchedSession: sourceCreateBranch,
      }),
    });
    const branchCreate = vi.fn(() => "/sessions/forked.jsonl");
    const branchManager = {
      createBranchedSession: branchCreate,
      getHeader: () => ({ id: "forked", timestamp: "2026-07-22T08:00:00.000Z" }),
    } as unknown as SessionManager;
    const open = vi.spyOn(SessionManager, "open").mockReturnValue(branchManager);
    const adapter = new PiCompatibilityAdapter({ session, projector: createProjector() });

    await expect(
      adapter.branch({
        requestId: "request",
        projectId: "project",
        threadId: "thread",
        sourceEntryId: "assistant",
        position: "at",
      }),
    ).resolves.toEqual({ branchThreadId: "forked", branchSessionFile: "/sessions/forked.jsonl" });

    expect(open).toHaveBeenCalledWith("/sessions/source.jsonl", "/sessions", "/workspace");
    expect(branchCreate).toHaveBeenCalledWith("assistant");
    expect(sourceCreateBranch).not.toHaveBeenCalled();
    expect(session.sessionId).toBe("thread");
    expect(session.sessionFile).toBe("/sessions/source.jsonl");
  });

  it("public property/surface 缺失时给出版本化 fail-fast 诊断", () => {
    const session = {
      ...createSession(),
      isStreaming: undefined,
      sessionManager: undefined,
    } as unknown as AgentSession;

    expect(() => new PiCompatibilityAdapter({ session, projector: createProjector() })).toThrow(
      /不兼容的 pi-coding-agent 0\.80\.7: 缺少 isStreaming, sessionManager/,
    );
  });

  it("user target 已是 leaf 导致 Pi navigateTree no-op 时拒绝伪 edit branch", async () => {
    const session = createSession({
      sessionManager: {
        getLeafId: () => "user",
        getBranch: () => [],
        getEntry: (id: string) =>
          id === "user" ? { type: "message", message: { role: "user", content: "original" } } : undefined,
        getLabel: () => undefined,
        getSessionDir: () => "/sessions",
        getCwd: () => "/workspace",
        getHeader: () => ({ id: "thread" }),
        isPersisted: () => true,
        createBranchedSession: () => "/sessions/branch.jsonl",
      },
      navigateTree: vi.fn(async () => ({ cancelled: false })),
    });
    const adapter = new PiCompatibilityAdapter({ session, projector: createProjector() });

    await expect(
      adapter.edit({
        requestId: "request",
        projectId: "project",
        threadId: "thread",
        sourceId: "user",
        text: "edited",
        images: [],
      }),
    ).rejects.toThrow("未回退 user entry");
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("prompt resolve 未回调 preflight 时按 public contract 不兼容处理", async () => {
    const adapter = new PiCompatibilityAdapter({ session: createSession(), projector: createProjector() });

    await expect(
      adapter.prompt({
        requestId: "request",
        projectId: "project",
        threadId: "thread",
        text: "hello",
        images: [],
      }),
    ).rejects.toThrow("without preflight acceptance");
  });

  it("prompt preflight 失败时返回 accepted false 与错误", async () => {
    const prompt = vi.fn(async (_text: string, options: { preflightResult(success: boolean): void }) => {
      options.preflightResult(false);
      throw new Error("missing credentials");
    });
    const adapter = new PiCompatibilityAdapter({ session: createSession({ prompt }), projector: createProjector() });

    await expect(
      adapter.prompt({
        requestId: "request",
        projectId: "project",
        threadId: "thread",
        text: "hello",
        images: [],
      }),
    ).resolves.toEqual({ accepted: false, queued: false, error: "missing credentials" });
  });

  it("running prompt 拒绝仅包含图片的输入，避免创建 Pi 空文本 queue item", async () => {
    const session = createSession({ isStreaming: true });
    const projector = createProjector();
    const adapter = new PiCompatibilityAdapter({ session, projector });

    await expect(
      adapter.prompt({
        requestId: "request",
        projectId: "project",
        threadId: "thread",
        text: "",
        images: [{ name: "image.png", mimeType: "image/png", data: "aW1hZ2U=" }],
        desiredMode: "followUp",
      }),
    ).rejects.toThrow("不接受仅包含图片");

    expect(session.prompt).not.toHaveBeenCalled();
    expect(projector.beginPrompt).not.toHaveBeenCalled();
  });

  it.each([false, true])("prompt queue eligibility 取提交时 isStreaming=%s", async (isStreaming) => {
    const prompt = vi.fn(async (_text: string, options: { preflightResult(success: boolean): void }) => {
      options.preflightResult(true);
    });
    const projector = createProjector();
    projector.hasQueuedRequest.mockReturnValue(isStreaming);
    const adapter = new PiCompatibilityAdapter({
      session: createSession({ isStreaming, prompt }),
      projector,
    });

    const result = await adapter.prompt({
      requestId: "request",
      projectId: "project",
      threadId: "thread",
      text: "hello",
      images: [],
      desiredMode: "followUp",
    });

    expect(projector.beginPrompt).toHaveBeenCalledWith("request", "followUp", isStreaming);
    expect(result).toEqual({ accepted: true, queued: isStreaming });
    expect(projector.hasQueuedRequest).toHaveBeenCalledWith("request");
    const options = prompt.mock.calls[0]?.[1];
    expect(options).toEqual(expect.objectContaining({ expandPromptTemplates: true }));
    if (isStreaming) expect(options).toEqual(expect.objectContaining({ streamingBehavior: "followUp" }));
    else expect(options).not.toHaveProperty("streamingBehavior");
  });

  it("prompt 在 preflight 成功后立即返回，不等待完整 agent run", async () => {
    const run = deferred<void>();
    const prompt = vi.fn(async (_text: string, options: { preflightResult(success: boolean): void }) => {
      options.preflightResult(true);
      await run.promise;
    });
    const projector = createProjector();
    const adapter = new PiCompatibilityAdapter({ session: createSession({ prompt }), projector });

    await expect(
      adapter.prompt({
        requestId: "request",
        projectId: "project",
        threadId: "thread",
        text: "hello",
        images: [],
      }),
    ).resolves.toEqual({ accepted: true, queued: false });
    expect(projector.finishPrompt).not.toHaveBeenCalled();

    run.resolve();
    await vi.waitFor(() => expect(projector.finishPrompt).toHaveBeenCalledWith("request"));
  });
});

function createSession(overrides: Record<string, unknown> = {}): AgentSession {
  const entries = new Map([
    ["user", { type: "message", message: { role: "user", content: "original" } }],
    ["assistant", { type: "message", message: { role: "assistant" } }],
  ]);
  return {
    sessionId: "thread",
    isStreaming: false,
    sessionManager: createSessionManager({ getEntry: (id: string) => entries.get(id) }),
    prompt: vi.fn(),
    sendUserMessage: vi.fn(),
    abort: vi.fn(),
    clearQueue: vi.fn(() => ({ steering: ["s"], followUp: ["f"] })),
    getSteeringMessages: vi.fn(() => []),
    getFollowUpMessages: vi.fn(() => []),
    navigateTree: vi.fn(),
    compact: vi.fn(),
    abortCompaction: vi.fn(),
    abortBranchSummary: vi.fn(),
    subscribe: vi.fn(),
    ...overrides,
  } as unknown as AgentSession;
}

function createSessionManager(overrides: Record<string, unknown> = {}): AgentSession["sessionManager"] {
  return {
    getLeafId: () => "assistant",
    getBranch: () => [],
    getEntry: () => undefined,
    getLabel: () => undefined,
    getSessionDir: () => "/sessions",
    getCwd: () => "/workspace",
    getHeader: () => ({ id: "thread", timestamp: "2026-07-22T07:00:00.000Z" }),
    isPersisted: () => true,
    createBranchedSession: () => "/sessions/branch.jsonl",
    ...overrides,
  } as unknown as AgentSession["sessionManager"];
}

function createProjector(): PiThreadProjector & {
  beginTreeNavigation: ReturnType<typeof vi.fn>;
  endTreeNavigation: ReturnType<typeof vi.fn>;
  beginQueueClear: ReturnType<typeof vi.fn>;
  endQueueClear: ReturnType<typeof vi.fn>;
  hasQueuedRequest: ReturnType<typeof vi.fn>;
  finishPrompt: ReturnType<typeof vi.fn>;
} {
  return {
    snapshot: () => ({ phase: "idle" }),
    beginPrompt: vi.fn(),
    markPromptPreflight: vi.fn(),
    finishPrompt: vi.fn(),
    beginTreeNavigation: vi.fn(),
    endTreeNavigation: vi.fn(),
    beginQueueClear: vi.fn(),
    endQueueClear: vi.fn(),
    hasQueuedRequest: vi.fn(() => false),
  } as unknown as PiThreadProjector & {
    beginTreeNavigation: ReturnType<typeof vi.fn>;
    endTreeNavigation: ReturnType<typeof vi.fn>;
    beginQueueClear: ReturnType<typeof vi.fn>;
    endQueueClear: ReturnType<typeof vi.fn>;
    hasQueuedRequest: ReturnType<typeof vi.fn>;
    finishPrompt: ReturnType<typeof vi.fn>;
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
