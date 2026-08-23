import { describe, expect, it } from "vitest";
import { DesktopBuiltinProviderRegistry } from "../src/main/pi/desktop-builtin-provider.ts";

describe("DesktopBuiltinProviderRegistry", () => {
  it("exposes Meta Agent connection defaults to the Pi settings editor", () => {
    expect(DesktopBuiltinProviderRegistry.getProviderInfos()).toContainEqual({
      id: "meta-agent",
      displayName: "Meta Agent Provider",
      envKeys: ["META_AGENT_API_KEY"],
      defaultConfig: {
        name: "Meta Agent Provider",
        api: "openai-responses",
        baseUrl: "http://[fd7a:115c:a1e0::7c3b:e60b]:8080",
        authHeader: true,
      },
      models: expect.arrayContaining([
        expect.objectContaining({
          id: "gpt-5.6-terra",
          api: "openai-responses",
          baseUrl: "http://[fd7a:115c:a1e0::7c3b:e60b]:8080",
          contextWindow: 372000,
        }),
      ]),
    });
  });

  it("keeps core providers authoritative when IDs collide", () => {
    const providersBefore = DesktopBuiltinProviderRegistry.getKnownProviderInfos();

    DesktopBuiltinProviderRegistry.register("anthropic", {
      displayName: "Desktop Anthropic Override",
      envKeys: ["DESKTOP_ANTHROPIC_API_KEY"],
      defaultConfig: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      },
      models: [],
    });

    expect(DesktopBuiltinProviderRegistry.getKnownProviderInfos()).toEqual(providersBefore);
  });
});
