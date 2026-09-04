import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveDevelopmentEntry } from "../src/main/extensions/desktop-extension-directory.ts";
import { controlledResourceLoaderOptions } from "../src/main/pi/desktop-extension-runtime-policy.ts";
import { DesktopPluginRegistryBuilder } from "../src/main/pi/run-code/plugin-method-registry.ts";
import { RunCodeRegistryHolder } from "../src/main/pi/run-code/run-code-tool.ts";
import type { ResolvedExtensionSet } from "../src/shared/desktop-extension-contracts.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const pluginDirectories = ["pi-image-gen", "pi-officecli", "pi-stef-figma", "pi-web-access-desktop"];

describe("programmatic plugin manifests", () => {
  it.each(pluginDirectories)("exposes %s only through run_code", async (pluginName) => {
    const entry = await resolveDevelopmentEntry(resolve(repositoryRoot, "packages/plugins", pluginName));
    if (!entry.pluginId) throw new Error(`Missing plugin ID for ${pluginName}`);
    expect(entry.capabilities).toContain("plugin-methods.provide");
    expect(entry.capabilities).not.toContain("tools.register");
    expect(entry.runCodeSkill).toBeTruthy();
    expect(entry.runCodeCatalog?.methods.length).toBeGreaterThan(0);
    expect(
      entry.runCodeCatalog?.methods.some(
        (method) => Object.keys((method.parameters.properties as Record<string, unknown> | undefined) ?? {}).length > 0,
      ),
    ).toBe(true);
    const apiReference = await readFile(
      resolve(repositoryRoot, "packages/plugins", pluginName, "skills", entry.runCodeSkill!, "references/api.md"),
      "utf8",
    );
    const skill = await readFile(
      resolve(repositoryRoot, "packages/plugins", pluginName, "skills", entry.runCodeSkill!, "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain(`plugin["${entry.pluginId}"]`);
    for (const method of entry.runCodeCatalog?.methods ?? []) expect(apiReference).toContain(`## ${method.name}`);

    const set: ResolvedExtensionSet = {
      projectId: "programmatic-plugin-test",
      generation: `programmatic-${pluginName}`,
      entries: [
        {
          ...entry,
          id: `development:${entry.pluginId}`,
          source: "development",
          hostProfileVersion: 1,
        },
      ],
      diagnostics: [],
    };
    const builder = new DesktopPluginRegistryBuilder();
    const holder = new RunCodeRegistryHolder(set.generation);
    try {
      const services = await createAgentSessionServices({
        cwd: repositoryRoot,
        resourceLoaderOptions: controlledResourceLoaderOptions(set, [], {
          pluginRegistry: holder,
          pluginRegistryBuilder: builder,
          cwd: repositoryRoot,
        }),
      });
      expect(services.resourceLoader.getExtensions().errors).toEqual([]);
      expect(
        services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]),
      ).toEqual(["run_code"]);
      expect(builder.finalize().get(entry.pluginId)?.size).toBe(entry.runCodeCatalog?.methods.length);
    } finally {
      await holder.dispose();
    }
  });
});
