import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopExtensionSettingsService } from "../src/main/extensions/desktop-extension-settings-service.ts";
import { DesktopExtensionSourcePolicy } from "../src/main/extensions/desktop-extension-source-policy.ts";
import { CodexPluginInstaller } from "../src/main/plugins/codex/codex-plugin-installer.ts";
import { CodexPluginRegistry } from "../src/main/plugins/codex/codex-plugin-registry.ts";
import { PluginGenerationReferenceTracker } from "../src/main/plugins/plugin-generation-reference-tracker.ts";
import type { MetadataWorkerClient } from "../src/main/sidecar/metadata-worker-client.ts";
import type { SidecarRuntimeManifest } from "../src/main/sidecar/sidecar-runtime-manifest.ts";
import { type ThreadWorkerClient, ThreadWorkerRegistry } from "../src/main/sidecar/thread-worker-registry.ts";
import type { WorkerClientOptions } from "../src/main/sidecar/worker-client.ts";
import type { DraftSessionConfig, JsonValue, SessionBootstrap, Thread } from "../src/shared/contracts.ts";
import type { ResolvedExtensionSet } from "../src/shared/desktop-extension-contracts.ts";
import { SIDECAR_PROTOCOL_VERSION, type SidecarCommand } from "../src/shared/sidecar-contracts.ts";
import { MetadataWorkerService } from "../src/sidecar/metadata-worker-service.ts";
import { ThreadWorkerService } from "../src/sidecar/thread-worker-service.ts";

// Exercise the real Pi session and worker services with only the Codex adapter.
// No provider request is sent; credentials are local fixture values.
vi.mock("../src/main/pi/desktop-builtin-provider.ts", () => ({
  DesktopBuiltinProviderRegistry: { getExtensionFactories: () => [], getExtensionDefinitions: () => [] },
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function harness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-session-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const source = join(root, "source");
  await mkdir(agentDir);
  await mkdir(join(source, ".codex-plugin"), { recursive: true });
  await mkdir(join(source, "skills/review"), { recursive: true });
  await mkdir(join(source, "skills/invalid"), { recursive: true });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "local-fixture" } }));
  await writeFile(
    join(source, ".codex-plugin/plugin.json"),
    JSON.stringify({
      name: "review-plugin",
      version: "1.0.0",
      description: "Review",
      author: { name: "Test" },
    }),
  );
  await writeFile(
    join(source, "skills/review/SKILL.md"),
    "---\nname: review\ndescription: Review the code.\n---\nReview.",
  );
  await writeFile(join(source, "skills/invalid/SKILL.md"), "---\nname: invalid\n---\nMissing description.");
  const registry = new CodexPluginRegistry(root);
  const discovered = await registry.reconcile([
    {
      name: "review-plugin",
      version: "1.0.0",
      displayName: "Review",
      rootPath: source,
      marketplacePath: join(root, "marketplace.json"),
      sourcePath: "./source",
    },
  ]);
  const installer = new CodexPluginInstaller(registry, join(root, "locks"), join(root, "installed"));
  await installer.install({
    pluginId: "review-plugin",
    requestId: "install",
    expectedRevision: discovered.revision,
    confirmFullTrust: true,
  });
  const policy = new DesktopExtensionSourcePolicy({
    settings: new DesktopExtensionSettingsService(root, { builtinDefinitions: [], curatedDefinitions: [] }),
    getBuiltinDefinitions: () => [],
    getCuratedDefinitions: () => [],
    getCodexExtensions: () => registry.getSnapshot(),
  });
  const { service: metadata } = await MetadataWorkerService.create({
    role: "metadata",
    value: { agentDir, userDataDir: root },
  });
  cleanups.push(() => metadata.dispose());
  const getDraft = async (set = undefined as ResolvedExtensionSet | undefined) => {
    const current = set ?? (await policy.resolve("project"));
    return (await metadata.command({
      type: "getDraftConfig",
      projectId: "project",
      cwd: root,
      extensionSet: current,
      allEntries: current.entries,
    })) as DraftSessionConfig;
  };
  return { root, agentDir, source, registry, installer, policy, metadata, getDraft };
}

