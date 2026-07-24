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
      extensionFactory: {
        name: "desktop:anthropic",
        factory: () => undefined,
      },
    });

    expect(DesktopBuiltinProviderRegistry.getExtensionFactories()).toEqual(factoriesBefore);
    expect(DesktopBuiltinProviderRegistry.getKnownProviderInfos()).toEqual(providersBefore);
  });
});
