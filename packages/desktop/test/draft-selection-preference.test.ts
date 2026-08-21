import { describe, expect, it } from "vitest";
import {
  applyStoredDraftSelection,
  parseStoredDraftSelections,
  persistDraftSelection,
  readStoredDraftProject,
  readStoredDraftSelection,
  writeStoredDraftProject,
  writeStoredDraftSelection,
} from "../src/renderer/src/state/draft-selection-preference.ts";
import type { DraftSessionConfig } from "../src/shared/contracts.ts";

describe("draft selection preference", () => {
  it("按项目持久化并恢复模型与思考等级，互不串台", () => {
    const stored = JSON.stringify({ version: 1, projects: [] });
    let written: string | undefined;

    writeStoredDraftSelection(
      "project-a",
      { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "max" },
      () => stored,
      (value) => {
        written = value;
      },
    );
    writeStoredDraftSelection(
      "project-b",
      { provider: "openai", modelId: "gpt-5.5", thinkingLevel: "off" },
      () => written ?? null,
      (value) => {
        written = value;
      },
    );

    expect(readStoredDraftSelection("project-a", () => written ?? null)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      thinkingLevel: "max",
    });
    expect(readStoredDraftSelection("project-b", () => written ?? null)).toEqual({
      provider: "openai",
      modelId: "gpt-5.5",
      thinkingLevel: "off",
    });
    expect(readStoredDraftSelection("project-c", () => written ?? null)).toBeNull();
  });

  it("按项目持久化并恢复最近使用的项目", () => {
    let written: string | undefined;

    writeStoredDraftProject("project-b", (value) => {
      written = value;
    });

    expect(written).toBe("project-b");
    expect(readStoredDraftProject(() => written ?? null)).toBe("project-b");
    expect(readStoredDraftProject(() => "")).toBeNull();
    expect(
      readStoredDraftProject(() => {
        throw new Error("storage unavailable");
      }),
    ).toBeNull();
    expect(() =>
      writeStoredDraftProject("project-b", () => {
        throw new Error("storage unavailable");
      }),
    ).not.toThrow();
  });

  it("忽略损坏数据，并在存储不可用时保留交互能力", () => {
    expect(readStoredDraftSelection("project", () => "invalid")).toBeNull();
    expect(
      readStoredDraftSelection("project", () => {
        throw new Error("storage unavailable");
      }),
    ).toBeNull();
    expect(() =>
      writeStoredDraftSelection(
        "project",
        { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "medium" },
        () => null,
        () => {
          throw new Error("storage unavailable");
        },
      ),
    ).not.toThrow();
    expect([...parseStoredDraftSelections(null)]).toEqual([]);
    expect([...parseStoredDraftSelections(JSON.stringify({ version: 2, projects: [] }))]).toEqual([]);
    expect([
      ...parseStoredDraftSelections(
        JSON.stringify({
          version: 1,
          projects: [
            ["valid", { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "low" }],
            ["bad-thinking", { provider: "openai", modelId: "gpt-5.5", thinkingLevel: "turbo" }],
            ["bad-shape", { provider: "openai" }],
            ["not-a-pair", true],
          ],
        }),
      ),
    ]).toEqual([["valid", { provider: "anthropic", modelId: "claude-opus-4-8", thinkingLevel: "low" }]]);
  });

  it("配置加载后套用该项目最近一次的选择", () => {
    const config = draftConfig();
    const stored = JSON.stringify({
      version: 1,
      projects: [["project", { provider: "openai", modelId: "gpt-5.5", thinkingLevel: "off" }]],
    });

    const next = applyStoredDraftSelection(config, "project", () => stored);
    expect(next.model).toEqual({ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" });
    expect(next.thinkingLevel).toBe("off");
    expect(next.thinkingLevels).toEqual(["off", "medium", "high"]);
  });

  it("存储的模型或思考等级不可用时保持默认配置", () => {
    const config = draftConfig();
    const stored = JSON.stringify({
      version: 1,
      projects: [["project", { provider: "openai", modelId: "removed-model", thinkingLevel: "xhigh" }]],
    });

    expect(applyStoredDraftSelection(config, "project", () => stored)).toBe(config);
    expect(applyStoredDraftSelection(config, "project", () => null)).toBe(config);
  });

  it("persistDraftSelection 记录草稿当前选择，配置缺失时跳过", () => {
    const writes: string[] = [];
    persistDraftSelection(
      "project",
      draftConfig(),
      () => null,
      (value) => {
        writes.push(value);
      },
    );
    persistDraftSelection(
      "project",
      null,
      () => null,
      (value) => {
        writes.push(value);
      },
    );

    expect(writes).toHaveLength(1);
    expect(readStoredDraftSelection("project", () => writes[0] ?? null)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      thinkingLevel: "medium",
    });
  });
});

function draftConfig(): DraftSessionConfig {
  return {
    models: [
      {
        provider: "anthropic",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        contextWindow: 200000,
        thinking: true,
        thinkingLevels: ["off", "low", "medium", "high", "max"],
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        contextWindow: 200000,
        thinking: true,
        thinkingLevels: ["off", "medium", "high"],
      },
    ],
    commands: [],
    model: { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    thinkingLevel: "medium",
    thinkingLevels: ["off", "low", "medium", "high", "max"],
    readiness: { state: "ready" },
  };
}
