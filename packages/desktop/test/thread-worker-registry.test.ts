import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtensionSourcePolicy } from "../src/main/extensions/desktop-extension-source-policy.ts";
import type { MetadataWorkerClient } from "../src/main/sidecar/metadata-worker-client.ts";
import type { SidecarRuntimeManifest } from "../src/main/sidecar/sidecar-runtime-manifest.ts";
import {
  type ThreadWorkerClient,
  ThreadWorkerRegistry,
  type ThreadWorkerRegistryOptions,
} from "../src/main/sidecar/thread-worker-registry.ts";
import type { WorkerClientOptions } from "../src/main/sidecar/worker-client.ts";
import {
  type JsonValue,
  PROTOCOL_VERSION,
  type SessionBootstrap,
  type SessionCreateInput,
  type SessionPushPayload,
  type Thread,
} from "../src/shared/contracts.ts";
import type { ResolvedExtensionEntry, ResolvedExtensionSet } from "../src/shared/desktop-extension-contracts.ts";
import {
  type CreationReservationRecovery,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarCommand,
  type SidecarEventBody,
  type SidecarReady,
} from "../src/shared/sidecar-contracts.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  parseSessionEntries: (content: string) => {
    const entries: unknown[] = [];
    for (const line of content.split("\n")) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Match SessionManager compatibility: malformed lines are skipped.
      }
    }
    return entries;
  },
}));

