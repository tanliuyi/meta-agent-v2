import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  controlledResourceLoaderOptions,
  extensionLoadDiagnostics,
  validateResolvedExtensionSet,
} from "../src/main/pi/desktop-extension-runtime-policy.ts";
import { DesktopPluginRegistryBuilder } from "../src/main/pi/run-code/plugin-method-registry.ts";
import { RunCodeRegistryHolder } from "../src/main/pi/run-code/run-code-tool.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("desktop controlled Pi resources", () => {
  it("blocks default extensions while preserving explicit paths, inline factories, and skills", async () => {
    const root = join(tmpdir(), `desktop-pi-resources-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const approvedPath = join(root, "approved.ts");
    tempDirs.push(root);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(agentDir, "skills", "global-review"), { recursive: true });
    await mkdir(join(agentDir, "prompts"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "unapproved.ts"),
      'export default function (pi) { pi.registerCommand("unapproved", { handler() {} }); }\n',
    );
    await writeFile(
      approvedPath,
      'export default function (pi) { pi.registerCommand("approved", { handler() {} }); }\n',
    );
    await writeFile(
      join(agentDir, "skills", "global-review", "SKILL.md"),
      "---\nname: global-review\ndescription: Review code from the global skill directory.\n---\n\n# Global Review\n",
    );
    await writeFile(
      join(agentDir, "prompts", "global-review.md"),
      "---\ndescription: Review the current project.\n---\n\nReview the current project.\n",
    );

    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        noExtensions: true,
        additionalExtensionPaths: [approvedPath],
        extensionFactories: [
          {
            name: "desktop:inline",
            factory: (pi) => pi.registerCommand("inline", { handler() {} }),
          },
        ],
      },
    });

    const commands = services.resourceLoader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.commands.keys()]);
    expect(services.resourceLoader.getExtensions().errors).toEqual([]);
    expect(commands).toEqual(["approved", "inline"]);
    expect(commands).not.toContain("unapproved");
    expect(services.resourceLoader.getSkills().skills.map(({ name }) => name)).toContain("global-review");
    expect(services.resourceLoader.getPrompts().prompts.map(({ name }) => name)).toContain("global-review");
  });

  it("captures plugin tools without exposing their schemas to Pi", async () => {
    const parameters = Type.Object({ value: Type.String() }, { additionalProperties: false });
    const entry = {
      id: "captured-plugin",
      displayName: "Captured plugin",
      source: "builtin" as const,
      hostProfileVersion: 1 as const,
      capabilities: ["plugin-methods.provide" as const],
      runCodeSkill: "captured-plugin",
      runCodeCatalog: {
        schemaVersion: 1 as const,
        pluginId: "captured-plugin",
        methods: [
          {
            name: "hidden_action",
            description: "x".repeat(4_000),
            parameters: parameters as never,
            result: Type.Object({ text: Type.String() }, { additionalProperties: false }) as never,
            concurrency: "serial" as const,
          },
        ],
      },
    };
    const set = {
      generation: "capture-tools",
      projectId: "project",
      entries: [entry],
      diagnostics: [],
      resolvedAt: 0,
    };
    const builder = new DesktopPluginRegistryBuilder();
    const holder = new RunCodeRegistryHolder(set.generation);
    const services = await createAgentSessionServices({
      cwd: process.cwd(),
      resourceLoaderOptions: controlledResourceLoaderOptions(
        set,
        [
          {
            name: "desktop:captured-plugin",
            factory(pi) {
              pi.registerTool({
                name: "hidden_action",
                label: "Hidden action",
                description: "x".repeat(4_000),
                parameters,
                async execute() {
                  return { content: [{ type: "text", text: "ok" }], details: {} };
                },
              });
            },
          },
          {
            name: "desktop:host-infrastructure",
            factory(pi) {
              pi.registerTool({
                name: "native_helper",
                label: "Native helper",
                description: "Run host infrastructure",
                parameters: Type.Object({}, { additionalProperties: false }),
                async execute() {
                  return { content: [{ type: "text", text: "ok" }], details: {} };
                },
              });
            },
          },
        ],
        { pluginRegistry: holder, pluginRegistryBuilder: builder },
      ),
    });

    const registeredNames = services.resourceLoader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    expect(registeredNames.sort()).toEqual(["native_helper", "run_code"]);
    expect(builder.finalize().get("captured-plugin")?.has("hidden_action")).toBe(true);
    await holder.dispose();
  });

  it("rejects tool registration after a plugin factory completes", async () => {
    let registerLater: (() => void) | undefined;
    const entry = {
      id: "late-plugin",
      displayName: "Late plugin",
      source: "builtin" as const,
      hostProfileVersion: 1 as const,
      capabilities: ["plugin-methods.provide" as const],
      runCodeSkill: "late-plugin",
      runCodeCatalog: {
        schemaVersion: 1 as const,
        pluginId: "late-plugin",
        methods: [
          {
            name: "initial",
            description: "Initial method",
            parameters: Type.Object({}, { additionalProperties: false }) as never,
            result: Type.Object({ text: Type.String() }, { additionalProperties: false }) as never,
            concurrency: "serial" as const,
          },
        ],
      },
    };
    const builder = new DesktopPluginRegistryBuilder();
    const holder = new RunCodeRegistryHolder("late-generation");
    await createAgentSessionServices({
      cwd: process.cwd(),
      resourceLoaderOptions: controlledResourceLoaderOptions(
        {
          generation: "late-generation",
          projectId: "project",
          entries: [entry],
          diagnostics: [],
          resolvedAt: 0,
        },
        [
          {
            name: "desktop:late-plugin",
            factory(pi) {
              pi.registerTool({
                name: "initial",
                label: "Initial",
                description: "Initial method",
                parameters: Type.Object({}, { additionalProperties: false }),
                async execute() {
                  return { content: [{ type: "text", text: "ok" }] };
                },
              });
              registerLater = () =>
                pi.registerTool({
                  name: "late",
                  label: "Late",
                  description: "Late method",
                  parameters: Type.Object({}, { additionalProperties: false }),
                  async execute() {
                    return { content: [{ type: "text", text: "late" }] };
                  },
                });
            },
          },
        ],
        { pluginRegistry: holder, pluginRegistryBuilder: builder },
      ),
    });

    expect(registerLater).toBeTypeOf("function");
    expect(registerLater).toThrow("registered a tool after its factory completed");
    expect(builder.finalize().get("late-plugin")?.has("late")).toBe(false);
    await holder.dispose();
  });

  it("keeps built-in plugin lifecycle skills in root sessions while allowing subagent isolation", async () => {
    const root = join(tmpdir(), `desktop-builtin-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    tempDirs.push(root);
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        ...controlledResourceLoaderOptions(
          {
            generation: "builtins-only",
            projectId: "project",
            entries: [],
            diagnostics: [],
            resolvedAt: 0,
          },
          [],
        ),
        noSkills: true,
      },
    });

    const skills = services.resourceLoader.getSkills();
    expect(skills.diagnostics.filter(({ type }) => type === "error")).toEqual([]);
    expect(skills.skills.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["desktop-plugin-development", "plugin-create", "plugin-publish"]),
    );
    expect(skills.skills).toHaveLength(3);
    expect(skills.skills.find(({ name }) => name === "plugin-create")?.description).toContain(
      "standard Pi Extension plugins for Meta Agent Desktop",
    );
    expect(skills.skills.find(({ name }) => name === "plugin-publish")?.description).toContain(
      "publishes standard Pi Extension plugins",
    );

    const isolatedServices = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        ...controlledResourceLoaderOptions(
          {
            generation: "isolated-subagent",
            projectId: "project",
            entries: [],
            diagnostics: [],
            resolvedAt: 0,
          },
          [],
          { includeBuiltinSkills: false },
        ),
        noSkills: true,
      },
    });
    expect(isolatedServices.resourceLoader.getSkills().skills).toEqual([]);
  });

  it("injects immutable Desktop configuration into approved path extensions", async () => {
    const root = join(tmpdir(), `desktop-extension-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const configuredPath = join(root, "configured.ts");
    const emptyPath = join(root, "empty.ts");
    tempDirs.push(root);
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      configuredPath,
      `import { StringEnum } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export default function (pi) {
  if ([StringEnum, complete, formatSize, Text, Type.Object].some((value) => typeof value !== "function")) {
    throw new Error("Desktop virtual module is unavailable");
  }
  const config = pi.getConfig();
  if (!Object.isFrozen(config)) throw new Error("configuration must be frozen");
  try { config.token = "mutated"; } catch {}
  pi.registerCommand("configured-" + config.token, { handler() {} });
}\n`,
    );
    await writeFile(
      emptyPath,
      `export default function (pi) {
  const config = pi.getConfig();
  if (!Object.isFrozen(config) || Object.keys(config).length !== 0) throw new Error("empty configuration expected");
  pi.registerCommand("empty-config", { handler() {} });
}\n`,
    );

    const extensionSet = {
      generation: "configured",
      projectId: "project",
      entries: [
        {
          id: "development:configured",
          displayName: "configured.ts",
          source: "development" as const,
          entryPath: configuredPath,
          hostProfileVersion: 1 as const,
          capabilities: [],
          configuration: { token: "original", retries: 2, enabled: true },
        },
        {
          id: "development:empty",
          displayName: "empty.ts",
          source: "development" as const,
          entryPath: emptyPath,
          hostProfileVersion: 1 as const,
          capabilities: [],
        },
      ],
      diagnostics: [],
      resolvedAt: 0,
    };
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: controlledResourceLoaderOptions(extensionSet, []),
    });

    const extensions = services.resourceLoader.getExtensions();
    expect(extensions.errors).toEqual([]);
    expect(extensions.extensions.map(({ path }) => path)).toEqual([
      "<inline:development:configured>",
      "<inline:development:empty>",
    ]);
    expect(extensions.extensions.flatMap((extension) => [...extension.commands.keys()])).toEqual([
      "configured-original",
      "empty-config",
    ]);
  });

  it("accepts path-backed bytes changed after generation resolution", async () => {
    const root = join(tmpdir(), `desktop-extension-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const entryPath = join(root, "approved.ts");
    tempDirs.push(root);
    await mkdir(root, { recursive: true });
    const original = "export default function () {}\n";
    await writeFile(entryPath, original);
    const set = {
      generation: "generation",
      projectId: "project",
      entries: [
        {
          id: "development:approved",
          displayName: "approved.ts",
          source: "development" as const,
          entryPath,
          hostProfileVersion: 1 as const,
          capabilities: [],
        },
      ],
      diagnostics: [],
      resolvedAt: 0,
    };
    await expect(validateResolvedExtensionSet("project", set)).resolves.toMatchObject({ generation: "generation" });

    await writeFile(entryPath, "export default function changed() {}\n");

    await expect(validateResolvedExtensionSet("project", set)).resolves.toMatchObject({ generation: "generation" });
  });

  it("attributes Desktop-prefixed inline factory failures to their approved entry", () => {
    const diagnostics = extensionLoadDiagnostics(
      {
        generation: "generation",
        projectId: "project",
        entries: [
          {
            id: "pi-subagents",
            displayName: "Subagents",
            source: "builtin",
            hostProfileVersion: 1,
            capabilities: ["plugin-methods.provide"],
          },
        ],
        diagnostics: [],
        resolvedAt: 0,
      },
      { extensions: [], errors: [{ path: "<inline:desktop:pi-subagents>", error: "PLUGIN_DECLARATION_INVALID" }] },
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        extensionId: "pi-subagents",
        source: "builtin",
        code: "DESKTOP_EXTENSION_LOAD_FAILED",
        message: "PLUGIN_DECLARATION_INVALID",
      }),
    ]);
  });

  it("keeps controlled source identity on Pi loader failures", () => {
    const diagnostics = extensionLoadDiagnostics(
      {
        generation: "generation",
        projectId: "project",
        entries: [
          {
            id: "development:broken",
            displayName: "broken.ts",
            source: "development",
            entryPath: "/approved/broken.ts",
            hostProfileVersion: 1,
            capabilities: [],
          },
        ],
        diagnostics: [],
        resolvedAt: 0,
      },
      { extensions: [], errors: [{ path: "<inline:development:broken>", error: "syntax error" }] },
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        extensionId: "development:broken",
        source: "development",
        extensionSetGeneration: "generation",
        projectId: "project",
        code: "DESKTOP_EXTENSION_LOAD_FAILED",
      }),
    ]);
  });
});
