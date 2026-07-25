import { describe, expect, it } from "vitest";
import { DesktopControlledExtensionRegistry } from "../src/main/extensions/desktop-extension-registry.ts";
import { DesktopBuiltinProviderRegistry } from "../src/main/pi/desktop-builtin-provider.ts";

describe("DesktopBuiltinProviderRegistry", () => {
  it("keeps main-owned metadata aligned with sidecar-only inline factories", () => {
    const definitions = DesktopControlledExtensionRegistry.getBuiltinDefinitions();
    const factories = DesktopBuiltinProviderRegistry.getExtensionFactories();
    expect(DesktopBuiltinProviderRegistry.getExtensionDefinitions()).toEqual(definitions);
    expect(factories).toHaveLength(definitions.length);
    expect(definitions).toContainEqual(
      expect.objectContaining({
        id: "pi-hermes-memory",
        source: "builtin",
        capabilities: expect.arrayContaining(["events.subscribe", "tools.register", "commands.register"]),
      }),
    );
    expect(definitions).toContainEqual(
      expect.objectContaining({
        id: "pi-subagents",
        source: "builtin",
        capabilities: expect.arrayContaining(["events.subscribe", "tools.register", "commands.register"]),
      }),
    );
    expect(factories.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["desktop:pi-hermes-memory", "desktop:pi-subagents"]),
    );
  });

  it("exposes built-in connection defaults to the settings editor", () => {
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

  it("builds a collision-free programmatic child profile without the parent orchestrator", () => {
    const factories = DesktopBuiltinProviderRegistry.getSubagentExtensionFactories(["provider", "memory", "runtime"]);
    const names = factories.map((factory) => factory.name);
    expect(names).toContain("desktop:pi-hermes-memory");
    expect(names).not.toContain("desktop:pi-subagents");
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps core providers authoritative when IDs collide", () => {
    const factoriesBefore = DesktopBuiltinProviderRegistry.getExtensionFactories();
    const providersBefore = DesktopBuiltinProviderRegistry.getKnownProviderInfos();

    DesktopBuiltinProviderRegistry.register("anthropic", {
      displayName: "Desktop Anthropic Override",
      envKeys: ["DESKTOP_ANTHROPIC_API_KEY"],
      defaultConfig: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      },
      models: [],
      extensionFactory: {
        name: "desktop:anthropic",
        factory: () => undefined,
      },
    });

    expect(DesktopBuiltinProviderRegistry.getExtensionFactories()).toEqual(factoriesBefore);
    expect(DesktopBuiltinProviderRegistry.getKnownProviderInfos()).toEqual(providersBefore);
  });
});