describe("ThreadWorkerRegistry", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "thread-worker-registry-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("single-flights concurrent opens for the same thread", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);

    const [first, second] = await Promise.all([
      registry.attach("project", "thread"),
      registry.attach("project", "thread"),
    ]);

    expect(first.threadId).toBe("thread");
    expect(second.threadId).toBe("thread");
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.requests.filter((type) => type === "bootstrap")).toHaveLength(2);
    registry.detach("project", "thread");
    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("passes the resolved shell fallback in the explicit thread binding", async () => {
    const harness = createHarness(userDataDir);
    harness.options.shellPath = "/managed/bin/bash";
    const registry = new ThreadWorkerRegistry(harness.options);

    await registry.attach("project", "thread");

    expect(harness.clients[0]?.shellPath).toBe("/managed/bin/bash");
    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("broadcasts revisioned model refreshes to every live thread worker", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await Promise.all([registry.attach("project", "first"), registry.attach("project", "second")]);

    await registry.refreshAllModels({ generation: 7 });

    expect(harness.clients).toHaveLength(2);
    for (const client of harness.clients) expect(client.requests).toContain("refreshModelConfiguration");
    registry.detach("project", "first");
    registry.detach("project", "second");
    await registry.dispose();
  });

  it("routes active subagent sessions without opening a second thread worker", async () => {
    const harness = createHarness(userDataDir);
    const acknowledgeSubagent = vi.fn(() => true);
    const cancelSubagent = vi.fn(async () => undefined);
    const readSubagentImageResource = vi.fn(async (_projectId: string, _threadId: string, resourceId: string) => ({
      resourceId,
      mimeType: "image/png",
      data: "image-body",
    }));
    harness.options.isActiveSubagentThread = (_projectId, threadId) => threadId === "subagent";
    harness.options.attachSubagent = async (_projectId, threadId) =>
      threadId === "subagent"
        ? { ...bootstrap(threadId), control: { ...bootstrap(threadId).control, interaction: "read-only" } }
        : undefined;
    harness.options.acknowledgeSubagent = acknowledgeSubagent;
    harness.options.cancelSubagent = cancelSubagent;
    harness.options.readSubagentImageResource = readSubagentImageResource;
    const registry = new ThreadWorkerRegistry(harness.options);

    await expect(registry.attach("project", "subagent")).resolves.toMatchObject({
      threadId: "subagent",
      control: { interaction: "read-only" },
    });
    await expect(registry.prewarm("project", "subagent")).resolves.toBeUndefined();
    await expect(registry.cancel("project", "subagent")).resolves.toEqual({ steering: [], followUp: [] });
    await expect(
      registry.readImageResource("project", "subagent", "00000000-0000-4000-8000-000000000001"),
    ).resolves.toEqual({
      resourceId: "00000000-0000-4000-8000-000000000001",
      mimeType: "image/png",
      data: "image-body",
    });
    registry.acknowledge("subagent-worker", 7);

    expect(harness.clients).toHaveLength(0);
    expect(readSubagentImageResource).toHaveBeenCalledWith(
      "project",
      "subagent",
      "00000000-0000-4000-8000-000000000001",
    );
    expect(cancelSubagent).toHaveBeenCalledWith("project", "subagent");
    expect(acknowledgeSubagent).toHaveBeenCalledWith("subagent-worker", 7);
    await registry.dispose();
  });

  it("falls back to a thread worker when the subagent completed during its bootstrap", async () => {
    const harness = createHarness(userDataDir);
    harness.options.isActiveSubagentThread = () => false;
    harness.options.attachSubagent = async () => {
      throw new Error("Subagent run completed during bootstrap");
    };
    const registry = new ThreadWorkerRegistry(harness.options);

    await expect(registry.attach("project", "thread")).resolves.toMatchObject({ threadId: "thread" });

    expect(harness.clients).toHaveLength(1);
    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("rethrows a subagent bootstrap failure while the subagent writer is still active", async () => {
    const harness = createHarness(userDataDir);
    harness.options.isActiveSubagentThread = () => true;
    harness.options.attachSubagent = async () => {
      throw new Error("Subagent bootstrap timed out");
    };
    const registry = new ThreadWorkerRegistry(harness.options);

    await expect(registry.attach("project", "thread")).rejects.toThrow("Subagent bootstrap timed out");

    expect(harness.clients).toHaveLength(0);
    await registry.dispose();
  });

  it("releases the thread worker lease first when subagent and thread leases briefly coexist", async () => {
    vi.useFakeTimers({ now: 0 });
    const harness = createHarness(userDataDir, { idleTtlMs: 1 });
    let subagentActive = true;
    harness.options.isActiveSubagentThread = (_projectId, threadId) => subagentActive && threadId === "thread";
    harness.options.attachSubagent = async (_projectId, threadId) =>
      subagentActive && threadId === "thread"
        ? { ...bootstrap(threadId), control: { ...bootstrap(threadId).control, interaction: "read-only" } }
        : undefined;
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    subagentActive = false;
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");

    registry.detach("project", "thread");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.shutdownCount).toBe(1);
    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("retains a generation reference for each live worker and releases it after shutdown", async () => {
    const retain = vi.fn();
    const release = vi.fn();
    const harness = createHarness(userDataDir, { generationReferences: { retain, release } });
    const registry = new ThreadWorkerRegistry(harness.options);

    await registry.attach("project", "thread");
    const client = harness.clients[0]!;
    expect(retain).toHaveBeenCalledWith(
      `thread:${client.instanceId}`,
      expect.objectContaining({ projectId: "project" }),
    );

    await registry.dispose();
    expect(release).toHaveBeenCalledWith(`thread:${client.instanceId}`);
  });

  it("loads draft configuration through the metadata worker", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);

    await expect(registry.getDraftConfig("project")).resolves.toMatchObject({
      readiness: { state: "missing-model" },
    });
    expect(harness.options.metadata.getDraftConfig).toHaveBeenCalledWith(
      "project",
      "/workspace",
      expect.objectContaining({ generation: "extensions-generation" }),
      [],
    );
    expect(harness.clients).toHaveLength(0);
    await registry.dispose();
  });

  it("loads draft configuration from the selected worktree cwd", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);

    await registry.getDraftConfig("project", "/workspace-linked");

    expect(harness.options.metadata.getDraftConfig).toHaveBeenCalledWith(
      "project",
      "/workspace-linked",
      expect.objectContaining({ generation: "extensions-generation" }),
      [],
    );
    await registry.dispose();
  });

  it("rejects an indexed session cwd before spawning a worker", async () => {
    const harness = createHarness(userDataDir);
    harness.options.resolveSessionCwd = vi.fn(async () => {
      throw new Error("Session cwd is outside the project worktrees");
    });
    const registry = new ThreadWorkerRegistry(harness.options);

    await expect(registry.attach("project", "thread")).rejects.toThrow("outside the project worktrees");

    expect(harness.clients).toHaveLength(0);
    await registry.dispose();
  });

  it("allows temporary overflow when every capacity slot is busy", async () => {
    const readyGate = deferred<void>();
    const harness = createHarness(userDataDir, { readyGate, maxLiveWorkers: 1 });
    const registry = new ThreadWorkerRegistry(harness.options);
    const firstAttach = registry.attach("project", "first");
    await waitFor(() => harness.clients.length === 1);
    const secondAttach = registry.attach("project", "second");
    await waitFor(() => harness.clients.length === 2);

    readyGate.resolve();
    await Promise.all([firstAttach, secondAttach]);
    expect(harness.clients).toHaveLength(2);

    registry.detach("project", "first");
    registry.detach("project", "second");
    await registry.dispose();
  });

  it("broadcasts detached worker completion to the thread catalog", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");

    client.emit({ type: "summary-changed", summary: { ...thread("thread"), running: true } });
    expect(harness.catalogChanged).not.toHaveBeenCalled();

    registry.detach("project", "thread");
    client.emit({ type: "summary-changed", summary: thread("thread") }, 2);

    expect(harness.catalogChanged).toHaveBeenCalledOnce();
    expect(harness.catalogChanged).toHaveBeenCalledWith(expect.objectContaining({ running: false }));
    await registry.dispose();
  });

  it("shrinks temporary overflow as soon as a detached running worker becomes idle", async () => {
    const harness = createHarness(userDataDir, { maxLiveWorkers: 2 });
    const registry = new ThreadWorkerRegistry(harness.options);

    await registry.attach("project", "first");
    harness.clients[0]?.emit({ type: "summary-changed", summary: { ...thread("first"), running: true } });
    registry.detach("project", "first");

    await registry.attach("project", "second");
    harness.clients[1]?.emit({ type: "summary-changed", summary: { ...thread("second"), running: true } });
    registry.detach("project", "second");

    await registry.attach("project", "third");
    expect(harness.clients).toHaveLength(3);
    expect(harness.clients.every((client) => client.shutdownCount === 0)).toBe(true);

    harness.clients[0]?.emit({ type: "summary-changed", summary: thread("first") });
    await waitFor(() => harness.clients[0]?.shutdownCount === 1);

    expect(harness.clients[1]?.shutdownCount).toBe(0);
    expect(harness.clients[2]?.shutdownCount).toBe(0);
    registry.detach("project", "third");
    await registry.dispose();
  });

  it("routes acknowledgements to a worker before thread registration completes", async () => {
    const readyGate = deferred<void>();
    const harness = createHarness(userDataDir, { readyGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    const attachment = registry.attach("project", "thread");
    await waitFor(() => harness.clients.length === 1);
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");

    client.emit(sessionPush("thread"));
    expect(harness.push).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread" }), client.instanceId, 1);
    registry.acknowledge(client.instanceId, 1);

    expect(client.acknowledgements).toEqual([1]);
    readyGate.resolve();
    await attachment;
    registry.detach("project", "thread");
    await registry.dispose();
    registry.acknowledge(client.instanceId, 2);
    expect(client.acknowledgements).toEqual([1]);
  });

  it("drops events from a retired worker generation", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    registry.detach("project", "thread");
    const retired = harness.clients[0];
    if (!retired) throw new Error("First worker was not created");
    retired.crash(new Error("forced crash"));
    registry.acknowledge(retired.instanceId, 99);
    expect(retired.acknowledgements).toEqual([]);

    await registry.attach("project", "thread");
    const current = harness.clients[1];
    if (!current) throw new Error("Replacement worker was not created");
    retired.emit(sessionPush("thread"));
    current.emit(sessionPush("thread"));

    expect(harness.push).toHaveBeenCalledTimes(1);
    expect(harness.push).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread" }), current.instanceId, 1);
    expect(harness.failed).toHaveBeenCalledTimes(1);
    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("does not evict an attached worker and evicts it after detach", async () => {
    vi.useFakeTimers({ now: 0 });
    const harness = createHarness(userDataDir, { idleTtlMs: 1 });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.shutdownCount).toBe(0);

    registry.detach("project", "thread");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.shutdownCount).toBe(1);
    await registry.dispose();
  });

  it("immediately closes a detached completed worker", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    registry.detach("project", "thread");

    await registry.close("project", "thread");

    expect(client.shutdownCount).toBe(1);
    await registry.attach("project", "thread");
    expect(harness.clients).toHaveLength(2);
    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("single close retires a running worker as soon as it completes", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    client.emit({ type: "summary-changed", summary: { ...thread("thread"), running: true } });
    registry.detach("project", "thread");

    // 运行中关闭：只记录关闭意图，worker 保持存活。
    await registry.close("project", "thread");
    expect(client.shutdownCount).toBe(0);

    // 运行完成后自动退役，无需再次 close。
    client.emit({ type: "summary-changed", summary: thread("thread") });
    await waitFor(() => client.shutdownCount === 1);
    await registry.dispose();
  });

  it("logs a deferred shutdown failure and removes the stale worker", async () => {
    const harness = createHarness(userDataDir);
    const log = vi.fn();
    harness.options.log = log;
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    client.emit({ type: "summary-changed", summary: { ...thread("thread"), running: true } });
    registry.detach("project", "thread");
    await registry.close("project", "thread");
    client.shutdownError = new Error("shutdown failed");

    client.emit({ type: "summary-changed", summary: thread("thread") });

    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("thread-close", "shutdown failed"));
    await registry.attach("project", "thread");
    expect(harness.clients).toHaveLength(2);
    expect(harness.clients[1]?.readyStarted).toBe(true);
    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("cancels a pending close when the session is attached again", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    client.emit({ type: "summary-changed", summary: { ...thread("thread"), running: true } });
    registry.detach("project", "thread");
    await registry.close("project", "thread");
    expect(client.shutdownCount).toBe(0);

    // 重新 attach（新 owner 活动）：取消待定关闭。
    await registry.attach("project", "thread");
    client.emit({ type: "summary-changed", summary: thread("thread") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.shutdownCount).toBe(0);

    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("uses a five-minute default idle TTL", async () => {
    vi.useFakeTimers({ now: 0 });
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    registry.detach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(client.shutdownCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(client.shutdownCount).toBe(1);
    await registry.dispose();
  });

  it("caps live workers at four and evicts the least recently used idle worker", async () => {
    vi.useFakeTimers({ now: 0 });
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);

    for (let index = 0; index < 4; index += 1) {
      const threadId = `thread-${index}`;
      await registry.attach("project", threadId);
      registry.detach("project", threadId);
      await vi.advanceTimersByTimeAsync(1);
    }

    await registry.attach("project", "thread-4");

    expect(harness.clients).toHaveLength(5);
    expect(harness.clients[0]?.shutdownCount).toBe(1);
    expect(harness.clients.slice(1, 4).every((client) => client.shutdownCount === 0)).toBe(true);
    registry.detach("project", "thread-4");
    await registry.dispose();
  });

  it("routes cold and live rename through their exclusive owners", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);

    await registry.rename("project", "cold", "Cold title");
    expect(harness.metadataRenameCold).toHaveBeenCalledWith("project", "/workspace", "cold", "Cold title");

    await registry.attach("project", "live");
    await registry.rename("project", "live", "Live title");
    expect(harness.clients[0]?.requests).toContain("rename");
    expect(harness.clients[0]?.requests).toContain("getSummary");
    expect(harness.metadataRenameCold).toHaveBeenCalledTimes(1);
    registry.detach("project", "live");
    await registry.dispose();
  });

  it("materializes one worker for duplicate create request IDs", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    const input: SessionCreateInput = {
      projectId: "project",
      createRequestId: "create-request",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
    };

    const [first, second] = await Promise.all([registry.create(input), registry.create(input)]);

    expect(first.threadId).toBe(second.threadId);
    expect(harness.clients).toHaveLength(1);
    await registry.dispose();
  });

  it("registers linked-worktree session metadata as external", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    const created = await registry.create({
      projectId: "project",
      worktreePath: "/workspace-linked",
      createRequestId: "worktree-create",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
    });
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    const sessionFile = join(userDataDir, `${created.threadId}.jsonl`);

    client.emit({
      type: "session-materialized",
      projectId: "project",
      sessionId: created.threadId,
      sessionFile,
    });
    client.emit({ type: "summary-changed", summary: thread(created.threadId) }, 2);

    await vi.waitFor(() =>
      expect(harness.registerExternal).toHaveBeenCalledWith(
        "project",
        "/workspace",
        sessionFile,
        expect.objectContaining({ id: created.threadId }),
      ),
    );
    expect(harness.upsert).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("retries an active orphaned creation reservation instead of rejecting the draft", async () => {
    const harness = createHarness(userDataDir);
    writeCreationReservation(userDataDir, "stale-session");
    harness.metadataRecoverCreationReservation
      .mockResolvedValueOnce({ status: "active", retryAfterMs: 1 })
      .mockResolvedValueOnce({ status: "orphan" });
    const registry = new ThreadWorkerRegistry(harness.options);

    const created = await registry.create({
      projectId: "project",
      createRequestId: "create-request",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
    });

    expect(created.threadId).not.toBe("stale-session");
    expect(harness.metadataRecoverCreationReservation).toHaveBeenCalledTimes(2);
    expect(harness.clients).toHaveLength(1);
    await registry.dispose();
  });

  it("waits for an active creation reservation before recovering its committed session", async () => {
    const harness = createHarness(userDataDir);
    writeCreationReservation(userDataDir, "committed-session");
    harness.metadataRecoverCreationReservation
      .mockResolvedValueOnce({ status: "active", retryAfterMs: 1 })
      .mockResolvedValueOnce({ status: "committed" });
    const registry = new ThreadWorkerRegistry(harness.options);

    const recovered = await registry.create({
      projectId: "project",
      createRequestId: "create-request",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
    });

    expect(recovered.threadId).toBe("committed-session");
    expect(harness.metadataRecoverCreationReservation).toHaveBeenCalledTimes(2);
    expect(harness.clients).toHaveLength(1);
    await registry.dispose();
  });

  it("passes the parent session file in the create binding", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "parent");

    await registry.create({
      projectId: "project",
      createRequestId: "child-create",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
      parentThreadId: "parent",
    });

    // 父会话在 registry 中有活跃 worker 时，直接使用其 sessionFile（不经 metadata 索引）。
    expect(harness.clients[1]?.bindingParentSessionFile).toBe(join(userDataDir, "parent.jsonl"));
    await registry.dispose();
  });

  it("resolves a cold parent from the Project metadata index for a worktree child", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);

    await registry.create({
      projectId: "project",
      worktreePath: "/workspace-linked",
      createRequestId: "child-create",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
      parentThreadId: "cold-parent",
    });

    expect(harness.metadataResolve).toHaveBeenCalledWith("project", "/workspace", "cold-parent");
    await registry.dispose();
  });

  it("keeps the parent association through runtime summary updates", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.create({
      projectId: "project",
      createRequestId: "child-create",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
      parentThreadId: "parent",
    });
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");

    // 运行时 summary 更新不得冲掉父级关联。
    client.emit({ type: "summary-changed", summary: { ...thread("child"), running: true } });
    registry.detach("project", "child");
    client.emit({ type: "summary-changed", summary: thread("child") }, 2);

    expect(harness.catalogChanged).toHaveBeenCalledWith(expect.objectContaining({ parentThreadId: "parent" }));
    await registry.dispose();
  });

  it("filters the session plugin subset from the create binding", async () => {
    const harness = createHarness(userDataDir);
    harness.resolveExtensions.mockImplementation(async () => fullExtensionSet());
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.create({
      projectId: "project",
      createRequestId: "create-request",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
      enabledPluginIds: ["marketplace:second", "development:dev"],
    });
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    expect(client.bindingExtensionEntries.map(({ id }) => id)).toEqual([
      "builtin:pi-browser",
      "curated:test",
      "marketplace:second",
      "development:dev",
    ]);
    await registry.dispose();
  });

  it("keeps run-code extensions out of session selection and always loads them", async () => {
    const harness = createHarness(userDataDir);
    const set = fullExtensionSet();
    const RunCodeEntry = {
      id: "marketplace:run-code",
      displayName: "Plugin Call",
      source: "marketplace" as const,
      entryPath: "/tmp/run-code.ts",
      hostProfileVersion: 1 as const,
      capabilities: ["plugin-methods.provide" as const],
    };
    const withRunCode = { ...set, entries: [...set.entries, RunCodeEntry] };
    harness.resolveExtensions.mockImplementation(async () => withRunCode);
    harness.resolveWithAll.mockImplementation(async () => ({
      set: withRunCode,
      allEntries: [...withRunCode.entries],
    }));
    const registry = new ThreadWorkerRegistry(harness.options);

    await registry.create({
      projectId: "project",
      createRequestId: "create-request",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
      enabledPluginIds: ["marketplace:second"],
    });
    expect(harness.clients[0]?.bindingExtensionEntries.map(({ id }) => id)).toContain("marketplace:run-code");
    await registry.dispose();

    const optionsRegistry = new ThreadWorkerRegistry(harness.options);
    await optionsRegistry.attach("project", "thread");
    await expect(optionsRegistry.getSessionPluginOptions("project", "thread")).resolves.toMatchObject({
      plugins: expect.not.arrayContaining([expect.objectContaining({ id: "marketplace:run-code" })]),
    });
    await optionsRegistry.dispose();
  });

  it("loads selected plugins globally regardless of legacy scope", async () => {
    const harness = createHarness(userDataDir);
    const set = fullExtensionSet();
    harness.resolveWithAll.mockImplementation(async () => ({
      set,
      allEntries: [
        ...set.entries,
        {
          id: "marketplace:out-of-scope",
          displayName: "Out of Scope",
          source: "marketplace",
          entryPath: "/tmp/m3.ts",
          hostProfileVersion: 1,
          capabilities: [],
        },
      ],
    }));
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.create({
      projectId: "project",
      createRequestId: "create-request",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
      enabledPluginIds: ["marketplace:out-of-scope"],
    });
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    expect(client.bindingExtensionEntries.map(({ id }) => id)).toEqual([
      "builtin:pi-browser",
      "curated:test",
      "marketplace:out-of-scope",
    ]);
    await registry.dispose();
  });

  it("keeps the full extension set when the session inherits the project scope", async () => {
    const harness = createHarness(userDataDir);
    harness.resolveExtensions.mockImplementation(async () => fullExtensionSet());
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.create({
      projectId: "project",
      createRequestId: "create-request",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
    });
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    expect(client.bindingExtensionEntries.map(({ id }) => id)).toEqual([
      "builtin:pi-browser",
      "curated:test",
      "marketplace:first",
      "marketplace:second",
      "development:dev",
    ]);
    await registry.dispose();
  });

  it("restores the session plugin subset from the metadata index when opening", async () => {
    const harness = createHarness(userDataDir);
    harness.resolveExtensions.mockImplementation(async () => fullExtensionSet());
    harness.metadataList.mockResolvedValue([{ ...thread("thread"), enabledPluginIds: ["marketplace:second"] }]);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    expect(client.bindingExtensionEntries.map(({ id }) => id)).toEqual([
      "builtin:pi-browser",
      "curated:test",
      "marketplace:second",
    ]);
    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("merges the session plugin subset into persisted summaries", async () => {
    const harness = createHarness(userDataDir);
    harness.resolveExtensions.mockImplementation(async () => fullExtensionSet());
    harness.metadataList.mockResolvedValue([{ ...thread("thread"), enabledPluginIds: ["marketplace:second"] }]);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    client.emit({ type: "summary-changed", summary: thread("thread") });
    await waitFor(() => harness.upsert.mock.calls.length > 0);
    expect(harness.upsert).toHaveBeenCalledWith(
      "project",
      "/workspace",
      join(userDataDir, "thread.jsonl"),
      expect.objectContaining({ enabledPluginIds: ["marketplace:second"] }),
    );
    registry.detach("project", "thread");
    await registry.dispose();
  });

  it("rejects a stale draft generation before spawning a writer", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);

    await expect(
      registry.create({
        projectId: "project",
        createRequestId: "stale-create",
        extensionSetGeneration: "stale-generation",
        model: { provider: "provider", id: "model" },
        thinkingLevel: "off",
      }),
    ).rejects.toMatchObject({ code: "STALE_DRAFT_EXTENSION_SET" });
    expect(harness.clients).toHaveLength(0);
    await registry.dispose();
  });

  it("applies a new extension generation only after the old worker exits", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const original = harness.clients[0];
    if (!original) throw new Error("Original worker missing");
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-next"));

    await expect(registry.applyExtensionSet("project", "thread", "extensions-next")).resolves.toEqual({
      status: "applied",
      generation: "extensions-next",
    });

    expect(original.shutdownCount).toBe(1);
    expect(harness.clients[1]?.bindingGeneration).toBe("extensions-next");
    expect(harness.resync.mock.calls.map((call) => call[2])).toEqual([
      "extension-set-applying",
      "extension-set-applied",
    ]);
    await registry.dispose();
  });

  it("applies a session plugin subset through worker replacement", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const original = harness.clients[0];
    if (!original) throw new Error("Original worker missing");
    harness.resolveExtensions.mockImplementation(async () => fullExtensionSet());

    await expect(registry.applySessionPluginSelection("project", "thread", ["marketplace:second"])).resolves.toEqual({
      status: "applied",
      generation: "extensions-generation",
    });

    expect(original.shutdownCount).toBe(1);
    expect(harness.clients[1]?.bindingExtensionEntries.map(({ id }) => id)).toEqual([
      "builtin:pi-browser",
      "curated:test",
      "marketplace:second",
    ]);
    expect(harness.resync.mock.calls.map((call) => call[2])).toEqual([
      "extension-set-applying",
      "extension-set-applied",
    ]);
    await waitFor(() => harness.upsert.mock.calls.length > 0);
    expect(harness.upsert).toHaveBeenCalledWith(
      "project",
      "/workspace",
      join(userDataDir, "thread.jsonl"),
      expect.objectContaining({ enabledPluginIds: ["marketplace:second"] }),
    );
    await registry.dispose();
  });

  it("keeps the worker when the session plugin selection is unchanged", async () => {
    const harness = createHarness(userDataDir);
    harness.metadataList.mockResolvedValue([{ ...thread("thread"), enabledPluginIds: ["marketplace:second"] }]);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const original = harness.clients[0];
    if (!original) throw new Error("Original worker missing");

    await expect(registry.applySessionPluginSelection("project", "thread", ["marketplace:second"])).resolves.toEqual({
      status: "unchanged",
      generation: "extensions-generation",
    });
    expect(original.shutdownCount).toBe(0);
    expect(harness.clients).toHaveLength(1);
    await registry.dispose();
  });

  it("requires abort confirmation when the thread is running", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const client = harness.clients[0];
    if (!client) throw new Error("Worker was not created");
    harness.resolveExtensions.mockImplementation(async () => fullExtensionSet());
    client.emit({ type: "summary-changed", summary: { ...thread("thread"), running: true } });

    await expect(registry.applySessionPluginSelection("project", "thread", ["marketplace:second"])).rejects.toThrow(
      "confirm abort",
    );
    expect(harness.clients).toHaveLength(1);
    await registry.dispose();
  });

  it("aborts the running thread when explicitly confirmed", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const original = harness.clients[0];
    if (!original) throw new Error("Original worker missing");
    harness.resolveExtensions.mockImplementation(async () => fullExtensionSet());
    original.emit({ type: "summary-changed", summary: { ...thread("thread"), running: true } });

    await expect(
      registry.applySessionPluginSelection("project", "thread", ["marketplace:second"], true),
    ).resolves.toEqual({ status: "applied", generation: "extensions-generation" });

    expect(original.requests).toContain("cancel");
    expect(harness.clients[1]?.bindingExtensionEntries.map(({ id }) => id)).toEqual([
      "builtin:pi-browser",
      "curated:test",
      "marketplace:second",
    ]);
    await registry.dispose();
  });

  it("reports selectable plugins with availability for an open session", async () => {
    const harness = createHarness(userDataDir);
    const set = fullExtensionSet();
    harness.resolveWithAll.mockImplementation(async () => ({
      set,
      allEntries: [
        ...set.entries,
        {
          id: "marketplace:out-of-scope",
          displayName: "Out of Scope",
          source: "marketplace",
          entryPath: "/tmp/m3.ts",
          hostProfileVersion: 1,
          capabilities: [],
        },
      ],
    }));
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");

    await expect(registry.getSessionPluginOptions("project", "thread")).resolves.toEqual({
      plugins: expect.arrayContaining([
        expect.objectContaining({ id: "marketplace:first", available: true }),
        expect.objectContaining({ id: "marketplace:out-of-scope", available: false }),
      ]),
      enabledPluginIds: null,
    });
    await registry.dispose();
  });

  it("routes dedicated resource reload through process-level extension replacement", async () => {
    const retain = vi.fn();
    const release = vi.fn();
    const harness = createHarness(userDataDir, { generationReferences: { retain, release } });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const original = harness.clients[0];
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-next"));

    await expect(
      registry.reloadResources({
        requestId: "reload-resources",
        projectId: "project",
        threadId: "thread",
      }),
    ).resolves.toEqual({ accepted: true, queued: false });

    expect(original?.requests).not.toContain("prompt");
    expect(original?.shutdownCount).toBe(1);
    expect(harness.clients[1]?.bindingGeneration).toBe("extensions-next");
    await expect(registry.getExtensionState("project", "thread")).resolves.toMatchObject({
      appliedGeneration: "extensions-next",
      reloadRequired: false,
    });

    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-newer"));
    await registry.reloadResources({
      requestId: "reload-resources",
      projectId: "project",
      threadId: "thread",
    });
    expect(harness.clients).toHaveLength(2);
    await expect(registry.getExtensionState("project", "thread")).resolves.toMatchObject({
      appliedGeneration: "extensions-next",
      desiredGeneration: "extensions-newer",
      reloadRequired: true,
    });
    await registry.dispose();
  });

  it("reloads Pi resources in the current worker when the extension set is unchanged", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const current = harness.clients[0];

    await expect(
      registry.reloadResources({ requestId: "reload-current", projectId: "project", threadId: "thread" }),
    ).resolves.toEqual({ accepted: true, queued: false });

    expect(current?.requests).toContain("reloadResources");
    expect(current?.requests).not.toContain("prompt");
    expect(current?.shutdownCount).toBe(0);
    expect(harness.clients).toHaveLength(1);
    await registry.dispose();
  });

  it("keeps same-generation resource reload exclusive", async () => {
    const reloadGate = deferred<void>();
    const harness = createHarness(userDataDir, { reloadGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");

    const first = registry.reloadResources({
      requestId: "exclusive-reload",
      projectId: "project",
      threadId: "thread",
    });
    await waitFor(() => harness.clients[0]?.requests.includes("reloadResources") === true);

    await expect(
      registry.prompt({
        requestId: "prompt-during-reload",
        projectId: "project",
        threadId: "thread",
        text: "blocked",
        images: [],
      }),
    ).rejects.toThrow("is reloading resources");
    await expect(
      registry.reloadResources({
        requestId: "second-reload",
        projectId: "project",
        threadId: "thread",
      }),
    ).resolves.toMatchObject({ accepted: false, queued: false, error: expect.stringContaining("busy") });

    reloadGate.resolve();
    await expect(first).resolves.toEqual({ accepted: true, queued: false });
    await registry.dispose();
  });

  it("does not interpret /reload inside the generic prompt transport", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const current = harness.clients[0];

    await registry.prompt({
      requestId: "literal-reload-prompt",
      projectId: "project",
      threadId: "thread",
      text: "/reload",
      images: [],
    });

    expect(current?.requests).toContain("prompt");
    expect(current?.requests).not.toContain("reloadResources");
    await registry.dispose();
  });

  it("keeps an in-flight dedicated resource reload idempotent beyond the completed-request TTL", async () => {
    vi.useFakeTimers();
    const shutdownGate = deferred<void>();
    const harness = createHarness(userDataDir, { shutdownGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-next"));

    const input = {
      requestId: "slow-reload",
      projectId: "project",
      threadId: "thread",
    };
    const first = registry.reloadResources(input);
    await vi.waitFor(() => expect(harness.clients[0]?.shutdownCount).toBe(1));
    await vi.advanceTimersByTimeAsync(60_001);
    const duplicate = registry.reloadResources(input);
    await Promise.resolve();

    expect(harness.clients).toHaveLength(1);
    shutdownGate.resolve();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { accepted: true, queued: false },
      { accepted: true, queued: false },
    ]);
    expect(harness.clients).toHaveLength(2);
    await registry.dispose();
  });

  it("rolls a dedicated resource reload back when replacement startup fails", async () => {
    const harness = createHarness(userDataDir, { failGeneration: "extensions-broken" });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-broken"));

    await expect(
      registry.reloadResources({
        requestId: "reload-failure",
        projectId: "project",
        threadId: "thread",
      }),
    ).resolves.toMatchObject({ accepted: false, queued: false, error: expect.any(String) });

    expect(harness.clients[0]?.shutdownCount).toBe(1);
    expect(harness.clients.at(-1)?.bindingGeneration).toBe("extensions-generation");
    expect(harness.resync).toHaveBeenLastCalledWith("project", "thread", "extension-set-rollback");
    await expect(registry.attach("project", "thread")).resolves.toMatchObject({ threadId: "thread" });
    await registry.dispose();
  });

  it("rejects new commands while the old worker is draining for replacement", async () => {
    const shutdownGate = deferred<void>();
    const harness = createHarness(userDataDir, { shutdownGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-next"));

    const applying = registry.applyExtensionSet("project", "thread", "extensions-next");
    await waitFor(() => harness.clients[0]?.shutdownCount === 1);
    await expect(
      registry.prompt({
        requestId: "during-reload",
        projectId: "project",
        threadId: "thread",
        text: "blocked",
        images: [],
      }),
    ).rejects.toThrow("applying extensions");
    shutdownGate.resolve();
    await applying;
    await registry.dispose();
  });

  it("waits to attach until extension replacement completes", async () => {
    const shutdownGate = deferred<void>();
    const harness = createHarness(userDataDir, { shutdownGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-next"));

    const applying = registry.applyExtensionSet("project", "thread", "extensions-next");
    await waitFor(() => harness.clients[0]?.shutdownCount === 1);
    const attaching = registry.attach("project", "thread");
    let attached = false;
    void attaching.then(() => {
      attached = true;
    });
    await Promise.resolve();

    expect(attached).toBe(false);
    shutdownGate.resolve();
    await expect(applying).resolves.toMatchObject({ status: "applied" });
    await expect(attaching).resolves.toMatchObject({
      threadId: "thread",
      control: { extensionSet: { generation: "extensions-next" } },
    });
    expect(harness.clients[1]?.requests).toContain("bootstrap");
    await registry.dispose();
  });

  it("attaches to the current worker after an extension apply is rejected", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const resolution = deferred<ReturnType<typeof extensionSet>>();
    harness.resolveExtensions.mockReturnValueOnce(resolution.promise);

    const applying = registry.applyExtensionSet("project", "thread", "extensions-next");
    await waitFor(() => harness.resolveExtensions.mock.calls.length === 2);
    const attaching = registry.attach("project", "thread");
    resolution.resolve(extensionSet("project", "extensions-newer"));

    await expect(applying).rejects.toMatchObject({ code: "STALE_EXTENSION_SET_APPLY" });
    await expect(attaching).resolves.toMatchObject({
      threadId: "thread",
      control: { extensionSet: { generation: "extensions-generation" } },
    });
    await registry.dispose();
  });

  it("attaches to the rollback worker after replacement startup fails", async () => {
    const shutdownGate = deferred<void>();
    const harness = createHarness(userDataDir, { shutdownGate, failGeneration: "extensions-broken" });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-broken"));

    const applying = registry.applyExtensionSet("project", "thread", "extensions-broken");
    await waitFor(() => harness.clients[0]?.shutdownCount === 1);
    const attaching = registry.attach("project", "thread");
    shutdownGate.resolve();

    await expect(applying).resolves.toMatchObject({ status: "rolled-back", generation: "extensions-generation" });
    await expect(attaching).resolves.toMatchObject({
      threadId: "thread",
      control: { extensionSet: { generation: "extensions-generation" } },
    });
    expect(harness.clients.at(-1)?.requests).toContain("bootstrap");
    await registry.dispose();
  });

  it("waits for extension replacement before disposal completes", async () => {
    const shutdownGate = deferred<void>();
    const harness = createHarness(userDataDir, { shutdownGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-next"));

    const applying = registry.applyExtensionSet("project", "thread", "extensions-next");
    await waitFor(() => harness.clients[0]?.shutdownCount === 1);
    const disposal = registry.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();

    expect(disposed).toBe(false);
    shutdownGate.resolve();
    await expect(applying).resolves.toMatchObject({ status: "applied" });
    await disposal;
    expect(harness.clients[1]?.shutdownCount).toBe(1);
  });

  it("uses a bounded request deadline for checkpoint diffs", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");

    await registry.getCheckpointDiff({
      projectId: "project",
      threadId: "thread",
      fromCheckpointId: "before",
      toCheckpointId: "after",
      path: "file.txt",
    });

    expect(harness.clients[0]?.requestTimeouts).toContainEqual({ type: "getCheckpointDiff", timeoutMs: 35_000 });
    await registry.dispose();
  });

  it("rejects checkpoint restore while another project in the workspace is running", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "first");
    await registry.attach("overlap", "second");
    harness.clients[1]?.emit({ type: "summary-changed", summary: { ...thread("second"), running: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      registry.restoreCheckpoint({
        projectId: "project",
        threadId: "first",
        checkpointId: "before",
        expectedCheckpointId: "after",
      }),
    ).rejects.toThrow("overlap/second");
    expect(harness.clients[0]?.requests).not.toContain("restoreCheckpoint");
    await registry.dispose();
  });

  it("allows checkpoint restore while an unrelated workspace worker is starting", async () => {
    const harness = createHarness(userDataDir);
    harness.options.getWorkspaceKey = async (projectId) =>
      projectId === "unrelated" ? "workspace-other" : "workspace";
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "first");
    const readyGate = deferred<void>();
    harness.options.createWorkerClient = (clientOptions) => {
      const client = new FakeWorkerClient(clientOptions, readyGate);
      harness.clients.push(client);
      return client;
    };
    const opening = registry.attach("unrelated", "second");
    await waitFor(() => harness.clients[1]?.readyStarted === true);

    await expect(
      registry.restoreCheckpoint({
        projectId: "project",
        threadId: "first",
        checkpointId: "before",
        expectedCheckpointId: "after",
      }),
    ).resolves.toEqual({ checkpointId: "before", restoredFiles: 1 });

    readyGate.resolve();
    await opening;
    await registry.dispose();
  });

  it("blocks new workspace commands while checkpoint restore is in progress", async () => {
    const checkpointGate = deferred<void>();
    const harness = createHarness(userDataDir, { checkpointGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "first");
    await registry.attach("overlap", "second");

    const restoring = registry.restoreCheckpoint({
      projectId: "project",
      threadId: "first",
      checkpointId: "before",
      expectedCheckpointId: "after",
    });
    await waitFor(() => harness.clients[0]?.requests.includes("restoreCheckpoint") === true);
    await expect(
      registry.prompt({
        requestId: "during-restore",
        projectId: "overlap",
        threadId: "second",
        text: "blocked",
        images: [],
      }),
    ).rejects.toThrow("restoring a checkpoint");

    checkpointGate.resolve();
    await expect(restoring).resolves.toEqual({ checkpointId: "before", restoredFiles: 1 });
    await registry.dispose();
  });

  it("requires explicit abort before replacing a running worker", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const original = harness.clients[0];
    if (!original) throw new Error("Original worker missing");
    original.emit({ type: "summary-changed", summary: { ...thread("thread"), running: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-next"));

    await expect(registry.applyExtensionSet("project", "thread", "extensions-next")).rejects.toThrow("confirm abort");
    await expect(registry.applyExtensionSet("project", "thread", "extensions-next", true)).resolves.toMatchObject({
      status: "applied",
    });
    expect(original.requests).toContain("cancel");
    await registry.dispose();
  });

  it("rolls back to the previous extension set after replacement startup failures", async () => {
    const harness = createHarness(userDataDir, { failGeneration: "extensions-broken" });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-broken"));

    const result = await registry.applyExtensionSet("project", "thread", "extensions-broken");

    expect(result).toMatchObject({ status: "rolled-back", generation: "extensions-generation" });
    expect(harness.clients.at(-1)?.bindingGeneration).toBe("extensions-generation");
    expect(harness.resync).toHaveBeenLastCalledWith("project", "thread", "extension-set-rollback");
    await registry.dispose();
  });

  it("rolls back when settings change again while replacement is starting", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    harness.resolveExtensions
      .mockResolvedValueOnce(extensionSet("project", "extensions-next"))
      .mockResolvedValue(extensionSet("project", "extensions-newer"));

    const result = await registry.applyExtensionSet("project", "thread", "extensions-next");

    expect(result).toMatchObject({ status: "rolled-back", generation: "extensions-generation" });
    await expect(registry.getExtensionState("project", "thread")).resolves.toMatchObject({
      appliedGeneration: "extensions-generation",
      desiredGeneration: "extensions-newer",
      reloadRequired: true,
    });
    await registry.dispose();
  });

  it("derives reloadRequired independently for every live thread", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "first");
    await registry.attach("project", "second");
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "extensions-next"));

    await registry.extensionSettingsChanged();
    await expect(registry.attach("project", "first")).resolves.toMatchObject({
      control: { extensionSet: { reloadRequired: true } },
    });
    await expect(registry.getExtensionState("project", "first")).resolves.toMatchObject({ reloadRequired: true });
    await expect(registry.getExtensionState("project", "second")).resolves.toMatchObject({ reloadRequired: true });
    await registry.applyExtensionSet("project", "first", "extensions-next");
    await expect(registry.getExtensionState("project", "first")).resolves.toMatchObject({ reloadRequired: false });
    await expect(registry.getExtensionState("project", "second")).resolves.toMatchObject({ reloadRequired: true });
    await registry.dispose();
  });

  it("blocks a development generation after repeated live worker crashes and recovers on disable", async () => {
    const harness = createHarness(userDataDir);
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "development-crashing", true));
    const registry = new ThreadWorkerRegistry(harness.options);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await registry.attach("project", "thread");
      harness.clients.at(-1)?.crash(new Error(`development crash ${attempt + 1}`));
    }
    await expect(registry.attach("project", "thread")).rejects.toThrow("blocked after repeated failures");

    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "development-disabled"));
    await expect(registry.attach("project", "thread")).resolves.toMatchObject({ threadId: "thread" });
    await registry.dispose();
  });

  it("blocks a development extension generation after its bounded startup retries", async () => {
    const harness = createHarness(userDataDir, { failGeneration: "development-broken" });
    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "development-broken", true));
    const registry = new ThreadWorkerRegistry(harness.options);

    await expect(registry.attach("project", "thread")).rejects.toThrow("extension startup failed");
    const attempts = harness.clients.length;
    await expect(registry.attach("project", "thread")).rejects.toThrow("blocked after repeated failures");
    expect(harness.clients).toHaveLength(attempts);

    harness.resolveExtensions.mockResolvedValue(extensionSet("project", "development-disabled"));
    await expect(registry.attach("project", "thread")).resolves.toMatchObject({ threadId: "thread" });
    expect(harness.clients).toHaveLength(attempts + 1);
    await registry.dispose();
  });

  it("waits for pending creation before completing shutdown", async () => {
    const readyGate = deferred<void>();
    const harness = createHarness(userDataDir, { readyGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    const creation = registry.create({
      projectId: "project",
      createRequestId: "create-during-shutdown",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
    });
    await waitFor(() => harness.clients.length === 1);
    let disposed = false;
    const disposal = registry.dispose().then(() => {
      disposed = true;
    });

    await Promise.resolve();
    expect(disposed).toBe(false);
    readyGate.resolve();
    await creation;
    await disposal;
    expect(harness.clients[0]?.shutdownCount).toBe(1);
  });

  it("removes a complete subtree through one metadata mutation", async () => {
    const harness = createHarness(userDataDir);
    harness.metadataList.mockResolvedValue([
      thread("parent"),
      { ...thread("child"), parentThreadId: "parent" },
      { ...thread("grandchild"), parentThreadId: "child" },
    ]);
    const begun: string[] = [];
    const ended: string[] = [];
    harness.options.beginSubagentTreeMutation = (_projectId, id) => begun.push(id);
    harness.options.endSubagentTreeMutation = (_projectId, id) => ended.push(id);
    const registry = new ThreadWorkerRegistry(harness.options);
    await expect(registry.remove("project", "parent", "subtree")).resolves.toEqual({
      removedThreadIds: ["parent", "child", "grandchild"],
      reparentedThreads: [],
    });
    expect(harness.metadataRemoveCold).toHaveBeenCalledWith("project", "/workspace", "parent", "subtree");
    expect(harness.cleanupSessionCheckpoints).toHaveBeenCalledWith("project", ["parent", "child", "grandchild"]);
    expect(begun).toEqual(["parent", "child", "grandchild"]);
    expect(ended).toEqual(["grandchild", "child", "parent"]);
    await registry.dispose();
  });

  it("promotes a child session to root through one metadata mutation", async () => {
    const harness = createHarness(userDataDir);
    harness.metadataList.mockResolvedValue([
      thread("parent"),
      { ...thread("child"), parentThreadId: "parent" },
      { ...thread("grandchild"), parentThreadId: "child" },
    ]);
    harness.metadataPromoteCold.mockResolvedValue({ removedThreadIds: [], reparentedThreads: [thread("child")] });
    const begun: string[] = [];
    const ended: string[] = [];
    harness.options.beginSubagentTreeMutation = (_projectId, id) => begun.push(id);
    harness.options.endSubagentTreeMutation = (_projectId, id) => ended.push(id);
    const registry = new ThreadWorkerRegistry(harness.options);
    await expect(registry.promote("project", "child")).resolves.toEqual({
      removedThreadIds: [],
      reparentedThreads: [thread("child")],
    });
    expect(harness.metadataPromoteCold).toHaveBeenCalledWith("project", "/workspace", "child");
    expect(begun).toEqual(["child"]);
    expect(ended).toEqual(["child"]);
    await registry.dispose();
  });

  it("rejects promoting a root session", async () => {
    const harness = createHarness(userDataDir);
    harness.metadataList.mockResolvedValue([thread("parent")]);
    const registry = new ThreadWorkerRegistry(harness.options);
    await expect(registry.promote("project", "parent")).rejects.toThrow("already a root session");
    expect(harness.metadataPromoteCold).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("rejects promoting a running session", async () => {
    const harness = createHarness(userDataDir);
    harness.metadataList.mockResolvedValue([
      thread("parent"),
      { ...thread("child"), parentThreadId: "parent", running: true },
    ]);
    const registry = new ThreadWorkerRegistry(harness.options);
    await expect(registry.promote("project", "child")).rejects.toThrow("child is running");
    expect(harness.metadataPromoteCold).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("rejects tree deletion while a descendant is running", async () => {
    const harness = createHarness(userDataDir);
    harness.metadataList.mockResolvedValue([
      thread("parent"),
      { ...thread("child"), parentThreadId: "parent", running: true },
    ]);
    const registry = new ThreadWorkerRegistry(harness.options);
    await expect(registry.remove("project", "parent", "subtree")).rejects.toThrow("child is running");
    expect(harness.metadataRemoveCold).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("rejects catalog and cold mutations after project draining starts", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.removeProject("project");

    await expect(registry.list("project")).rejects.toThrow("Project project is being removed");
    await expect(registry.rename("project", "thread", "title")).rejects.toThrow("Project project is being removed");
    await expect(registry.remove("project", "thread", "subtree")).rejects.toThrow("Project project is being removed");
    expect(harness.metadataRenameCold).not.toHaveBeenCalled();
    await registry.dispose();
  });
});

interface Harness {
  options: ThreadWorkerRegistryOptions;
  clients: FakeWorkerClient[];
  push: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
  catalogChanged: ReturnType<typeof vi.fn>;
  metadataRenameCold: ReturnType<typeof vi.fn>;
  metadataResolve: ReturnType<typeof vi.fn>;
  metadataList: ReturnType<typeof vi.fn>;
  metadataRemoveCold: ReturnType<typeof vi.fn>;
  metadataPromoteCold: ReturnType<typeof vi.fn>;
  metadataRecoverCreationReservation: ReturnType<typeof vi.fn>;
  cleanupSessionCheckpoints: ReturnType<typeof vi.fn>;
  resolveExtensions: ReturnType<typeof vi.fn>;
  resolveWithAll: ReturnType<typeof vi.fn>;
  registerExternal: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  resync: ReturnType<typeof vi.fn>;
}

function createHarness(
  userDataDir: string,
  overrides?: {
    readyGate?: ReturnType<typeof deferred<void>>;
    idleTtlMs?: number;
    maxLiveWorkers?: number;
    failGeneration?: string;
    shutdownGate?: ReturnType<typeof deferred<void>>;
    reloadGate?: ReturnType<typeof deferred<void>>;
    checkpointGate?: ReturnType<typeof deferred<void>>;
    generationReferences?: ThreadWorkerRegistryOptions["generationReferences"];
  },
): Harness {
  const clients: FakeWorkerClient[] = [];
  const push = vi.fn<(payload: SessionPushPayload, workerInstanceId: string, sidecarSequence: number) => void>();
  const failed = vi.fn<(projectId: string, threadId: string, error: Error) => void>();
  const catalogChanged = vi.fn<(thread: Thread) => void>();
  const metadataRenameCold = vi.fn(async () => {});
  const metadataResolve = vi.fn(async (_projectId: string, _cwd: string, threadId: string) => {
    const path = join(userDataDir, `${threadId}.jsonl`);
    if (!existsSync(path))
      writeFileSync(path, `${JSON.stringify({ type: "session", id: threadId, cwd: "/workspace" })}\n`);
    return { id: threadId, path };
  });
  const metadataList = vi.fn(async (): Promise<Thread[]> => []);
  const metadataRemoveCold = vi.fn(async (_projectId: string, _cwd: string, threadId: string, policy: string) => ({
    removedThreadIds: policy === "subtree" && threadId === "parent" ? ["parent", "child", "grandchild"] : [threadId],
    reparentedThreads: [],
  }));
  const metadataPromoteCold = vi.fn(async (_projectId: string, _cwd: string, threadId: string) => ({
    removedThreadIds: [],
    reparentedThreads: [{ ...thread(threadId), parentThreadId: undefined }],
  }));
  const metadataRecoverCreationReservation = vi.fn(
    async (): Promise<CreationReservationRecovery> => ({ status: "orphan" }),
  );
  const cleanupSessionCheckpoints = vi.fn(async () => undefined);
  const metadata = {
    list: metadataList,
    getDraftConfig: vi.fn(async () => ({
      models: [],
      commands: [],
      model: null,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "missing-model" },
      extensions: { extensionSetGeneration: "extensions-generation", diagnostics: [] },
    })),
    resolve: metadataResolve,
    registerExternal: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    renameCold: metadataRenameCold,
    removeCold: metadataRemoveCold,
    promoteCold: metadataPromoteCold,
    recoverCreationReservation: metadataRecoverCreationReservation,
    invalidateProject: vi.fn(async () => {}),
  } as unknown as MetadataWorkerClient;
  const resolveExtensions = vi.fn(async (projectId: string) => extensionSet(projectId));
  const resolveWithAll = vi.fn(async (projectId: string) => ({
    set: await resolveExtensions(projectId),
    allEntries: [] as ResolvedExtensionEntry[],
  }));
  const extensionSourcePolicy = {
    resolve: resolveExtensions,
    resolveWithAll,
  } as unknown as DesktopExtensionSourcePolicy;
  const resync = vi.fn();
  const options: ThreadWorkerRegistryOptions = {
    manifest: manifest(),
    metadata,
    userDataDir,
    agentDir: join(userDataDir, "agent"),
    extensionSourcePolicy,
    generationReferences: overrides?.generationReferences,
    getCwd: () => "/workspace",
    resolveSessionCwd: async (_projectId, cwd) => cwd,
    getWorkspaceKey: async () => "workspace",
    push,
    failed,
    resync,
    catalogChanged,
    cleanupSessionCheckpoints,
    createWorkerClient: (clientOptions) => {
      const client = new FakeWorkerClient(
        clientOptions,
        overrides?.readyGate,
        overrides?.failGeneration,
        overrides?.shutdownGate,
        overrides?.reloadGate,
        overrides?.checkpointGate,
      );
      clients.push(client);
      return client;
    },
    idleTtlMs: overrides?.idleTtlMs,
    maxLiveWorkers: overrides?.maxLiveWorkers,
  };
  return {
    options,
    clients,
    push,
    failed,
    catalogChanged,
    metadataRenameCold,
    metadataResolve,
    metadataList,
    metadataRemoveCold,
    metadataPromoteCold,
    metadataRecoverCreationReservation,
    cleanupSessionCheckpoints,
    resolveExtensions,
    resolveWithAll,
    registerExternal: metadata.registerExternal,
    upsert: metadata.upsert,
    resync,
  };
}

class FakeWorkerClient implements ThreadWorkerClient {
  readonly instanceId: string;
  readonly pid: number;
  readonly requests: SidecarCommand["type"][] = [];
  readonly requestTimeouts: Array<{ type: SidecarCommand["type"]; timeoutMs?: number | null }> = [];
  readonly acknowledgements: number[] = [];
  readonly bindingGeneration: string;
  readonly shellPath: string | undefined;
  readonly bindingParentSessionFile: string | undefined;
  readonly bindingExtensionEntries: ReadonlyArray<{ id: string; source: string }>;
  readyStarted = false;
  shutdownCount = 0;
  shutdownError: Error | undefined;
  private readonly options: WorkerClientOptions;
  private readonly bootstrap: SessionBootstrap;
  private readonly readyGate?: ReturnType<typeof deferred<void>>;
  private readonly failGeneration?: string;
  private readonly shutdownGate?: ReturnType<typeof deferred<void>>;
  private readonly reloadGate?: ReturnType<typeof deferred<void>>;
  private readonly checkpointGate?: ReturnType<typeof deferred<void>>;

  constructor(
    options: WorkerClientOptions,
    readyGate?: ReturnType<typeof deferred<void>>,
    failGeneration?: string,
    shutdownGate?: ReturnType<typeof deferred<void>>,
    reloadGate?: ReturnType<typeof deferred<void>>,
    checkpointGate?: ReturnType<typeof deferred<void>>,
  ) {
    this.options = options;
    this.readyGate = readyGate;
    this.failGeneration = failGeneration;
    this.shutdownGate = shutdownGate;
    this.reloadGate = reloadGate;
    this.checkpointGate = checkpointGate;
    const sequence = fakeWorkerSequence++;
    this.instanceId = `worker-${sequence}`;
    this.pid = 10_000 + sequence;
    if (options.binding.role !== "thread") throw new Error(`Unexpected fake worker role: ${options.binding.role}`);
    const threadId =
      options.binding.value.mode === "open" ? options.binding.value.threadId : options.binding.value.sessionId;
    this.bindingGeneration = options.binding.value.extensionSet.generation;
    this.shellPath = options.binding.value.shellPath;
    this.bindingParentSessionFile =
      options.binding.value.mode === "create" ? options.binding.value.parentSessionFile : undefined;
    this.bindingExtensionEntries = options.binding.value.extensionSet.entries.map((entry) => ({
      id: entry.id,
      source: entry.source,
    }));
    this.bootstrap = bootstrap(threadId, this.bindingGeneration, options.binding.value.cwd);
  }

  async ready(): Promise<SidecarReady> {
    this.readyStarted = true;
    await this.readyGate?.promise;
    if (this.bindingGeneration === this.failGeneration) throw new Error("extension startup failed");
    return {
      kind: "ready",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: this.instanceId,
      role: "thread",
      runtime: this.options.manifest.compatibility,
      result: this.bootstrap as unknown as JsonValue,
    };
  }

  async request<T>(command: SidecarCommand, timeoutMs?: number | null): Promise<T> {
    this.requests.push(command.type);
    this.requestTimeouts.push({ type: command.type, timeoutMs });
    if (command.type === "bootstrap") return this.bootstrap as unknown as T;
    if (command.type === "getSummary") return thread(this.bootstrap.threadId) as unknown as T;
    if (command.type === "reloadResources") {
      await this.reloadGate?.promise;
      return { accepted: true, queued: false } as T;
    }
    if (command.type === "restoreCheckpoint") {
      await this.checkpointGate?.promise;
      return { checkpointId: command.checkpointId, restoredFiles: 1 } as T;
    }
    return null as T;
  }

  acknowledge(sequence: number): void {
    this.acknowledgements.push(sequence);
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    await this.shutdownGate?.promise;
    if (this.shutdownError) throw this.shutdownError;
  }

  emit(event: SidecarEventBody, sequence = 1): void {
    this.options.onEvent?.({
      kind: "event",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: this.instanceId,
      sequence,
      creditCost: 1,
      event,
    });
  }

  crash(error: Error): void {
    this.options.onFailure?.(error);
  }
}

let fakeWorkerSequence = 1;

function writeCreationReservation(userDataDir: string, sessionId: string): void {
  const directory = join(userDataDir, "creation-reservations");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${sessionId}.json`),
    JSON.stringify({
      projectId: "project",
      projectCwd: "/workspace",
      cwd: "/workspace",
      sessionId,
      createRequestId: "create-request",
      state: "reserved",
      updatedAt: Date.now(),
    }),
  );
}

function bootstrap(
  threadId: string,
  extensionGeneration = "extensions-generation",
  cwd = "/workspace",
): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId,
    timeline: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId,
      cursor: 0,
      headId: null,
      nodes: [],
      queue: [],
      phase: "idle",
    },
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: "project",
      threadId,
      title: threadId,
      updatedAt: 1,
      cwd,
      running: false,
      queueModes: { steering: "one-at-a-time", followUp: "one-at-a-time" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionSet: { generation: extensionGeneration, diagnostics: [], reloadRequired: false },
      extensionHost: { statuses: {}, widgets: [] },
    },
  };
}

function extensionSet(projectId = "project", generation = "extensions-generation", development = false) {
  return {
    generation,
    projectId,
    entries: development
      ? [
          {
            id: "development:test",
            displayName: "Development",
            source: "development" as const,
            entryPath: "/tmp/development.ts",
            hostProfileVersion: 1 as const,
            capabilities: [],
          },
        ]
      : [],
    diagnostics: [],
    resolvedAt: 0,
  };
}

function fullExtensionSet(): ResolvedExtensionSet {
  return {
    generation: "extensions-generation",
    projectId: "project",
    entries: [
      {
        id: "builtin:pi-browser",
        displayName: "Browser",
        source: "builtin",
        entryPath: "/tmp/builtin.ts",
        hostProfileVersion: 1,
        capabilities: [],
      },
      {
        id: "curated:test",
        displayName: "Curated",
        source: "curated",
        entryPath: "/tmp/curated.ts",
        hostProfileVersion: 1,
        capabilities: [],
      },
      {
        id: "marketplace:first",
        displayName: "Market First",
        source: "marketplace",
        entryPath: "/tmp/m1.ts",
        hostProfileVersion: 1,
        capabilities: [],
      },
      {
        id: "marketplace:second",
        displayName: "Market Second",
        source: "marketplace",
        entryPath: "/tmp/m2.ts",
        hostProfileVersion: 1,
        capabilities: [],
      },
      {
        id: "development:dev",
        displayName: "Dev Plugin",
        source: "development",
        entryPath: "/tmp/dev.ts",
        hostProfileVersion: 1,
        capabilities: [],
      },
    ],
    diagnostics: [],
    resolvedAt: 0,
  };
}

function thread(threadId: string): Thread {
  return {
    id: threadId,
    projectId: "project",
    title: threadId,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: "",
    archived: false,
    running: false,
  };
}

function sessionPush(threadId: string): SidecarEventBody {
  return {
    type: "session-push",
    payload: {
      type: "runtime-availability",
      projectId: "project",
      threadId,
      availability: { state: "ready", unknownOutcome: false },
    },
  };
}

function manifest(): SidecarRuntimeManifest {
  return {
    entries: { thread: "", metadata: "", subagent: "" },
    compatibility: {
      nodeVersion: process.version,
      modulesAbi: process.versions.modules,
      napi: process.versions.napi ?? "unknown",
      platform: process.platform,
      arch: process.arch,
      osRelease: "test",
      libc: "test",
      toolchain: "test",
      piVersion: "test",
      runtimeCompatibilityId: "test",
    },
    integrity: {
      entries: { thread: "", metadata: "", subagent: "" },
      files: {},
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value as T) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}
