import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piAutoTitle, {
  type AutoTitleGenerateInput,
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
  triggerShutdown(): Promise<void>;
}

async function createHarness(
  options: { configPath?: string; getSessionName?: () => string | undefined } = {},
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

  const context = {
    sessionManager: { getSessionId: () => "session-1" },
    model: { provider: "test", id: "fake-model" } as unknown as Model<Api>,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
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
    async triggerShutdown() {
      await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
    },
  };
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

    await vi.waitFor(() => expect(harness.getSessionName).toHaveBeenCalledTimes(2));
    expect(harness.setSessionName).not.toHaveBeenCalled();
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
    expect(harness.setSessionName).not.toHaveBeenCalled();
  });

  it("generates only once per session", async () => {
    const harness = await createHarness();
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    await harness.triggerPrompt("第二个问题");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.generate).toHaveBeenCalledTimes(1);
  });

  it("does not set a name when generation returns no title", async () => {
    const harness = await createHarness();
    harness.generate.mockResolvedValue(undefined);
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.setSessionName).not.toHaveBeenCalled();
  });

  it("swallows generation errors without blocking the session", async () => {
    const harness = await createHarness();
    harness.generate.mockRejectedValue(new Error("provider down"));
    await harness.triggerSessionStart("new");
    await harness.triggerPrompt("第一个问题");
    await vi.waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.setSessionName).not.toHaveBeenCalled();
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

  it("clamps to maxLength", () => {
    expect(normalizeTitle("123456", 3)).toBe("123");
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
