import { describe, expect, it } from "vitest";
import {
  createModelSelectorState,
  getThinkingLevelLabel,
} from "../src/renderer/src/components/chat/composer-control-model.ts";

describe("composer controls", () => {
  it("显示 thinking level 映射值，同时保留原始 level 作为查找键", () => {
    const labels = Object.fromEntries(
      (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => [
        level,
        getThinkingLevelLabel(level),
      ]),
    );

    expect(labels).toEqual({
      off: "关",
      minimal: "最小",
      low: "低",
      medium: "中",
      high: "高",
      xhigh: "极高",
      max: "最高",
    });
  });

  it("使用 provider 生成稳定且无冲突的模型键", () => {
    const openai = {
      provider: "openai",
      id: "shared-model",
      name: "OpenAI Shared",
      contextWindow: 128_000,
      thinking: true,
    };
    const anthropic = {
      provider: "anthropic",
      id: "shared-model",
      name: "Anthropic Shared",
      contextWindow: 200_000,
      thinking: true,
    };

    const result = createModelSelectorState([openai, anthropic]);

    expect(result.models.map(({ id }) => id)).toEqual(["openai:shared-model", "anthropic:shared-model"]);
    expect([...result.groups.keys()]).toEqual(["openai", "anthropic"]);
    expect(result.modelByKey.get("anthropic:shared-model")).toBe(anthropic);
  });
});
