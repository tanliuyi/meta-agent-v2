import { describe, expect, it } from "vitest";
import { SIDECAR_PROTOCOL_VERSION } from "../src/shared/sidecar-contracts.ts";
import {
  createSidecarChunks,
  currentRuntimeCompatibility,
  SidecarChunkAssembler,
  SidecarEventAckTracker,
} from "../src/shared/sidecar-wire.ts";

describe("sidecar runtime compatibility", () => {
  it("uses architecture without compiler build flags for the toolchain identity", () => {
    const variables = process.config.variables as Record<string, string | number | boolean | undefined>;
    const expected = [variables.host_arch, variables.target_arch, variables.v8_target_arch]
      .filter((value) => value !== undefined)
      .join(":");

    expect(currentRuntimeCompatibility("test", "test").toolchain).toBe(expected);
  });
});

describe("sidecar chunk transport", () => {
  it("round-trips a response larger than one IPC envelope", () => {
    const message = {
      kind: "response" as const,
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: "worker",
      requestId: "request",
      ok: true as const,
      result: { text: "x".repeat(10 * 1024 * 1024) },
    };
    const chunks = createSidecarChunks(message, "worker", "control");
    expect(chunks).toBeDefined();
    expect(chunks!.length).toBeGreaterThan(1);

    const assembler = new SidecarChunkAssembler();
    let assembled: unknown;
    for (const chunk of chunks!.toReversed()) assembled = assembler.accept(chunk) ?? assembled;
    expect(assembled).toEqual(message);
  });

  it("rejects duplicate chunks instead of growing an ambiguous transfer", () => {
    const message = { value: "x".repeat(10 * 1024 * 1024) };
    const chunks = createSidecarChunks(message, "worker", "event");
    if (!chunks?.[0]) throw new Error("Chunk fixture was not created");
    const assembler = new SidecarChunkAssembler();

    expect(assembler.accept(chunks[0])).toBeUndefined();
    expect(() => assembler.accept(chunks[0]!)).toThrow("Duplicate sidecar chunk");
  });

  it("rejects a transfer whose payload was modified in transit", () => {
    const chunks = createSidecarChunks({ value: "x".repeat(10 * 1024 * 1024) }, "worker", "event");
    if (!chunks?.[0]) throw new Error("Chunk fixture was not created");
    const tampered = chunks.map((chunk, index) =>
      index === 0 ? { ...chunk, data: Buffer.from("tampered").toString("base64") } : chunk,
    );
    const assembler = new SidecarChunkAssembler();

    expect(() => {
      for (const chunk of tampered) assembler.accept(chunk);
    }).toThrow(/length mismatch|integrity mismatch/);
  });

  it("expires incomplete transfers before accepting additional chunks", () => {
    const chunks = createSidecarChunks({ value: "x".repeat(10 * 1024 * 1024) }, "worker", "control");
    if (!chunks?.[0] || !chunks[1]) throw new Error("Chunk fixture was not created");
    let now = 0;
    const assembler = new SidecarChunkAssembler({ maxTransferAgeMs: 100, now: () => now });
    expect(assembler.accept(chunks[0])).toBeUndefined();

    now = 101;
    expect(() => assembler.accept(chunks[1]!)).toThrow("Sidecar chunk transfer expired");
  });
});

describe("sidecar event acknowledgement tracking", () => {
  it("does not advance past an unacknowledged event", () => {
    const tracker = new SidecarEventAckTracker();
    tracker.receive(1, 2);
    tracker.receive(2, 1);

    expect(tracker.acknowledge(2)).toBeUndefined();
    expect(tracker.acknowledge(1)).toEqual({ throughSequence: 2, credit: 3 });
  });

  it("settles zero-credit control events without inflating event credit", () => {
    const tracker = new SidecarEventAckTracker();
    tracker.receive(1, 0);

    expect(tracker.acknowledge(1)).toEqual({ throughSequence: 1, credit: 0 });
    expect(tracker.acknowledge(1)).toBeUndefined();
  });

  it("resets obsolete unacknowledged events before a resync control event", () => {
    const tracker = new SidecarEventAckTracker();
    tracker.receive(1, 1);
    tracker.receive(2, 1);

    tracker.resetThrough(8);
    tracker.receive(9, 0);
    expect(tracker.acknowledge(1)).toBeUndefined();
    expect(tracker.acknowledge(9)).toEqual({ throughSequence: 9, credit: 0 });
  });
});
