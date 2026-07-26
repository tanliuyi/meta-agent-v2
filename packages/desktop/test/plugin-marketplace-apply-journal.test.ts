import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceExtensionApplyJournal } from "../src/main/plugins/marketplace-extension-apply-journal.ts";
import type { ResolvedExtensionSet } from "../src/shared/desktop-extension-contracts.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MarketplaceExtensionApplyJournal", () => {
  it("retains the before generation until replacement validation is durable", async () => {
    const harness = createHarness();
    const record = await harness.journal.prepare({
      projectId: "project",
      threadId: "thread",
      beforeSet: extensionSet("before"),
      afterGeneration: "after",
      previousWorkerInstanceId: "worker-one",
    });

    expect(harness.retain).toHaveBeenCalledWith("apply:apply-one", expect.objectContaining({ generation: "before" }));
    await harness.journal.validated(record);

    await expect(harness.journal.list()).resolves.toEqual([]);
    expect(harness.release).toHaveBeenCalledWith("apply:apply-one");
  });

  it("completes a linked marketplace mutation only after apply validation", async () => {
    const mutationLifecycle = { rollback: vi.fn(async () => {}), complete: vi.fn(async () => {}) };
    const harness = createHarness({ mutationLifecycle });
    const record = await harness.journal.prepare({
      projectId: "project",
      threadId: "thread",
      beforeSet: extensionSet("before"),
      afterGeneration: "after",
      previousWorkerInstanceId: "worker-one",
      mutationOperationId: "mutation-one",
    });

    await harness.journal.validated(record);

    expect(mutationLifecycle.complete).toHaveBeenCalledWith("mutation-one");
    expect(mutationLifecycle.rollback).not.toHaveBeenCalled();
  });

  it("turns an orphaned apply into a startup rollback override", async () => {
    const harness = createHarness();
    await harness.journal.prepare({
      projectId: "project",
      threadId: "thread",
      beforeSet: extensionSet("before"),
      afterGeneration: "after",
      previousWorkerInstanceId: "worker-one",
      mutationOperationId: "mutation-one",
    });
    const mutationLifecycle = { rollback: vi.fn(async () => {}), complete: vi.fn(async () => {}) };
    const restarted = new MarketplaceExtensionApplyJournal(
      harness.root,
      {
        retain: harness.retain,
        release: harness.release,
      },
      { mutationLifecycle },
    );

    await restarted.reconcileStartup();

    expect(mutationLifecycle.rollback).toHaveBeenCalledWith("mutation-one");
    expect(restarted.getRollbackOverride("project", "thread")).toEqual({
      operationId: "apply-one",
      extensionSet: expect.objectContaining({ generation: "before" }),
    });
    await expect(restarted.list()).resolves.toEqual([
      expect.objectContaining({ operationId: "apply-one", phase: "rollback-pending" }),
    ]);
    await restarted.startupRollbackStarted("apply-one", "rollback-worker", 12_345);
    await expect(restarted.list()).resolves.toEqual([
      expect.objectContaining({
        operationId: "apply-one",
        phase: "rollback-pending",
        replacementWorkerInstanceId: "rollback-worker",
        replacementWorkerPid: 12_345,
      }),
    ]);
    await restarted.completeStartupRollback("apply-one");
    await expect(restarted.list()).resolves.toEqual([]);
    expect(mutationLifecycle.complete).toHaveBeenCalledWith("mutation-one");
    expect(harness.release).toHaveBeenCalledWith("apply:apply-one");
  });

  it("fails closed while the previous writer PID is still alive", async () => {
    const harness = createHarness({ waitForProcessExitMs: 0 });
    await harness.journal.prepare({
      projectId: "project",
      threadId: "thread",
      beforeSet: extensionSet("before"),
      afterGeneration: "after",
      previousWorkerInstanceId: "worker-one",
      previousWorkerPid: process.pid,
    });
    const restarted = new MarketplaceExtensionApplyJournal(
      harness.root,
      { retain: harness.retain, release: harness.release },
      { waitForProcessExitMs: 0 },
    );

    await expect(restarted.reconcileStartup()).rejects.toThrow("still alive");
  });

  it("fails closed when rollback-pending still records a live replacement writer", async () => {
    const harness = createHarness({ waitForProcessExitMs: 0 });
    const prepared = await harness.journal.prepare({
      projectId: "project",
      threadId: "thread",
      beforeSet: extensionSet("before"),
      afterGeneration: "after",
      previousWorkerInstanceId: "worker-one",
    });
    const started = await harness.journal.replacementStarted(prepared, "replacement", process.pid);
    await harness.journal.beginRollback(started);
    const restarted = new MarketplaceExtensionApplyJournal(
      harness.root,
      { retain: harness.retain, release: harness.release },
      { waitForProcessExitMs: 0 },
    );

    await expect(restarted.reconcileStartup()).rejects.toThrow("still alive");
  });

  it("fails closed on malformed persisted apply state", async () => {
    const harness = createHarness();
    await mkdir(harness.journal.directory, { recursive: true });
    await writeFile(join(harness.journal.directory, "invalid.json"), "{}\n", "utf8");

    await expect(harness.journal.reconcileStartup()).rejects.toThrow("record is invalid");
  });
});

function createHarness(
  options: {
    waitForProcessExitMs?: number;
    mutationLifecycle?: {
      rollback(operationId: string): Promise<void>;
      complete(operationId: string): Promise<void>;
    };
  } = {},
) {
  const root = join(tmpdir(), `marketplace-apply-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const retain = vi.fn();
  const release = vi.fn();
  const journal = new MarketplaceExtensionApplyJournal(
    root,
    { retain, release },
    {
      createId: () => "apply-one",
      now: () => 100,
      ...options,
    },
  );
  return { root, retain, release, journal };
}

function extensionSet(generation: string): ResolvedExtensionSet {
  return {
    generation,
    projectId: "project",
    entries: [
      {
        id: "builtin",
        displayName: "Builtin",
        source: "builtin",
        hostProfileVersion: 1,
        capabilities: [],
      },
    ],
    diagnostics: [],
    resolvedAt: 1,
  };
}
