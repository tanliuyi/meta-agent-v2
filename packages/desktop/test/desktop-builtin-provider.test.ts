import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopControlledExtensionRegistry } from "../src/main/extensions/desktop-extension-registry.ts";
import { DesktopBuiltinProviderRegistry } from "../src/main/pi/desktop-builtin-provider.ts";
import { controlledResourceLoaderOptions } from "../src/main/pi/desktop-extension-runtime-policy.ts";
import { PluginCallRegistryHolder } from "../src/main/pi/plugin-call/plugin-call-tool.ts";
import { DesktopPluginRegistryBuilder } from "../src/main/pi/plugin-call/plugin-method-registry.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
        capabilities: expect.arrayContaining(["events.subscribe", "plugin-methods.provide", "commands.register"]),
      }),
    );
    expect(definitions).toContainEqual(
      expect.objectContaining({
        id: "pi-rewind",
        source: "builtin",
        capabilities: ["events.subscribe", "messages.custom", "session.read", "ui.notify"],
      }),
    );
    expect(definitions).toContainEqual(
      expect.objectContaining({
        id: "pi-subagents",
        source: "builtin",
        capabilities: expect.arrayContaining(["events.subscribe", "plugin-methods.provide", "commands.register"]),
      }),
    );
    expect(factories.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["desktop:pi-hermes-memory", "desktop:pi-rewind", "desktop:pi-subagents"]),
    );
  });

  it("loads and captures every built-in plugin factory without exposing its tools", async () => {
    const root = join(tmpdir(), `desktop-builtin-capture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    tempDirs.push(root);
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

    const definitions = DesktopBuiltinProviderRegistry.getExtensionDefinitions();
    const set = {
      generation: "builtin-capture",
      projectId: "project",
      entries: definitions.map((entry) => ({ ...entry, capabilities: [...entry.capabilities] })),
      diagnostics: [],
      resolvedAt: 0,
    };
    const builder = new DesktopPluginRegistryBuilder();
    const holder = new PluginCallRegistryHolder(set.generation);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: controlledResourceLoaderOptions(
        set,
        DesktopBuiltinProviderRegistry.getExtensionFactories(),
        { pluginRegistry: holder, pluginRegistryBuilder: builder, cwd, agentDir },
      ),
    });

    expect(services.resourceLoader.getExtensions().errors).toEqual([]);
    const registry = builder.finalize();
    expect(registry.get("pi-subagents")?.has("subagent")).toBe(true);
    expect(registry.get("pi-subagents")?.has("subagent_wait")).toBe(true);
    expect(registry.get("pi-hermes-memory")?.has("memory")).toBe(true);
    expect(registry.get("pi-browser")?.has("browser_open")).toBe(true);
    const exposedTools = services.resourceLoader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    expect(exposedTools).toContain("plugin_call");
    expect(exposedTools).not.toContain("subagent");
    expect(exposedTools).not.toContain("memory");
    expect(exposedTools).not.toContain("browser_open");
    await holder.dispose();
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