describe("Codex runtime and worker integration", () => {
  it("loads a new live session and metadata draft with matching skill commands and diagnostics", async () => {
    const h = await harness();
    const set = await h.policy.resolve("project");
    const draft = await h.getDraft(set);
    const model = draft.models.find((candidate) => candidate.provider === "openai");
    if (!model) throw new Error("Fixture provider was not available");
    const created = await ThreadWorkerService.create(
      {
        role: "thread",
        value: {
          mode: "create",
          projectId: "project",
          projectCwd: h.root,
          cwd: h.root,
          agentDir: h.agentDir,
          sessionId: randomUUID(),
          extensionSet: set,
          createInput: {
            projectId: "project",
            createRequestId: "new",
            extensionSetGeneration: set.generation,
            model: { provider: model.provider, id: model.id },
            thinkingLevel: "off",
          },
        },
      },
      { emit: () => undefined, requestHost: async () => undefined, flushEvents: async () => undefined },
    );
    cleanups.push(() => created.service.dispose());
    const live = created.readyResult as SessionBootstrap;
    expect(live.control.commands.filter((command) => command.source === "skill")).toEqual(
      draft.commands.filter((command) => command.source === "skill"),
    );
    expect(draft.commands.some((command) => command.name === "skill:review-plugin:review")).toBe(true);
    expect(draft.extensions.plugins).toEqual([
      { id: "review-plugin", displayName: "Review", source: "codex", available: true },
    ]);
    const codes = (diagnostics: Array<{ code: string }>) => diagnostics.map(({ code }) => code);
    expect(codes(live.control.extensionSet.diagnostics)).toEqual(codes(draft.extensions.diagnostics));
    expect(codes(draft.extensions.diagnostics)).toContain("CODEX_SKILL_INVALID");
    await expect(
      created.service.command({
        type: "reloadResources",
        input: { requestId: "reload", projectId: "project", threadId: live.threadId },
      }),
    ).resolves.toMatchObject({ accepted: true });
    const reloaded = (await created.service.command({ type: "bootstrap" })) as SessionBootstrap;
    expect(codes(reloaded.control.extensionSet.diagnostics)).toContain("CODEX_SKILL_INVALID");
    expect(set.entries[0]?.entryPath).toBeUndefined();
    expect(set.entries[0]?.capabilities).toEqual([]);
    await writeFile(join(set.entries[0]!.codexCompanions!.rootPath, "skills/review/SKILL.md"), "changed");
    await expect(h.getDraft(set)).rejects.toThrow("changed since resolution");
  });

  it("serializes replacement, rejects stale drafts, and rolls back with retained Codex resources", async () => {
    const h = await harness();
    const sessionId = randomUUID();
    const sessionFile = join(h.root, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: h.root, timestamp: new Date().toISOString() })}\n`,
    );
    const clients: ServiceWorkerClient[] = [];
    let failGeneration: string | undefined;
    let onReady: (() => Promise<void>) | undefined;
    const references = new PluginGenerationReferenceTracker();
    let indexed: Thread[] = [];
    const metadataClient = {
      list: async () => indexed,
      resolve: async () => ({ id: sessionId, path: sessionFile }),
      upsert: async (_project: string, _cwd: string, _file: string, summary: Thread) => {
        indexed = [summary];
      },
    } as unknown as MetadataWorkerClient;
    const workers = new ThreadWorkerRegistry({
      manifest: {} as SidecarRuntimeManifest,
      metadata: metadataClient,
      userDataDir: h.root,
      agentDir: h.agentDir,
      extensionSourcePolicy: h.policy,
      generationReferences: references,
      getCwd: () => h.root,
      resolveSessionCwd: async (_id, cwd) => cwd,
      getWorkspaceKey: async () => h.root,
      push: () => undefined,
      failed: () => undefined,
      resync: () => undefined,
      createWorkerClient: (options) => {
        expect(clients.every((client) => !client.available)).toBe(true);
        const client = new ServiceWorkerClient(
          options,
          () => failGeneration,
          async () => {
            const hook = onReady;
            onReady = undefined;
            await hook?.();
          },
        );
        clients.push(client);
        return client;
      },
    });
    cleanups.push(() => workers.dispose());
    const first = await workers.attach("project", sessionId);
    const oldSet = await h.policy.resolve("project");
    expect(references.isReferenced(oldSet.entries[0]!.codexCompanions!.rootPath)).toBe(true);
    await writeFile(
      join(h.source, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review version two.\n---\nUpdated.",
    );
    await h.installer.update({
      pluginId: "review-plugin",
      requestId: "update",
      expectedRevision: (await h.registry.getSnapshot()).revision,
      confirmFullTrust: true,
    });
    const desired = await h.policy.resolve("project");
    await expect(
      workers.create({
        projectId: "project",
        createRequestId: "stale",
        extensionSetGeneration: oldSet.generation,
        model: { provider: "openai", id: "unused" },
        thinkingLevel: "off",
      }),
    ).rejects.toMatchObject({ code: "STALE_DRAFT_EXTENSION_SET" });
    expect(clients).toHaveLength(1);
    failGeneration = desired.generation;
    expect(await workers.applyExtensionSet("project", sessionId, desired.generation)).toMatchObject({
      status: "rolled-back",
      generation: oldSet.generation,
    });
    const rollback = await workers.attach("project", sessionId);
    expect(rollback.control.commands).toEqual(first.control.commands);
    expect(rollback.control.extensionSet.reloadRequired).toBe(true);
    failGeneration = undefined;
    expect(await workers.applyExtensionSet("project", sessionId, desired.generation)).toMatchObject({
      status: "applied",
    });
    const updated = await workers.attach("project", sessionId);
    expect(updated.control.commands.filter((command) => command.source === "skill")).toEqual(
      (await h.getDraft()).commands.filter((command) => command.source === "skill"),
    );
    expect(await workers.applySessionPluginSelection("project", sessionId, [])).toMatchObject({ status: "applied" });
    expect(
      (await workers.attach("project", sessionId)).control.commands.some((command) =>
        command.name.includes("review-plugin"),
      ),
    ).toBe(false);
    await writeFile(
      join(h.source, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Version three.\n---\nUpdated again.",
    );
    await h.installer.update({
      pluginId: "review-plugin",
      requestId: "update-again",
      expectedRevision: (await h.registry.getSnapshot()).revision,
      confirmFullTrust: true,
    });
    failGeneration = (await h.policy.resolve("project")).generation;
    expect(await workers.applyExtensionSet("project", sessionId, failGeneration)).toMatchObject({
      status: "rolled-back",
    });
    expect((await workers.getSessionPluginOptions("project", sessionId)).enabledPluginIds).toEqual([]);
    failGeneration = undefined;
    onReady = async () => {
      await writeFile(
        join(h.source, "skills/review/SKILL.md"),
        "---\nname: review\ndescription: Changed during selection.\n---\nReview.",
      );
      await h.installer.update({
        pluginId: "review-plugin",
        requestId: "during-selection",
        expectedRevision: (await h.registry.getSnapshot()).revision,
        confirmFullTrust: true,
      });
    };
    expect(await workers.applySessionPluginSelection("project", sessionId, null)).toMatchObject({
      status: "rolled-back",
      error: expect.stringContaining("changed during apply"),
    });
    expect((await workers.getSessionPluginOptions("project", sessionId)).enabledPluginIds).toEqual([]);
    expect((await workers.getExtensionState("project", sessionId)).reloadRequired).toBe(true);
    failGeneration = undefined;
    await clients.at(-1)!.crash();
    const recovered = await workers.attach("project", sessionId);
    expect(recovered.control.extensionSet.generation).toBe((await h.policy.resolve("project")).generation);
    expect(recovered.control.commands.some((command) => command.name.includes("review-plugin"))).toBe(false);
    expect((await workers.getSessionPluginOptions("project", sessionId)).enabledPluginIds).toEqual([]);
  });
});

/** In-process transport seam; real worker validation, SessionRuntime and disposal run unchanged. */
class ServiceWorkerClient implements ThreadWorkerClient {
  readonly instanceId = randomUUID();
  available = true;
  private readonly options: WorkerClientOptions;
  private readonly failGeneration: () => string | undefined;
  private readonly onReady: () => Promise<void>;
  private service?: ThreadWorkerService;

  constructor(options: WorkerClientOptions, failGeneration: () => string | undefined, onReady: () => Promise<void>) {
    this.options = options;
    this.failGeneration = failGeneration;
    this.onReady = onReady;
  }

  async ready() {
    if (this.options.binding.role !== "thread") throw new Error("Expected thread");
    if (this.options.binding.value.extensionSet.generation === this.failGeneration())
      throw new Error("projection is missing: injected startup failure");
    const created = await ThreadWorkerService.create(this.options.binding, {
      emit: () => undefined,
      requestHost: async () => undefined,
      flushEvents: async () => undefined,
    });
    this.service = created.service;
    await this.onReady();
    return {
      kind: "ready" as const,
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: this.instanceId,
      role: "thread" as const,
      runtime: this.options.manifest.compatibility,
      result: created.readyResult as JsonValue,
    };
  }
  async request<T>(command: SidecarCommand): Promise<T> {
    return (await this.service?.command(command)) as T;
  }
  acknowledge(): void {}
  async shutdown(): Promise<void> {
    await this.service?.dispose();
    this.available = false;
  }
  async crash(): Promise<void> {
    await this.shutdown();
    this.options.onFailure?.(new Error("Injected worker exit"));
  }
}
