import { describe, expect, test } from "vitest";
import { groupSubagentModels } from "../src/renderer/src/features/settings/subagents/subagent-model-options.ts";
import { currentCsvToken, replaceCurrentCsvToken } from "../src/renderer/src/shared/ui/combobox.tsx";

describe("subagent settings models", () => {
  test("groups model options by provider without changing their order", () => {
    const groups = groupSubagentModels([
      { id: "openai/gpt-5", provider: "openai", name: "GPT-5", reasoning: true, thinkingLevels: ["off"] },
      { id: "meta-agent/sol", provider: "meta-agent", name: "Sol", reasoning: true, thinkingLevels: ["off"] },
      { id: "openai/gpt-4", provider: "openai", name: "GPT-4", reasoning: false, thinkingLevels: ["off"] },
    ]);

    expect([...groups.keys()]).toEqual(["openai", "meta-agent"]);
    expect(groups.get("openai")?.map((model) => model.id)).toEqual(["openai/gpt-5", "openai/gpt-4"]);
  });

  test("filters skill suggestions using only the unfinished CSV token", () => {
    expect(currentCsvToken("runtime, mark")).toBe("mark");
    expect(currentCsvToken("runtime, ")).toBe("");
  });

  test("adds a selected skill without replacing existing skills", () => {
    expect(replaceCurrentCsvToken("runtime, mark", "markdown")).toBe("runtime, markdown");
    expect(replaceCurrentCsvToken("runtime, ", "markdown")).toBe("runtime, markdown");
    expect(replaceCurrentCsvToken("runtime, runtime", "runtime")).toBe("runtime");
  });
});
