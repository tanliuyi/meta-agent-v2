import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AuthApiKeyForm } from "../src/renderer/src/features/settings/auth-api-key-form.tsx";
import { AuthOauthDisplay } from "../src/renderer/src/features/settings/auth-oauth-display.tsx";
import { AuthProviderDetail } from "../src/renderer/src/features/settings/auth-provider-detail.tsx";
import { AuthProviderList } from "../src/renderer/src/features/settings/auth-provider-list.tsx";
import type { AuthProviderDraft, AuthProviderInfo } from "../src/shared/auth-config-contracts.ts";

const knownProviders: AuthProviderInfo[] = [
  { id: "anthropic", displayName: "Anthropic", envKeys: ["ANTHROPIC_API_KEY"] },
  { id: "openai", displayName: "OpenAI", envKeys: ["OPENAI_API_KEY"] },
];

const apiKeyProvider: AuthProviderDraft = {
  key: "anthropic",
  apiKey: { key: "sk-ant-test-key-12345", env: [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-alt" }] },
};

const oauthProvider: AuthProviderDraft = {
  key: "github-copilot",
  oauth: {
    providerName: "GitHub Copilot",
    expires: "2026-12-31T23:59:59.000Z",
    expired: false,
  },
};

const unconfiguredProvider: AuthProviderDraft = {
  key: "custom-provider",
};

describe("AuthProviderList", () => {
  test("renders provider keys and type badges", () => {
    const html = renderToStaticMarkup(
      <AuthProviderList
        providers={[apiKeyProvider, oauthProvider]}
        knownProviders={knownProviders}
        selectedKey="anthropic"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    expect(html).toContain("anthropic");
    expect(html).toContain("github-copilot");
    expect(html).toContain("API Key");
    expect(html).toContain("OAuth");
  });

  test("shows masked API key preview", () => {
    const html = renderToStaticMarkup(
      <AuthProviderList
        providers={[apiKeyProvider]}
        knownProviders={knownProviders}
        selectedKey={undefined}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    expect(html).toContain("sk-ant...2345");
  });

  test("shows auth.json source badge for configured providers", () => {
    const html = renderToStaticMarkup(
      <AuthProviderList
        providers={[apiKeyProvider]}
        knownProviders={knownProviders}
        selectedKey={undefined}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    expect(html).toContain("auth.json");
  });
});

describe("AuthApiKeyForm", () => {
  test("renders key input with password type", () => {
    const html = renderToStaticMarkup(
      <AuthApiKeyForm provider={apiKeyProvider} knownProviders={knownProviders} onChange={vi.fn()} />,
    );
    expect(html).toContain("sk-ant-test-key-12345");
    expect(html).toContain('type="password"');
  });

  test("shows known env info", () => {
    const html = renderToStaticMarkup(
      <AuthApiKeyForm provider={apiKeyProvider} knownProviders={knownProviders} onChange={vi.fn()} />,
    );
    expect(html).toContain("ANTHROPIC_API_KEY");
  });
});

describe("AuthOauthDisplay", () => {
  test("shows provider name and expiry", () => {
    const html = renderToStaticMarkup(<AuthOauthDisplay provider={oauthProvider} onRemove={vi.fn()} />);
    expect(html).toContain("GitHub Copilot");
    expect(html).toContain("移除凭据");
  });
});

describe("AuthProviderDetail", () => {
  test("shows API key form for apiKey provider", () => {
    const html = renderToStaticMarkup(
      <AuthProviderDetail
        provider={apiKeyProvider}
        knownProviders={knownProviders}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(html).toContain("Anthropic");
  });

  test("shows OAuth display for OAuth provider", () => {
    const html = renderToStaticMarkup(
      <AuthProviderDetail
        provider={oauthProvider}
        knownProviders={knownProviders}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(html).toContain("GitHub Copilot");
  });

  test("shows add button for unconfigured provider", () => {
    const html = renderToStaticMarkup(
      <AuthProviderDetail
        provider={unconfiguredProvider}
        knownProviders={knownProviders}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(html).toContain("添加 API Key");
  });
});
