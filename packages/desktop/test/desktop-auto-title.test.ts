import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piAutoTitle, {
  type AutoTitleGenerateInput,
  buildConversationText,
  cleanTitleText,
  derivePlaceholderTitle,
  normalizeTitle,
  resolveTitleModel,
} from "../src/main/pi/extensions/pi-auto-title/index.ts";
import { AutoTitleSettingsService } from "../src/main/settings/auto-title-settings-service.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

type ExtensionHandler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;

interface ExtensionHarness {
  handlers: Map<string, ExtensionHandler>;
  setSessionName: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  getSessionName: ReturnType<typeof vi.fn>;
  triggerSessionStart(reason: string): Promise<void>;
  triggerPrompt(prompt: string): Promise<void>;
  triggerInfoChanged(name?: string): Promise<void>;
  appendBranch(...entries: SessionEntry[]): void;
  triggerShutdown(): Promise<void>;
}

async function createHarness(
  options: {
    configPath?: string;
    getSessionName?: () => string | undefined;
    branch?: SessionEntry[];
    modelAvailable?: boolean;
    authAvailable?: boolean;
  } = {},
): Promise<ExtensionHarness> {
  // Always run against an isolated config file so the real user configuration
  // at ~/.pi/agent/auto-title-config.json can never leak into the test.
  const configPath =
    options.configPath ?? join(await temporaryDirectory("desktop-auto-title-harness-"), "auto-title-config.json");
  if (!options.configPath) {
    await writeFile(configPath, JSON.stringify({ version: 1, enabled: true }));
  }
  const handlers = new Map<string, ExtensionHandler>();
  const setSessionName = vi.fn();
  const getSessionName = vi.fn(options.getSessionName ?? (() => undefined));
  const generate = vi.fn(async (_input: AutoTitleGenerateInput, _ctx: ExtensionContext) => "修复登录超时问题");

  const api = {
    on(event: string, handler: ExtensionHandler) {
      handlers.set(event, handler);
    },
    setSessionName,
    getSessionName,
  } as unknown as ExtensionAPI;

  const branch = options.branch ?? [];
  const context = {
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName,
      getBranch: () => branch,
      buildContextEntries: () => branch,
    },
    model:
      options.modelAvailable === false ? undefined : ({ provider: "test", id: "fake-model" } as unknown as Model<Api>),
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({
        ok: options.authAvailable !== false,
        apiKey: options.authAvailable === false ? "" : "test-key",
        headers: {},
      }),
    },
  } as unknown as ExtensionContext;

  piAutoTitle(api, { configPath, generate });

  return {
    handlers,
    setSessionName,
    generate,
    getSessionName,
    async triggerSessionStart(reason: string) {
      await handlers.get("session_start")?.({ type: "session_start", reason }, context);
    },
    async triggerPrompt(prompt: string) {
      await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt }, context);
    },
    async triggerInfoChanged(name?: string) {
      await handlers.get("session_info_changed")?.({ type: "session_info_changed", name }, context);
    },
    appendBranch(...entries: SessionEntry[]) {
      branch.push(...entries);
    },
    async triggerShutdown() {
      await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
    },
  };
}

function messageEntry(role: "user" | "assistant", text: string, index: number): SessionEntry {
  const message =
    role === "user"
      ? { role, content: text, timestamp: index }
      : {
          role,
          content: [{ type: "text", text }],
          api: "test",
          provider: "test",
          model: "fake-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: index,
        };
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index > 1 ? `entry-${index - 1}` : null,
    timestamp: new Date(index).toISOString(),
    message,
  } as unknown as SessionEntry;
}

