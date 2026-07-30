import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { discoverAgents } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import { SubagentSettingsConfigService } from "../src/main/subagents/subagent-settings-config-service.ts";

let root = "";
let agentDir = "";
let projectDir = "";
let previousAgentDir: string | undefined;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
const sourceBuiltinAgentsDir = fileURLToPath(new URL("../src/main/pi/extensions/pi-subagents/agents", import.meta.url));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desktop-subagent-settings-"));
  agentDir = join(root, "agent");
  projectDir = join(root, "project");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(join(projectDir, ".pi-desk"), { recursive: true })]);
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});

afterEach(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  await rm(root, { recursive: true, force: true });
});

async function createService(builtinAgentsDir = sourceBuiltinAgentsDir): Promise<SubagentSettingsConfigService> {
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
  });
  return new SubagentSettingsConfigService({
    agentDir,
    builtinAgentsDir,
    modelRuntime,
    getProjectCwd: () => projectDir,
  });
}

describe("SubagentSettingsConfigService", () => {
  test("defaults to the user scope instead of the active project", async () => {
    const snapshot = await (await createService()).getSnapshot();

    expect(snapshot.projectId).toBeUndefined();
    expect(snapshot.projectAgents).toEqual([]);
  });

  test("excludes project memory files from user agent discovery", async () => {
    const modernUserDir = join(root, ".agents");
    await mkdir(join(modernUserDir, "projects", "example", "memory"), { recursive: true });
    await writeFile(
      join(modernUserDir, "personal-helper.md"),
      "---\nname: personal-helper\ndescription: Real personal agent\n---\n\nHelp with personal tasks.\n",
      "utf8",
    );
    await writeFile(
      join(modernUserDir, "projects", "example", "memory", "preference.md"),
      "---\nname: remembered-preference\ndescription: A memory entry, not an agent\n---\n\nRemember this preference.\n",
      "utf8",
    );

    const snapshot = await (await createService()).getSnapshot();

    expect(snapshot.userAgents.map((agent) => agent.name)).toContain("personal-helper");
    expect(snapshot.userAgents.map((agent) => agent.name)).not.toContain("remembered-preference");
  });

  test("excludes project memory files from runtime user agent discovery", async () => {
    const modernUserDir = join(root, ".agents");
    await Promise.all([
      mkdir(join(modernUserDir, "projects", "example", "memory"), { recursive: true }),
      mkdir(join(projectDir, ".pi-desk", "agents"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(modernUserDir, "personal-helper.md"),
        "---\nname: personal-helper\ndescription: Real personal agent\n---\n\nHelp with personal tasks.\n",
        "utf8",
      ),
      writeFile(
        join(modernUserDir, "projects", "example", "memory", "preference.md"),
        "---\nname: remembered-preference\ndescription: A memory entry, not an agent\n---\n\nRemember this preference.\n",
        "utf8",
      ),
      writeFile(
        join(projectDir, ".pi-desk", "agents", "project-helper.md"),
        "---\nname: project-helper\ndescription: Real project agent\n---\n\nHelp with project tasks.\n",
        "utf8",
      ),
    ]);
    await createService();

    const discovered = discoverAgents(projectDir, "both");
    const names = discovered.agents.map((agent) => agent.name);

    expect(names).toContain("personal-helper");
    expect(names).toContain("project-helper");
    expect(names).not.toContain("remembered-preference");
  });

  test("returns pristine builtins for the system scope", async () => {
    await writeFile(
      join(agentDir, "settings.json"),
      '{"subagents":{"agentOverrides":{"reviewer":{"model":"openai/user-reviewer"}}}}\n',
      "utf8",
    );
    const service = await createService();

    const userSnapshot = await service.getSnapshot();
    const systemSnapshot = await service.getSnapshot({ settingsScope: "system" });

    expect(userSnapshot.builtinAgents.find((agent) => agent.name === "reviewer")).toMatchObject({
      model: "openai/user-reviewer",
      overridden: true,
      overrideScope: "user",
    });
    expect(systemSnapshot.builtinAgents.find((agent) => agent.name === "reviewer")).not.toHaveProperty("overridden");
    expect(systemSnapshot.userAgents).toEqual([]);
    expect(systemSnapshot.projectAgents).toEqual([]);
  });

  test("rejects scoped agent mutations from the system view", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot({ settingsScope: "system" });

    await expect(
      service.saveConfig({
        requestId: "system-agent-mutation",
        settingsScope: "system",
        expectedSnapshotRevision: snapshot.revision,
        mutation: { type: "set-agent-enabled", agent: "reviewer", disabled: true, scope: "user" },
      }),
    ).rejects.toThrow("only allow extension configuration updates");
  });

  test("discovers bundled agents and exposes extension defaults", async () => {
    const snapshot = await (await createService()).getSnapshot({ projectId: "project" });

    expect(snapshot.builtinAgents.map((agent) => agent.name)).toEqual(
      expect.arrayContaining([
        "reviewer",
        "worker",
        "planner",
        "oracle",
        "researcher",
        "scout",
        "context-builder",
        "advisor",
        "delegate",
      ]),
    );
    expect(snapshot.extensionConfig).toMatchObject({
      asyncByDefault: false,
      asyncWidget: true,
      maxSubagentDepth: 1,
      maxSubagentSpawnsPerSession: 0,
      globalConcurrencyLimit: 20,
      toolDescriptionMode: "full",
      artifactDir: "project",
      scheduledRuns: { enabled: false },
    });
    expect(snapshot.projectScopeAvailable).toBe(true);
  });

  test("uses a host-provided builtin directory after module bundling", async () => {
    const bundledAgentsDir = join(root, "sidecar", "main", "pi", "extensions", "pi-subagents", "agents");
    await mkdir(bundledAgentsDir, { recursive: true });
    await writeFile(
      join(bundledAgentsDir, "packaged-only.md"),
      "---\nname: packaged-only\ndescription: Packaged agent fixture\n---\n\nUse the packaged fixture.\n",
      "utf8",
    );

    const snapshot = await (await createService(bundledAgentsDir)).getSnapshot({ projectId: "project" });

    expect(snapshot.builtinAgents.map((agent) => agent.name)).toEqual(["packaged-only"]);
  });

  test("creates, updates, and deletes user agents and chains", async () => {
    const service = await createService();
    let snapshot = await service.getSnapshot({ projectId: "project" });

    let result = await service.saveConfig({
      requestId: "create-agent",
      projectId: "project",
      expectedSnapshotRevision: snapshot.revision,
      mutation: {
        type: "create-agent",
        scope: "user",
        config: {
          name: "desktop-helper",
          description: "Desktop helper",
          model: false,
          systemPrompt: "Help with Desktop tasks.",
          tools: ["read", "mcp:files.search"],
        },
      },
    });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    snapshot = result.snapshot;
    expect(snapshot.userAgents).toContainEqual(
      expect.objectContaining({
        name: "desktop-helper",
        description: "Desktop helper",
        tools: ["read"],
        mcpDirectTools: ["files.search"],
      }),
    );

    result = await service.saveConfig({
      requestId: "create-chain",
      projectId: "project",
      expectedSnapshotRevision: snapshot.revision,
      mutation: {
        type: "create-chain",
        scope: "user",
        config: {
          name: "desktop-flow",
          description: "Desktop workflow",
          steps: [{ agent: "desktop-helper", task: "Inspect the current task", progress: true }],
        },
      },
    });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    snapshot = result.snapshot;
    expect(snapshot.chains).toContainEqual(
      expect.objectContaining({ name: "desktop-flow", source: "user", stepCount: 1, editable: true }),
    );

    result = await service.saveConfig({
      requestId: "update-agent",
      projectId: "project",
      expectedSnapshotRevision: snapshot.revision,
      mutation: {
        type: "update-agent",
        target: "custom",
        agent: "desktop-helper",
        scope: "user",
        config: { description: "Updated Desktop helper", thinking: "high" },
      },
    });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    snapshot = result.snapshot;
    expect(snapshot.userAgents.find((agent) => agent.name === "desktop-helper")).toMatchObject({
      description: "Updated Desktop helper",
      thinking: "high",
    });

    result = await service.saveConfig({
      requestId: "delete-chain",
      projectId: "project",
      expectedSnapshotRevision: snapshot.revision,
      mutation: { type: "delete-chain", chain: "desktop-flow", scope: "user" },
    });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(result.snapshot.chains.some((chain) => chain.name === "desktop-flow")).toBe(false);
  });

  test("persists builtin overrides and extension config", async () => {
    const service = await createService();
    let snapshot = await service.getSnapshot({ projectId: "project" });

    let result = await service.saveConfig({
      requestId: "override-reviewer",
      projectId: "project",
      expectedSnapshotRevision: snapshot.revision,
      mutation: {
        type: "update-agent",
        target: "builtin",
        agent: "reviewer",
        scope: "user",
        config: { model: "openai/test-reviewer", thinking: "high" },
      },
    });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    snapshot = result.snapshot;
    expect(snapshot.builtinAgents.find((agent) => agent.name === "reviewer")).toMatchObject({
      model: "openai/test-reviewer",
      thinking: "high",
      overridden: true,
      overrideScope: "user",
    });

    result = await service.saveConfig({
      requestId: "extension-config",
      projectId: "project",
      expectedSnapshotRevision: snapshot.revision,
      mutation: {
        type: "update-extension-config",
        config: { maxSubagentDepth: 3, globalConcurrencyLimit: 8, scheduledRuns: { enabled: true } },
      },
    });
    expect(result.status).toBe("saved");
    const stored = JSON.parse(await readFile(join(agentDir, "extensions", "subagent", "config.json"), "utf8"));
    expect(stored).toMatchObject({
      maxSubagentDepth: 3,
      globalConcurrencyLimit: 8,
      scheduledRuns: { enabled: true },
    });
  });

  test("persists scoped watchdog settings with project inheritance", async () => {
    const service = await createService();
    let userSnapshot = await service.getSnapshot();

    expect(userSnapshot.watchdog).toMatchObject({
      effective: { enabled: false, main: { enabled: false }, children: { enabled: false } },
      inherited: { enabled: false, main: { enabled: false }, children: { enabled: false } },
      override: { main: {}, children: {} },
    });

    const userResult = await service.saveConfig({
      requestId: "user-watchdog",
      expectedSnapshotRevision: userSnapshot.revision,
      mutation: {
        type: "update-watchdog-config",
        scope: "user",
        config: {
          enabled: true,
          main: { enabled: false, model: "openai/reviewer", thinking: "high" },
        },
      },
    });
    expect(userResult.status).toBe("saved");
    if (userResult.status !== "saved") return;
    userSnapshot = userResult.snapshot;
    expect(userSnapshot.watchdog).toMatchObject({
      effective: { enabled: true, main: { enabled: false, model: "openai/reviewer", thinking: "high" } },
      inherited: { enabled: false, main: { enabled: false }, children: { enabled: false } },
      override: {
        enabled: true,
        main: { enabled: false, model: "openai/reviewer", thinking: "high" },
      },
    });

    let projectSnapshot = await service.getSnapshot({ settingsScope: "project", projectId: "project" });
    expect(projectSnapshot.watchdog).toMatchObject({
      effective: { enabled: true, main: { enabled: false, model: "openai/reviewer", thinking: "high" } },
      inherited: { enabled: true, main: { enabled: false, model: "openai/reviewer", thinking: "high" } },
      override: { main: {}, children: {} },
    });

    const projectResult = await service.saveConfig({
      requestId: "project-watchdog",
      settingsScope: "project",
      projectId: "project",
      expectedSnapshotRevision: projectSnapshot.revision,
      mutation: {
        type: "update-watchdog-config",
        scope: "project",
        config: {
          enabled: null,
          main: { model: null, thinking: null },
          children: { enabled: true, model: "openai/child-reviewer", thinking: "medium" },
        },
      },
    });
    expect(projectResult.status).toBe("saved");
    if (projectResult.status !== "saved") return;
    projectSnapshot = projectResult.snapshot;
    expect(projectSnapshot.watchdog).toMatchObject({
      effective: {
        enabled: true,
        main: { enabled: false, model: "openai/reviewer", thinking: "high" },
        children: { enabled: true, model: "openai/child-reviewer", thinking: "medium" },
      },
      inherited: {
        enabled: true,
        main: { enabled: false, model: "openai/reviewer", thinking: "high" },
      },
      override: {
        main: {},
        children: { enabled: true, model: "openai/child-reviewer", thinking: "medium" },
      },
    });

    const userSettings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    const projectSettings = JSON.parse(await readFile(join(projectDir, ".pi-desk", "settings.json"), "utf8"));
    expect(userSettings.subagents.watchdog).toMatchObject({
      enabled: true,
      main: { enabled: false, model: "openai/reviewer", thinking: "high" },
    });
    expect(projectSettings.subagents.watchdog.children).toMatchObject({
      enabled: true,
      model: "openai/child-reviewer",
      thinking: "medium",
    });
  });

  test("rejects watchdog mutations that escape the selected settings scope", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();

    await expect(
      service.saveConfig({
        requestId: "watchdog-scope-mismatch",
        expectedSnapshotRevision: snapshot.revision,
        mutation: {
          type: "update-watchdog-config",
          scope: "project",
          config: { enabled: true },
        },
      }),
    ).rejects.toThrow("does not match 'user' settings");
    await expect(service.getSnapshot({ settingsScope: "project" } as never)).rejects.toThrow("require a projectId");
    await expect(service.getSnapshot({ settingsScope: "user", projectId: "project" } as never)).rejects.toThrow(
      "do not accept a projectId",
    );
  });

  test("reports malformed watchdog settings without failing the settings page", async () => {
    await writeFile(join(agentDir, "settings.json"), '{"subagents":{"watchdog":{"enabled":"yes"}}}\n', "utf8");

    const snapshot = await (await createService()).getSnapshot();

    expect(snapshot.watchdog.effective.enabled).toBe(false);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SUBAGENT_WATCHDOG_CONFIG_INVALID", phase: "resolve" }),
    );
  });

  test("marks chains with unsupported steps or fields as read-only", async () => {
    const chainDir = join(agentDir, "chains");
    await mkdir(chainDir, { recursive: true });
    await writeFile(
      join(chainDir, "advanced.chain.json"),
      `${JSON.stringify(
        {
          name: "advanced",
          description: "Advanced workflow",
          chain: [{ parallel: [{ agent: "reviewer" }, { agent: "worker" }] }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const snapshot = await (await createService()).getSnapshot({ projectId: "project" });

    expect(snapshot.chains.find((chain) => chain.name === "advanced")).toMatchObject({
      editable: false,
      stepCount: 1,
      steps: [],
    });
  });

  test("reports malformed extension config and refuses to overwrite it", async () => {
    const configPath = join(agentDir, "extensions", "subagent", "config.json");
    await mkdir(join(agentDir, "extensions", "subagent"), { recursive: true });
    await writeFile(configPath, "{ malformed\n", "utf8");
    const service = await createService();
    const snapshot = await service.getSnapshot({ projectId: "project" });

    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SUBAGENT_CONFIG_INVALID", phase: "resolve" }),
    );
    await expect(
      service.saveConfig({
        requestId: "malformed-config",
        projectId: "project",
        expectedSnapshotRevision: snapshot.revision,
        mutation: { type: "update-extension-config", config: { globalConcurrencyLimit: 4 } },
      }),
    ).rejects.toThrow();
    await expect(readFile(configPath, "utf8")).resolves.toBe("{ malformed\n");
  });

  test("updates and toggles a builtin override in project scope", async () => {
    const service = await createService();
    let snapshot = await service.getSnapshot({ projectId: "project" });
    const projectResult = await service.saveConfig({
      requestId: "project-override",
      projectId: "project",
      expectedSnapshotRevision: snapshot.revision,
      mutation: {
        type: "update-agent",
        target: "builtin",
        agent: "reviewer",
        scope: "project",
        config: { model: "openai/project-reviewer" },
      },
    });
    if (projectResult.status !== "saved") return;
    snapshot = projectResult.snapshot;

    const disabledResult = await service.saveConfig({
      requestId: "disable-project-override",
      projectId: "project",
      expectedSnapshotRevision: snapshot.revision,
      mutation: {
        type: "set-agent-enabled",
        agent: "reviewer",
        scope: "project",
        disabled: true,
      },
    });

    expect(disabledResult.status).toBe("saved");
    if (disabledResult.status !== "saved") return;
    expect(disabledResult.snapshot.builtinAgents.find((agent) => agent.name === "reviewer")).toMatchObject({
      model: "openai/project-reviewer",
      overrideScope: "project",
      disabled: true,
    });
    const projectSettings = JSON.parse(await readFile(join(projectDir, ".pi-desk", "settings.json"), "utf8"));
    expect(projectSettings.subagents.agentOverrides.reviewer).toMatchObject({
      model: "openai/project-reviewer",
      disabled: true,
    });
  });

  test("returns a conflict after an external source change", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot({ projectId: "project" });
    await writeFile(join(agentDir, "settings.json"), '{"subagents":{"defaultModel":"external/model"}}\n', "utf8");

    await expect(
      service.saveConfig({
        requestId: "stale",
        projectId: "project",
        expectedSnapshotRevision: snapshot.revision,
        mutation: { type: "set-agent-enabled", agent: "reviewer", disabled: true },
      }),
    ).resolves.toMatchObject({ status: "conflict" });
  });

  test("rejects duplicate names in the same scope", async () => {
    const service = await createService();
    let snapshot = await service.getSnapshot({ projectId: "project" });
    const first = await service.saveConfig({
      requestId: "first",
      projectId: "project",
      expectedSnapshotRevision: snapshot.revision,
      mutation: {
        type: "create-agent",
        scope: "user",
        config: { name: "duplicate", description: "First" },
      },
    });
    if (first.status !== "saved") return;
    snapshot = first.snapshot;

    await expect(
      service.saveConfig({
        requestId: "second",
        projectId: "project",
        expectedSnapshotRevision: snapshot.revision,
        mutation: {
          type: "create-agent",
          scope: "user",
          config: { name: "duplicate", description: "Second" },
        },
      }),
    ).rejects.toThrow("already exists in user scope");
  });
});
