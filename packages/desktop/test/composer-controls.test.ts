import { describe, expect, it } from "vitest";
import { createModelSelectorState } from "../src/renderer/src/components/chat/composer-control-model.ts";

describe("composer controls", () => {
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
