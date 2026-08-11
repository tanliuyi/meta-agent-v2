import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import geminiModelIcon from "../src/renderer/src/assets/models/gemini.svg";
import qwenModelIcon from "../src/renderer/src/assets/models/qwen.svg";
import antgroupIcon from "../src/renderer/src/assets/providers/antgroup.svg";
import kimiIcon from "../src/renderer/src/assets/providers/kimi.svg";
import moonshotIcon from "../src/renderer/src/assets/providers/moonshot.svg";
import togetherIcon from "../src/renderer/src/assets/providers/together.svg";
import { ModelSelectorGroup } from "../src/renderer/src/components/assistant-ui/model-selector/model-selector-group.tsx";
import {
  getModelIconSource,
  getProviderIconSource,
} from "../src/renderer/src/components/assistant-ui/model-selector/model-selector-icons.tsx";
import {
  createModelSelectorOption,
  groupModelSelectorOptions,
} from "../src/renderer/src/components/assistant-ui/model-selector/model-selector-options.ts";
import { ProviderIcon } from "../src/renderer/src/components/assistant-ui/model-selector/provider-icon.tsx";
import { providerIcon } from "../src/renderer/src/shared/lib/provider-icons.ts";
import { Command } from "../src/renderer/src/shared/ui/command.tsx";

const baseModel = {
  provider: "openrouter",
  modelId: "anthropic/claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
};

describe("model selector icons", () => {
  test("resolves local provider assets for newly covered providers", () => {
    expect(getProviderIconSource("ant-ling")).toBe(antgroupIcon);
    expect(getProviderIconSource("kimi-coding")).toBe(kimiIcon);
    expect(getProviderIconSource("moonshotai")).toBe(moonshotIcon);
    expect(getProviderIconSource("together")).toBe(togetherIcon);
    expect(getProviderIconSource("radius")).toBeUndefined();
  });

  test("uses the model family asset before the transport provider asset", () => {
    expect(getModelIconSource(baseModel.provider, baseModel.modelId, baseModel.name)).toBe(providerIcon("anthropic"));
    expect(getModelIconSource("together", "Qwen/Qwen3.6-Plus", "Qwen3.6 Plus")).toBe(qwenModelIcon);
    expect(getModelIconSource("github-copilot", "gemini-3.1-pro-preview", "Gemini 3.1 Pro")).toBe(geminiModelIcon);
  });

  test("injects icons and provider metadata into shared selector options", () => {
    const option = createModelSelectorOption({
      id: "openrouter/anthropic/claude-sonnet-4-6",
      provider: baseModel.provider,
      modelId: baseModel.modelId,
      name: baseModel.name,
    });
    const groups = groupModelSelectorOptions([option]);

    expect(option.provider).toBe("openrouter");
    expect(option.description).toBe(baseModel.modelId);
    expect(option.icon).toBeDefined();
    expect(groups.get("openrouter")).toEqual([option]);
  });

  test("renders provider icons in group headings and keeps unknown providers empty", () => {
    const knownMarkup = renderToStaticMarkup(
      <Command>
        <ModelSelectorGroup provider="moonshotai" heading="Moonshot AI">
          <div>model</div>
        </ModelSelectorGroup>
      </Command>,
    );
    const unknownMarkup = renderToStaticMarkup(<ProviderIcon provider="radius" />);

    expect(knownMarkup).toContain("MoonshotAI");
    expect(knownMarkup).toContain("Moonshot AI");
    expect(unknownMarkup).toBe("");
  });
});
