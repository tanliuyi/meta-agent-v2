import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { ModelsCompatEditor } from "../src/renderer/src/features/settings/models-compat-editor.tsx";
import { ModelsProviderForm } from "../src/renderer/src/features/settings/models-provider-form.tsx";
import { ModelsProviderList } from "../src/renderer/src/features/settings/models-provider-list.tsx";
import { createProviderDraft } from "../src/renderer/src/features/settings/models-settings-model.ts";

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

describe("models settings components", () => {
  test("renders apiKey as a directly editable password input", () => {
    const provider = createProviderDraft("local");
    provider.config.apiKey = "!printf raw-command";
    const markup = renderToStaticMarkup(
      <ModelsProviderForm provider={provider} metadata={metadata} onChange={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(markup).toContain('type="password"');
    expect(markup).toContain('value="!printf raw-command"');
    expect(markup).toContain("Provider ID");
    expect(markup).toContain("Base URL");
  });

  test("renders every current compat control and structured routing editors", () => {
    const markup = renderToStaticMarkup(
      <ModelsCompatEditor
        value={{
          config: {
            allowEmptySignature: true,
            supportsTemperature: false,
            zaiToolStream: true,
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
      "zaiToolStream",
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

  test("uses provider indices to distinguish temporarily duplicate editable keys", () => {
    const first = createProviderDraft("duplicate");
    first.origin = { providerKey: "first" };
    const second = createProviderDraft("duplicate");
    second.origin = { providerKey: "second" };

    const markup = renderToStaticMarkup(
      <ModelsProviderList
        providers={[first, second]}
        metadata={metadata}
        selectedIndex={1}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
      />,
    );

    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup.match(/aria-selected="false"/g)).toHaveLength(1);
  });
});
