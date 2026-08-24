import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SharedThreadSidecarProcess } from "../src/main/sidecar/shared-thread-sidecar-client.ts";
import type { SidecarRuntimeManifest } from "../src/main/sidecar/sidecar-runtime-manifest.ts";
import { SIDECAR_PROTOCOL_VERSION } from "../src/shared/sidecar-contracts.ts";
import { currentRuntimeCompatibility } from "../src/shared/sidecar-wire.ts";
import { dequeueFairChannelMessage, type QueuedSidecarMessage } from "../src/sidecar/shared-thread-sidecar-host.ts";

const binding = (threadId: string) => ({
  role: "thread" as const,
  value: {
    mode: "open" as const,
    projectId: "project",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    threadId,
    sessionFile: resolve(import.meta.dirname, `fixtures/${threadId}.jsonl`),
  },
});

describe("shared thread sidecar scheduling", () => {
  it("round-robins channels while prioritizing control within the selected channel", () => {
    const controlQueue = [queuedControl("channel-a", "a-1"), queuedControl("channel-a", "a-2")];
    const eventQueue = [queuedEvent("channel-b", 1), queuedEvent("channel-a", 2)];

    const first = dequeueFairChannelMessage(controlQueue, eventQueue);
    const second = dequeueFairChannelMessage(controlQueue, eventQueue, first?.message.workerInstanceId);
    const third = dequeueFairChannelMessage(controlQueue, eventQueue, second?.message.workerInstanceId);
    const fourth = dequeueFairChannelMessage(controlQueue, eventQueue, third?.message.workerInstanceId);

    expect([first, second, third, fourth].map((queued) => queued?.message.workerInstanceId)).toEqual([
      "channel-a",
      "channel-b",
      "channel-a",
      "channel-a",
    ]);
    expect(first?.message.kind).toBe("closed");
    expect(second?.message.kind).toBe("event");
    expect(third?.message.kind).toBe("closed");
    expect(fourth?.message.kind).toBe("event");

    const afterMissingPrevious = dequeueFairChannelMessage(
      [queuedControl("channel-a", "refilled")],
      [queuedEvent("channel-c", 3)],
      "channel-b",
    );
    expect(afterMissingPrevious?.message.workerInstanceId).toBe("channel-c");
    const wrapped = dequeueFairChannelMessage(
      [queuedControl("channel-a", "wrapped")],
      [queuedEvent("channel-c", 4)],
      "channel-c",
    );
    expect(wrapped?.message.workerInstanceId).toBe("channel-a");
  });
});

describe("SharedThreadSidecarProcess", () => {
  it("multiplexes independent thread channels through one sidecar process", async () => {
    const processHost = new SharedThreadSidecarProcess({
      manifest: manifest(),
      agentDir: process.cwd(),
    });
    const first = processHost.open({
      manifest: manifest(),
      binding: binding("first"),
      browserSessionToken: "first-token",
    });
    const second = processHost.open({
      manifest: manifest(),
      binding: binding("second"),
      browserSessionToken: "second-token",
    });

    await expect(first.ready()).resolves.toMatchObject({
      result: { channelId: "first", browserSessionToken: "first-token" },
    });
    await expect(second.ready()).resolves.toMatchObject({
      result: { channelId: "second", browserSessionToken: "second-token" },
    });
    expect(first.instanceId).not.toBe(second.instanceId);
    expect(first.pid).toBe(second.pid);

    await expect(first.request({ type: "ping" })).resolves.toEqual({
      channelId: "first",
      command: "ping",
    });
    await expect(second.request({ type: "ping" })).resolves.toEqual({
      channelId: "second",
      command: "ping",
    });

    await first.shutdown();
    expect(second.available).toBe(true);
    await expect(second.request({ type: "ping" })).resolves.toMatchObject({ channelId: "second" });
    const pid = second.pid;
    await second.shutdown();
    if (pid) {
      await vi.waitFor(() => expect(() => globalThis.process.kill(pid, 0)).toThrow(), { timeout: 2_000 });
    }
  }, 15_000);

  it("isolates one channel's event sequence failure", async () => {
    const processHost = new SharedThreadSidecarProcess({ manifest: manifest(), agentDir: process.cwd() });
    const broken = processHost.open({ manifest: manifest(), binding: binding("broken") });
    const healthy = processHost.open({ manifest: manifest(), binding: binding("healthy") });
    await Promise.all([broken.ready(), healthy.ready()]);

    broken.handleMessage({
      kind: "event",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: broken.instanceId,
      sequence: 2,
      creditCost: 1,
      eventJsonLength: 39,
      event: { type: "runtime-state", state: "idle" },
    });

    await expect(broken.shutdown()).rejects.toThrow("event sequence gap");
    await expect(healthy.request({ type: "ping" })).resolves.toMatchObject({ channelId: "healthy" });
    await healthy.shutdown();
  });

  it("propagates a channel service dispose failure", async () => {
    const processHost = new SharedThreadSidecarProcess({ manifest: manifest(), agentDir: process.cwd() });
    const channel = processHost.open({ manifest: manifest(), binding: binding("dispose-error") });
    await channel.ready();

    await expect(channel.shutdown()).rejects.toThrow("fixture dispose failed");
  });

  it("closes a channel whose runtime compatibility check fails", async () => {
    const incompatible = manifest();
    incompatible.compatibility = { ...incompatible.compatibility, osRelease: "incompatible" };
    const processHost = new SharedThreadSidecarProcess({
      manifest: incompatible,
      agentDir: process.cwd(),
    });
    const channel = processHost.open({ manifest: incompatible, binding: binding("incompatible") });
    const pid = channel.pid;

    await expect(channel.ready()).rejects.toThrow("Sidecar runtime mismatch");
    if (pid) {
      await vi.waitFor(() => expect(() => globalThis.process.kill(pid, 0)).toThrow(), { timeout: 2_000 });
    }
  });
});

function queuedControl(workerInstanceId: string, message: string): QueuedSidecarMessage {
  return {
    message: {
      kind: "closed",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId,
      error: { name: "Error", message },
    },
    bytes: 1,
  };
}

function queuedEvent(workerInstanceId: string, sequence: number): QueuedSidecarMessage {
  return {
    message: {
      kind: "event",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId,
      sequence,
      creditCost: 1,
      eventJsonLength: 2,
      event: { type: "resync-required", reason: "test", lastSafeSequence: sequence - 1 },
    },
    bytes: 1,
  };
}

function manifest(): SidecarRuntimeManifest {
  return {
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    entries: {
      thread: resolve(import.meta.dirname, "fixtures/shared-thread-sidecar.mjs"),
      metadata: "",
    },
    compatibility: currentRuntimeCompatibility("test"),
    integrity: {
      entries: { thread: "", metadata: "" },
      files: {},
    },
  };
}
