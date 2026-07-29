import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { ModelsCompatEditor } from "../src/renderer/src/features/settings/models-compat-editor.tsx";
import { ModelsProviderForm } from "../src/renderer/src/features/settings/models-provider-form.tsx";
import { createProviderDraft } from "../src/renderer/src/features/settings/models-settings-model.ts";
import { ProviderBuiltInModelDetail } from "../src/renderer/src/features/settings/provider-built-in-model-detail.tsx";
import { ProviderCard } from "../src/renderer/src/features/settings/provider-card.tsx";
import { ProviderCredentialsForm } from "../src/renderer/src/features/settings/provider-credentials-form.tsx";
import { groupProviderEntries } from "../src/renderer/src/features/settings/providers-settings-page.tsx";
import type { ProviderEntry } from "../src/shared/providers-config-contracts.ts";

const metadata = {
  knownApis: ["openai-completions", "anthropic-messages"],
  builtInProviders: [
    {
      id: "anthropic",
      displayName: "Anthropic",
      models: [{ id: "claude", name: "Claude", api: "anthropic-messages" }],
    },
  ],
};

function providerEntry(key: string, source: ProviderEntry["source"], builtInModelCount = 0): ProviderEntry {
  return {
    key,
    displayName: key,
    source,
    builtInModelCount,
    credentialStatus: "missing",
    models: [],
    modelOverrides: [],
  };
}

describe("models settings components", () => {
  test("renders apiKey as a directly editable password input", () => {
    const provider = createProviderDraft("local");
    provider.config.apiKey = "!printf raw-command";
    const markup = renderToStaticMarkup(
      <ModelsProviderForm provider={provider} metadata={metadata} onChange={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(markup).toContain('type="password"');
    expect(markup).toContain('value="!printf raw-command"');
  });

  test("offers OAuth login for a supported built-in provider", () => {
    const markup = renderToStaticMarkup(
      <ProviderCredentialsForm
        entryKey="anthropic"
        knownProvider={{
          id: "anthropic",
          displayName: "Anthropic",
          envKeys: ["ANTHROPIC_API_KEY"],
          oauth: { name: "Anthropic" },
        }}
        oauthDisabled={false}
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onOauthLogin={vi.fn()}
      />,
    );
    expect(markup).toContain("使用 OAuth 登录");
  });

  test("groups providers with Desktop and plugin registrations first", () => {
    const groups = groupProviderEntries([
      providerEntry("custom", "custom"),
      providerEntry("radius", "ai-builtin"),
      providerEntry("meta-agent", "desktop-builtin"),
    ]);

    expect(groups.map(({ key }) => key)).toEqual(["builtin", "custom"]);
    expect(groups.map(({ providers }) => providers.map(({ key }) => key))).toEqual([
      ["meta-agent", "radius"],
      ["custom"],
    ]);
  });

  test("labels a core provider without a static catalog as dynamic", () => {
    const entry = providerEntry("radius", "ai-builtin");

    const markup = renderToStaticMarkup(<ProviderCard entry={entry} onEdit={vi.fn()} />);

    expect(markup).toContain("动态模型目录");
    expect(markup).not.toContain("0 个自定义模型");
    expect(markup).not.toContain("内置(desktop)");
  });

  test("renders an exact built-in model count", () => {
    const markup = renderToStaticMarkup(
      <ProviderCard entry={providerEntry("anthropic", "ai-builtin", 3)} onEdit={vi.fn()} />,
    );

    expect(markup).toContain("3 个内置模型");
    expect(markup).not.toContain("3+ 内置模型");
  });

  test("renders complete built-in model metadata", () => {
    const markup = renderToStaticMarkup(
      <ProviderBuiltInModelDetail
        model={{
          id: "catalog-model",
          name: "Catalog Model",
          api: "openai-responses",
          baseUrl: "https://models.example.test/v1",
          reasoning: true,
          thinkingLevelMap: { high: "high" },
          input: ["text", "image"],
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          contextWindow: 128000,
          maxTokens: 32000,
          headers: { "x-catalog": "enabled" },
          compat: { supportsToolSearch: true },
        }}
      />,
    );
    for (const value of [
      "Catalog Model",
      "catalog-model",
      "openai-responses",
      "https://models.example.test/v1",
      "128,000",
      "思考等级映射",
      "x-catalog",
      "supportsToolSearch",
    ]) {
      expect(markup).toContain(value);
    }
  });

  test("renders every current compat control and structured routing editors", () => {
    const markup = renderToStaticMarkup(
      <ModelsCompatEditor
        value={{
          config: {
            allowEmptySignature: true,
            supportsTemperature: false,
            supportsOpenAIGrammarTools: true,
            supportsStrictTools: true,
            openRouterRouting: {},
            vercelGatewayRouting: {},
          },
          chatTemplateKwargs: [{ key: "enable_thinking", value: { $var: "thinking.enabled" } }],
        }}
        onChange={vi.fn()}
      />,
    );
    for (const field of [
      "allowEmptySignature",
      "supportsTemperature",
      "supportsOpenAIGrammarTools",
      "supportsStrictTools",
      "supportsToolSearch",
      "maxTokensField",
      "thinkingFormat",
      "sessionAffinityFormat",
      "chatTemplateKwargs",
      "OpenRouter routing",
      "Vercel AI Gateway routing",
      "preferred_min_throughput",
      "preferred_max_latency",
    ]) {
      expect(markup).toContain(field);
    }
    expect(markup).not.toContain("textarea");
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('role="checkbox"');
  });
});
