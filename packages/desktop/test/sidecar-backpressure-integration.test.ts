import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { NodeRuntimeManifest } from "../src/main/sidecar/node-runtime-locator.ts";
import { SidecarWorkerClient } from "../src/main/sidecar/worker-client.ts";
import type { SidecarEvent } from "../src/shared/sidecar-contracts.ts";
import { currentRuntimeCompatibility } from "../src/shared/sidecar-wire.ts";

describe("sidecar event backpressure", () => {
  it("uses the control lane to recover from event overflow without a fatal sequence gap", async () => {
    const events: SidecarEvent[] = [];
    let resolveResync!: (event: SidecarEvent) => void;
    const resync = new Promise<SidecarEvent>((resolvePromise) => {
      resolveResync = resolvePromise;
    });
    let client!: SidecarWorkerClient;
    client = new SidecarWorkerClient({
      manifest: manifest(),
      binding: { role: "metadata", value: { agentDir: "/tmp", userDataDir: "/tmp" } },
      onEvent: (event) => {
        events.push(event);
        if (event.event.type === "resync-required") {
          client.acknowledge(event.sequence);
          resolveResync(event);
        }
      },
    });
    try {
      await client.ready();
      await client.request({ type: "ping" }, 10_000);
      const overflow = await Promise.race([
        resync,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Resync timed out")), 10_000)),
      ]);

      expect(overflow.sequence).toBeGreaterThan(1);
      expect(overflow.event).toEqual({
        type: "resync-required",
        reason: "event-buffer-overflow",
        lastSafeSequence: 0,
      });
      expect(client.available).toBe(true);
      expect(events.some((event) => event.sequence > 1 && event.event.type !== "resync-required")).toBe(false);
      await expect(client.request({ type: "bootstrap" }, 10_000)).resolves.toBeNull();
    } finally {
      await client.shutdown();
    }
  }, 15_000);
});

function manifest(): NodeRuntimeManifest {
  const compatibility = currentRuntimeCompatibility("test", "test");
  return {
    nodePath: process.execPath,
    npmCliPath: process.execPath,
    entries: {
      thread: "",
      metadata: resolve(import.meta.dirname, "fixtures/overflow-sidecar.mjs"),
      subagent: "",
    },
    compatibility,
    integrity: {
      nodePath: "",
      npmCliPath: "",
      entries: { thread: "", metadata: "", subagent: "" },
      files: {},
    },
  };
}