describe("pi-auto-title extension", () => {
  it("generates a title for the first prompt of a new session and applies it", async () => {
    const harness = await createHarness();
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("帮我重构登录模块的鉴权逻辑");

    await vi.waitFor(() => expect(harness.setSessionName).toHaveBeenCalledWith("修复登录超时问题"));
    expect(harness.generate).toHaveBeenCalledTimes(1);
    const input = harness.generate.mock.calls[0]![0] as AutoTitleGenerateInput;
    expect(input.prompt).toBe("帮我重构登录模块的鉴权逻辑");
    expect(input.conversationText).toContain("User: 帮我重构登录模块的鉴权逻辑");
    expect(input.systemPrompt).toContain("长度限制");
    expect(input.maxLength).toBe(60);
  });

  it("does not arm for resumed, forked, or reloaded sessions", async () => {
    for (const reason of ["startup", "resume", "fork", "reload"]) {
      const harness = await createHarness();
      await harness.triggerSessionStart(reason);
      await harness.triggerPrompt("第一个问题");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.generate).not.toHaveBeenCalled();
    }
  });

  it("does not persist a provisional title when the title model is unavailable", async () => {
    const harness = await createHarness({ modelAvailable: false });
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("修复 src/app.ts 的登录问题");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.setSessionName).not.toHaveBeenCalled();
  });

  it("does not persist a provisional title when the title model has no credentials", async () => {
    const harness = await createHarness({ authAvailable: false });
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("Investigate example.com timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.setSessionName).not.toHaveBeenCalled();
  });

  it("skips generation when the session already has a name", async () => {
    const harness = await createHarness({ getSessionName: () => "手动命名" });
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.setSessionName).not.toHaveBeenCalled();
  });

  it("does not overwrite a name set while generation is in flight", async () => {
    const harness = await createHarness();
    let resolveGeneration: ((title: string | undefined) => void) | undefined;
    harness.generate.mockImplementation(
      async () =>
        new Promise<string | undefined>((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));

    harness.getSessionName.mockReturnValue("手动命名");
    resolveGeneration?.("自动标题");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.setSessionName).toHaveBeenCalledWith("第一个问题");
    expect(harness.setSessionName).not.toHaveBeenCalledWith("自动标题");
  });

  it("does not restore a title after the user clears it", async () => {
    const harness = await createHarness();
    let resolveGeneration: ((title: string | undefined) => void) | undefined;
    harness.generate.mockImplementation(
      async () =>
        new Promise<string | undefined>((resolve) => {
          resolveGeneration = resolve;
        }),
    );

    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    await harness.triggerInfoChanged();
    resolveGeneration?.("自动标题");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.setSessionName).toHaveBeenCalledWith("第一个问题");
    expect(harness.setSessionName).not.toHaveBeenCalledWith("自动标题");
  });

  it("aborts in-flight generation when the session shuts down", async () => {
    const harness = await createHarness();
    let signal: AbortSignal | undefined;
    harness.generate.mockImplementation(async (input: AutoTitleGenerateInput) => {
      signal = input.signal;
      return new Promise<string | undefined>((resolve) => {
        input.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    });
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(false);

    await harness.triggerShutdown();

    expect(signal?.aborted).toBe(true);
    expect(harness.setSessionName).toHaveBeenCalledWith("第一个问题");
    expect(harness.setSessionName).not.toHaveBeenCalledWith("自动标题");
  });

  it("refines the placeholder once from the third meaningful prompt", async () => {
    const harness = await createHarness();
    await harness.triggerSessionStart("new");

    await harness.triggerPrompt("实现登录超时重试");
    harness.appendBranch(messageEntry("user", "实现登录超时重试", 1), messageEntry("assistant", "我会检查认证流程", 2));
    await harness.triggerPrompt("同时补充测试");
    harness.appendBranch(messageEntry("user", "同时补充测试", 3), messageEntry("assistant", "已补充测试方案", 4));
    await harness.triggerPrompt("最后修复 CI 配置");

    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(2));
    const refinement = harness.generate.mock.calls[1]![0] as AutoTitleGenerateInput;
    expect(refinement.conversationText).toContain("User: 实现登录超时重试");
    expect(refinement.conversationText).toContain("Assistant: 我会检查认证流程");
    expect(refinement.conversationText).toContain("User: 最后修复 CI 配置");

    await harness.triggerPrompt("第四条消息不再触发");
    expect(harness.generate).toHaveBeenCalledTimes(2);
  });

  it("does not let the first generation overwrite a later refinement", async () => {
    const harness = await createHarness();
    let resolveFirst: ((title: string | undefined) => void) | undefined;
    let resolveThird: ((title: string | undefined) => void) | undefined;
    let callCount = 0;
    harness.generate.mockImplementation(
      async () =>
        new Promise<string | undefined>((resolve) => {
          callCount += 1;
          if (callCount === 1) resolveFirst = resolve;
          else resolveThird = resolve;
        }),
    );

    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("首个任务");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    harness.appendBranch(messageEntry("user", "首个任务", 1), messageEntry("assistant", "开始处理", 2));
    await harness.triggerPrompt("补充需求");
    harness.appendBranch(messageEntry("user", "补充需求", 3), messageEntry("assistant", "已完成分析", 4));
    await harness.triggerPrompt("最终目标");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(2));

    resolveThird?.("第三条标题");
    await vi.waitFor(() => expect(harness.setSessionName).toHaveBeenCalledWith("第三条标题"));
    resolveFirst?.("第一条标题");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.setSessionName).not.toHaveBeenCalledWith("第一条标题");
  });

  it("does not set a name when generation returns no title", async () => {
    const harness = await createHarness();
    harness.generate.mockResolvedValue(undefined);
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.setSessionName).toHaveBeenCalledWith("第一个问题");
    expect(harness.setSessionName).toHaveBeenCalledWith("");
    expect(harness.setSessionName).not.toHaveBeenCalledWith("自动标题");
  });

  it("swallows generation errors without blocking the session", async () => {
    const harness = await createHarness();
    harness.generate.mockRejectedValue(new Error("provider down"));
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.setSessionName).toHaveBeenCalledWith("第一个问题");
    expect(harness.setSessionName).toHaveBeenCalledWith("");
    expect(harness.setSessionName).not.toHaveBeenCalledWith("自动标题");
  });

  it("does not generate when the feature is disabled in the config file", async () => {
    const dir = await temporaryDirectory("desktop-auto-title-disabled-");
    const configPath = join(dir, "auto-title-config.json");
    await writeFile(configPath, JSON.stringify({ version: 1, enabled: false }));

    const harness = await createHarness({ configPath });
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("resolves the configured model override before the session model", async () => {
    const sessionModel = { provider: "session", id: "current" } as unknown as Model<Api>;
    const overrideModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as unknown as Model<Api>;
    const find = vi.fn(() => overrideModel);

    const model = resolveTitleModel(
      {
        model: sessionModel,
        modelRegistry: { find } as unknown as ExtensionContext["modelRegistry"],
      },
      { enabled: true, providerId: "anthropic", modelId: "claude-sonnet-4-5", systemPrompt: "", maxLength: 60 },
    );
    expect(model).toBe(overrideModel);
    expect(find).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");

    const fallback = resolveTitleModel(
      {
        model: sessionModel,
        modelRegistry: { find } as unknown as ExtensionContext["modelRegistry"],
      },
      { enabled: true, providerId: "", modelId: "", systemPrompt: "", maxLength: 60 },
    );
    expect(fallback).toBe(sessionModel);
  });
});

