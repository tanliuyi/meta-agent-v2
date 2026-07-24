import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import type { JsonValue } from "./contracts.ts";
import {
  type RuntimeCompatibility,
  type SerializedSidecarError,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarChunk,
} from "./sidecar-contracts.ts";

export const MAX_SIDECAR_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_SIDECAR_TRANSFER_BYTES = 64 * 1024 * 1024;
const SIDECAR_CHUNK_BYTES = 512 * 1024;

export function createSidecarChunks(
  message: unknown,
  workerInstanceId: string,
  lane: SidecarChunk["lane"],
): SidecarChunk[] | undefined {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.byteLength <= MAX_SIDECAR_MESSAGE_BYTES) return undefined;
  if (payload.byteLength > MAX_SIDECAR_TRANSFER_BYTES) {
    throw new Error(`Sidecar transfer exceeds ${MAX_SIDECAR_TRANSFER_BYTES} bytes`);
  }
  const transferId = randomUUID();
  const total = Math.ceil(payload.byteLength / SIDECAR_CHUNK_BYTES);
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  const chunks: SidecarChunk[] = [];
  for (let index = 0; index < total; index += 1) {
    chunks.push({
      kind: "chunk",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId,
      transferId,
      lane,
      index,
      total,
      payloadBytes: payload.byteLength,
      payloadSha256,
      data: payload.subarray(index * SIDECAR_CHUNK_BYTES, (index + 1) * SIDECAR_CHUNK_BYTES).toString("base64"),
    });
  }
  return chunks;
}

export class SidecarChunkAssembler {
  private readonly maxTransferAgeMs: number;
  private readonly now: () => number;
  private readonly transfers = new Map<
    string,
    {
      workerInstanceId: string;
      lane: SidecarChunk["lane"];
      total: number;
      payloadBytes: number;
      payloadSha256: string;
      chunks: Array<Buffer | undefined>;
      receivedBytes: number;
      createdAt: number;
    }
  >();

  constructor(options?: { maxTransferAgeMs?: number; now?: () => number }) {
    this.maxTransferAgeMs = options?.maxTransferAgeMs ?? 30_000;
    this.now = options?.now ?? Date.now;
  }

  accept(chunk: SidecarChunk): unknown | undefined {
    if (
      !Number.isSafeInteger(chunk.index) ||
      !Number.isSafeInteger(chunk.total) ||
      chunk.total < 1 ||
      chunk.total > 128
    ) {
      throw new Error("Invalid sidecar chunk coordinates");
    }
    if (
      !Number.isSafeInteger(chunk.payloadBytes) ||
      chunk.payloadBytes < 1 ||
      chunk.payloadBytes > MAX_SIDECAR_TRANSFER_BYTES ||
      !/^[a-f0-9]{64}$/i.test(chunk.payloadSha256)
    ) {
      throw new Error("Invalid sidecar chunk payload identity");
    }
    if (chunk.index < 0 || chunk.index >= chunk.total) throw new Error("Invalid sidecar chunk index");
    const now = this.now();
    let transfer = this.transfers.get(chunk.transferId);
    if (transfer && now - transfer.createdAt > this.maxTransferAgeMs) {
      this.transfers.delete(chunk.transferId);
      throw new Error("Sidecar chunk transfer expired");
    }
    for (const [transferId, pending] of this.transfers) {
      if (now - pending.createdAt > this.maxTransferAgeMs) this.transfers.delete(transferId);
    }
    if (!transfer) {
      if (this.transfers.size >= 8) throw new Error("Too many concurrent sidecar chunk transfers");
      transfer = {
        workerInstanceId: chunk.workerInstanceId,
        lane: chunk.lane,
        total: chunk.total,
        payloadBytes: chunk.payloadBytes,
        payloadSha256: chunk.payloadSha256,
        chunks: Array.from({ length: chunk.total }),
        receivedBytes: 0,
        createdAt: now,
      };
      this.transfers.set(chunk.transferId, transfer);
    }
    if (
      transfer.workerInstanceId !== chunk.workerInstanceId ||
      transfer.lane !== chunk.lane ||
      transfer.total !== chunk.total ||
      transfer.payloadBytes !== chunk.payloadBytes ||
      transfer.payloadSha256 !== chunk.payloadSha256
    ) {
      throw new Error("Sidecar chunk transfer identity mismatch");
    }
    if (transfer.chunks[chunk.index]) throw new Error("Duplicate sidecar chunk");
    const data = Buffer.from(chunk.data, "base64");
    transfer.receivedBytes += data.byteLength;
    if (transfer.receivedBytes > transfer.payloadBytes) throw new Error("Sidecar chunk transfer is too large");
    transfer.chunks[chunk.index] = data;
    if (transfer.chunks.some((item) => item === undefined)) return undefined;
    this.transfers.delete(chunk.transferId);
    const payload = Buffer.concat(transfer.chunks as Buffer[]);
    if (payload.byteLength !== transfer.payloadBytes) throw new Error("Sidecar chunk transfer length mismatch");
    const actualSha256 = createHash("sha256").update(payload).digest("hex");
    if (actualSha256 !== transfer.payloadSha256) throw new Error("Sidecar chunk transfer integrity mismatch");
    return JSON.parse(payload.toString("utf8"));
  }
}

