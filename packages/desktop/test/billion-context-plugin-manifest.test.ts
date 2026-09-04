import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveDevelopmentEntry } from "../src/main/extensions/desktop-extension-directory.ts";
import { controlledResourceLoaderOptions } from "../src/main/pi/desktop-extension-runtime-policy.ts";

const pluginDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../plugins/billion-context-pi");

describe("Billion Context development manifest", () => {
  it("exposes the Desktop configuration schema through the development resolver", async () => {
    const entry = await resolveDevelopmentEntry(pluginDirectory);

    expect(entry.displayName).toBe("Billion Context");
    expect(entry.pluginId).toBe("pi.billion-context");
    expect(entry.capabilities).toEqual(
      expect.arrayContaining(["configuration.read", "events.subscribe", "tools.register"]),
    );
    expect(entry.configurationSchema?.version).toBe(1);
    expect(entry.configurationSchema?.fields.map(({ key }) => key)).toEqual([
      "modelContextLimit",
      "preserveRecentMessages",
      "toolBashDefaultTimeout",
      "toolOutputMaxBytes",
      "debug",
    ]);
  });

  it("does not declare a programmatic plugin catalog", async () => {
    const resolved = await resolveDevelopmentEntry(pluginDirectory);
    expect(resolved.capabilities).toContain("tools.register");
    expect(resolved.capabilities).not.toContain("plugin-methods.provide");
    expect(resolved.runCodeCatalog).toBeUndefined();
  });

  it("does not route native tools through the programmatic registry", async () => {
    const resolved = await resolveDevelopmentEntry(pluginDirectory);
    const options = controlledResourceLoaderOptions(
      {
        projectId: "test",
        generation: "generation",
        entries: [{ ...resolved, id: "development:billion-context", source: "development", hostProfileVersion: 1 }],
        diagnostics: [],
      },
      [],
      { includeBuiltinSkills: false },
    );

    expect(options.extensionFactories.some((extension) => extension.name === "<inline:desktop-run-code>")).toBe(false);
  });

  it("registers its tools with the native Pi API", async () => {
    const resolved = await resolveDevelopmentEntry(pluginDirectory);
    const options = controlledResourceLoaderOptions(
      {
        projectId: "test",
        generation: "generation",
        entries: [{ ...resolved, id: "development:billion-context", source: "development", hostProfileVersion: 1 }],
        diagnostics: [],
      },
      [],
      { includeBuiltinSkills: false },
    );
    const factory = options.extensionFactories.find((extension) => extension.name === "development:billion-context");
    if (!factory || typeof factory === "function") throw new Error("Billion Context factory was not loaded");
    const registered: string[] = [];
    await factory.factory({
      registerTool(tool: { name: string }) {
        registered.push(tool.name);
      },
      on() {},
      registerCommand() {},
    } as never);

    expect(registered).toEqual(["compress", "decompress", "search_context", "acp_status"]);
  });
});
