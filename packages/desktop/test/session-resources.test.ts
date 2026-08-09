import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  controlledResourceLoaderOptions,
  extensionLoadDiagnostics,
  validateResolvedExtensionSet,
} from "../src/main/pi/desktop-extension-runtime-policy.ts";

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
      { extensions: [], errors: [{ path: "/approved/broken.ts", error: "syntax error" }] },
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