export class SidecarEventAckTracker {
  private readonly events = new Map<number, { creditCost: number; acknowledged: boolean }>();
  private lastAcknowledgedSequence = 0;

  receive(sequence: number, creditCost: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(creditCost) || creditCost < 0) {
      throw new Error("Invalid sidecar event acknowledgement coordinates");
    }
    if (sequence <= this.lastAcknowledgedSequence || this.events.has(sequence)) {
      throw new Error(`Duplicate sidecar event sequence: ${sequence}`);
    }
    this.events.set(sequence, { creditCost, acknowledged: false });
  }

  acknowledge(sequence: number): { throughSequence: number; credit: number } | undefined {
    if (sequence <= this.lastAcknowledgedSequence) return undefined;
    const event = this.events.get(sequence);
    if (!event) throw new Error(`Unknown sidecar event sequence: ${sequence}`);
    event.acknowledged = true;
    let throughSequence = this.lastAcknowledgedSequence;
    let credit = 0;
    for (;;) {
      const nextSequence = throughSequence + 1;
      const next = this.events.get(nextSequence);
      if (!next?.acknowledged) break;
      throughSequence = nextSequence;
      credit += next.creditCost;
      this.events.delete(nextSequence);
    }
    if (throughSequence === this.lastAcknowledgedSequence) return undefined;
    this.lastAcknowledgedSequence = throughSequence;
    return { throughSequence, credit };
  }

  resetThrough(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < this.lastAcknowledgedSequence) {
      throw new Error(`Invalid sidecar event acknowledgement reset: ${sequence}`);
    }
    this.events.clear();
    this.lastAcknowledgedSequence = sequence;
  }
}

export function currentRuntimeCompatibility(piVersion: string, runtimeCompatibilityId: string): RuntimeCompatibility {
  return {
    nodeVersion: process.version,
    modulesAbi: process.versions.modules,
    napi: process.versions.napi ?? "unknown",
    platform: process.platform,
    arch: process.arch,
    osRelease: runtimeOsBaseline(),
    libc: runtimeLibcBaseline(),
    toolchain: runtimeToolchain(),
    piVersion,
    runtimeCompatibilityId,
  };
}

export function assertRuntimeCompatibility(expected: RuntimeCompatibility, actual: RuntimeCompatibility): void {
  const fields = [
    "nodeVersion",
    "modulesAbi",
    "napi",
    "platform",
    "arch",
    "osRelease",
    "libc",
    "toolchain",
    "piVersion",
    "runtimeCompatibilityId",
  ] as const;
  const mismatches = fields
    .filter((field) => expected[field] !== actual[field])
    .map((field) => `${field}: expected ${expected[field]}, got ${actual[field]}`);
  if (mismatches.length > 0) throw new Error(`Sidecar runtime mismatch: ${mismatches.join("; ")}`);
}

function runtimeOsBaseline(): string {
  if (process.platform === "darwin") return "darwin-23+";
  if (process.platform === "win32") return "windows-10+";
  if (process.platform === "linux") return "linux-kernel-4.18+";
  return "unsupported";
}

function runtimeLibcBaseline(): string {
  if (process.platform === "darwin") return "libSystem";
  if (process.platform === "win32") return "ucrt";
  if (process.platform === "linux") return "glibc-2.28+";
  return "unknown";
}

function runtimeToolchain(): string {
  const variables = process.config.variables as Record<string, string | number | boolean | undefined>;
  return [variables.host_arch, variables.target_arch, variables.v8_target_arch]
    .filter((value) => value !== undefined)
    .join(":");
}

export function assertSidecarProtocolVersion(protocolVersion: number): void {
  if (protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
    throw new Error(`Sidecar protocol mismatch: expected ${SIDECAR_PROTOCOL_VERSION}, got ${protocolVersion}`);
  }
}

export function toJsonValue(value: unknown, maxBytes = MAX_SIDECAR_MESSAGE_BYTES): JsonValue {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "function" || typeof item === "symbol") return undefined;
    return item;
  });
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`Sidecar message exceeds ${maxBytes} bytes`);
  }
  return JSON.parse(serialized) as JsonValue;
}

export function serializeSidecarError(error: unknown): SerializedSidecarError {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    const details = "details" in error ? toJsonValue(error.details) : undefined;
    const retryable = "retryable" in error && error.retryable === true;
    return {
      name: error.name,
      message: error.message,
      code,
      retryable,
      details,
      stack: error.stack,
    };
  }
  return { name: "Error", message: String(error), retryable: false };
}