describe("normalizeTitle", () => {
  it("strips surrounding quotes and whitespace", () => {
    expect(normalizeTitle('  "修复登录问题"  ', 60)).toBe("修复登录问题");
    expect(normalizeTitle("「重构鉴权」", 60)).toBe("重构鉴权");
  });

  it("keeps only the first line", () => {
    expect(normalizeTitle("第一行\n第二行", 60)).toBe("第一行");
  });

  it("parses structured title responses and removes model wrappers", () => {
    expect(normalizeTitle('{"title":"修复登录问题。"}', 60)).toBe("修复登录问题");
    expect(normalizeTitle('```json\n{"title":"Fix auth flow"}\n```', 60)).toBe("Fix auth flow");
    expect(normalizeTitle("标题：修复鉴权。", 60)).toBe("修复鉴权");
  });

  it("clamps to maxLength", () => {
    expect(normalizeTitle("123456", 3)).toBe("12…");
  });

  it("removes synthetic prompt wrappers before deriving a title", () => {
    expect(cleanTitleText("<command-name>/help</command-name>")).toBeUndefined();
    expect(cleanTitleText("<ide_opened_file>src/app.ts</ide_opened_file>修复登录问题")).toBe("修复登录问题");
    expect(derivePlaceholderTitle("修复登录问题。请补充测试", 60)).toBe("修复登录问题。");
    expect(derivePlaceholderTitle("修复 src/app.ts 的登录问题", 60)).toBe("修复 src/app.ts 的登录问题");
    expect(derivePlaceholderTitle("Investigate example.com timeout", 60)).toBe("Investigate example.com timeout");
    expect(derivePlaceholderTitle("修复登录问题. 请补充测试", 60)).toBe("修复登录问题.");
  });

  it("builds a labeled conversation from user and assistant text", () => {
    const conversation = buildConversationText(
      [messageEntry("user", "实现 OAuth 登录", 1), messageEntry("assistant", "我会先检查回调路由", 2)],
      "再补充登录失败测试",
    );
    expect(conversation).toBe("User: 实现 OAuth 登录\nAssistant: 我会先检查回调路由\nUser: 再补充登录失败测试");
  });

  it("returns undefined for empty output", () => {
    expect(normalizeTitle("   ", 60)).toBeUndefined();
    expect(normalizeTitle("\n\n", 60)).toBeUndefined();
  });
});

