import type { ModelRegistry, ResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  loadDraftSessionConfig,
  resolveSessionCreateSelection,
  resolveSessionResumeSelection,
  type SessionConfigurationServices,
} from "../src/main/pi/session-configuration.ts";

const reasoningModel = {
  id: "reasoning-model",
  name: "Reasoning Model",
  api: "anthropic-messages" as const,
  provider: "reasoning",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const plainModel = {
  ...reasoningModel,
  id: "plain-model",
  name: "Plain Model",
  provider: "plain",
  reasoning: false,
};

describe("draft session configuration", () => {
  it("使用 Pi 默认模型解析且不需要创建 AgentSession", async () => {
    const config = await loadDraftSessionConfig("/workspace", services(), undefined, {
      generation: "extensions-generation",
      projectId: "project",
      entries: [],
      diagnostics: [],
      resolvedAt: 0,
    });

    expect(config).toMatchObject({
      model: { provider: "reasoning", id: "reasoning-model" },
      thinkingLevel: "high",
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      readiness: { state: "ready" },
      extensions: { extensionSetGeneration: "extensions-generation", diagnostics: [] },
    });
    expect(config.models).toEqual([
      expect.objectContaining({ provider: "reasoning", thinkingLevels: ["off", "minimal", "low", "medium", "high"] }),
      expect.objectContaining({ provider: "plain", thinkingLevels: ["off"] }),
    ]);
    expect(config.commands).toEqual([
      { name: "memory-insights", description: "Inspect memories", source: "extension" },
    ]);
  });

  it("显式 create 选择失效时拒绝，不静默 fallback", () => {
    const { models } = services();

    expect(() =>
      resolveSessionCreateSelection(
        {
          projectId: "project",
          createRequestId: "create",
          extensionSetGeneration: "extensions-generation",
          model: { provider: "missing", id: "missing" },
          thinkingLevel: "high",
        },
        models,
      ),
    ).toThrow("模型不存在: missing/missing");
  });

  it("显式 create 使用 Pi 规则 clamp thinking", () => {
    const { models } = services();

    expect(
      resolveSessionCreateSelection(
        {
          projectId: "project",
          createRequestId: "create",
          extensionSetGeneration: "extensions-generation",
          model: { provider: "plain", id: "plain-model" },
          thinkingLevel: "high",
        },
        models,
      ),
    ).toEqual({ model: plainModel, thinkingLevel: "off" });
  });

  it("恢复已有 thread 时使用 session 文件里的 model 和 thinking", () => {
    const { models } = services();
    const sessionManager = sessionManagerWithContext("reasoning", "reasoning-model", "medium");

    expect(resolveSessionResumeSelection(sessionManager, models)).toEqual({
      model: reasoningModel,
      thinkingLevel: "medium",
    });
  });

  it("恢复已有 thread 时无法使用原模型则交回 Pi fallback", () => {
    const { models } = services();
    const sessionManager = sessionManagerWithContext("missing", "missing", "medium");

    expect(resolveSessionResumeSelection(sessionManager, models)).toBeUndefined();
  });
});

function sessionManagerWithContext(provider: string, modelId: string, thinkingLevel: string): SessionManager {
  return {
    buildSessionContext: () => ({ messages: [], model: { provider, modelId }, thinkingLevel }),
  } as unknown as SessionManager;
}

function services(): SessionConfigurationServices {
  const available = [reasoningModel, plainModel];
  const models = {
    getAvailable: () => available,
    getAll: () => available,
    find: (provider: string, modelId: string) =>
      available.find((model) => model.provider === provider && model.id === modelId),
    hasConfiguredAuth: () => true,
  } as unknown as ModelRegistry;
  const settings = {
    getDefaultProvider: () => reasoningModel.provider,
    getDefaultModel: () => reasoningModel.id,
    getDefaultThinkingLevel: () => "high" as const,
  } as unknown as SettingsManager;
  const resources = {
    getExtensions: () => ({
      extensions: [
        {
          commands: new Map([["memory-insights", { name: "memory-insights", description: "Inspect memories" }]]),
        },
      ],
    }),
    getPrompts: () => ({ prompts: [] }),
    getSkills: () => ({ skills: [] }),
  } as unknown as ResourceLoader;
  return { models, settings, resources };
}
