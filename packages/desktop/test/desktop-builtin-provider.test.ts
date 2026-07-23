import { describe, expect, it } from "vitest";
import { DesktopControlledExtensionRegistry } from "../src/main/extensions/desktop-extension-registry.ts";
import { DesktopBuiltinProviderRegistry } from "../src/main/pi/desktop-builtin-provider.ts";

describe("DesktopBuiltinProviderRegistry", () => {
  it("keeps main-owned metadata aligned with sidecar-only inline factories", () => {
    expect(DesktopBuiltinProviderRegistry.getExtensionDefinitions()).toEqual(
      DesktopControlledExtensionRegistry.getBuiltinDefinitions(),
    );
    expect(DesktopBuiltinProviderRegistry.getExtensionFactories()).toHaveLength(
      DesktopControlledExtensionRegistry.getBuiltinDefinitions().length,
    );
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