describe("AutoTitleSettingsService", () => {
  it("returns defaults when the config file is missing", async () => {
    const dir = await temporaryDirectory("desktop-auto-title-settings-");
    const service = new AutoTitleSettingsService(dir);
    const snapshot = await service.getSnapshot();
    expect(snapshot.exists).toBe(false);
    expect(snapshot.settings.enabled).toBe(true);
    expect(snapshot.settings.providerId).toBe("");
    expect(snapshot.settings.modelId).toBe("");
    expect(snapshot.settings.systemPrompt.length).toBeGreaterThan(0);
    expect(snapshot.settings.maxLength).toBe(60);
  });

  it("saves settings and reads them back", async () => {
    const dir = await temporaryDirectory("desktop-auto-title-settings-");
    const service = new AutoTitleSettingsService(dir);
    const initial = await service.getSnapshot();

    const result = await service.saveConfig({
      expectedRevision: initial.revision,
      settings: {
        ...initial.settings,
        providerId: " anthropic ",
        modelId: "claude-sonnet-4-5",
        systemPrompt: "自定义提示词",
        maxLength: 40,
      },
    });
    expect(result.status).toBe("saved");

    const after = await service.getSnapshot();
    expect(after.exists).toBe(true);
    expect(after.settings.providerId).toBe("anthropic");
    expect(after.settings.modelId).toBe("claude-sonnet-4-5");
    expect(after.settings.systemPrompt).toBe("自定义提示词");
    expect(after.settings.maxLength).toBe(40);

    const raw = JSON.parse(await readFile(join(dir, "auto-title-config.json"), "utf-8"));
    expect(raw.version).toBe(1);
  });

  it("normalizes empty system prompt back to the default", async () => {
    const dir = await temporaryDirectory("desktop-auto-title-settings-");
    const service = new AutoTitleSettingsService(dir);
    const initial = await service.getSnapshot();

    const result = await service.saveConfig({
      expectedRevision: initial.revision,
      settings: { ...initial.settings, systemPrompt: "   " },
    });
    expect(result.status).toBe("saved");
    expect((await service.getSnapshot()).settings.systemPrompt).toBe(initial.settings.systemPrompt);
  });

  it("reports a conflict on stale revisions", async () => {
    const dir = await temporaryDirectory("desktop-auto-title-settings-");
    const service = new AutoTitleSettingsService(dir);
    const initial = await service.getSnapshot();

    const conflict = await service.saveConfig({
      expectedRevision: "stale-revision",
      settings: initial.settings,
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") {
      expect(conflict.current.revision).toBe(initial.revision);
    }
  });

  it("rejects invalid save input", async () => {
    const dir = await temporaryDirectory("desktop-auto-title-settings-");
    const service = new AutoTitleSettingsService(dir);
    const initial = await service.getSnapshot();

    await expect(
      service.saveConfig({
        expectedRevision: initial.revision,
        settings: { ...initial.settings, maxLength: 0 },
      }),
    ).rejects.toThrow("Invalid auto title settings save input");
  });

  it("collects model options from desktop built-ins and the runtime catalog", async () => {
    const dir = await temporaryDirectory("desktop-auto-title-settings-");
    const modelRuntime = {
      refresh: vi.fn(async () => undefined),
      getAvailable: vi.fn(async () => [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      ]),
    } as unknown as ModelRuntime;
    const service = new AutoTitleSettingsService(dir, {
      modelRuntime,
      isDesktopProviderAvailable: async () => true,
    });

    const options = await service.getModelOptions();
    expect(options).toContainEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    });
    expect(options).toContainEqual({
      provider: "meta-agent",
      modelId: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
    });
    const keys = options.map((option) => `${option.provider}/${option.modelId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(modelRuntime.refresh).toHaveBeenCalledWith({ allowNetwork: false });
  });

  it("filters out desktop built-ins without configured auth", async () => {
    const dir = await temporaryDirectory("desktop-auto-title-settings-");
    const service = new AutoTitleSettingsService(dir, {
      isDesktopProviderAvailable: async () => false,
    });

    const options = await service.getModelOptions();
    expect(options).toEqual([]);
  });
});
