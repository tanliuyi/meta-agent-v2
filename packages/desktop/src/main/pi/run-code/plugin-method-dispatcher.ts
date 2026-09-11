import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { JsonValue } from "../../../shared/contracts.ts";
import type {
  PluginMethodAttachment,
  PluginMethodExecutionContext,
  PluginMethodSource,
} from "../../../shared/desktop-extension-contracts.ts";
import type { PluginMethodRegistry } from "./plugin-method-registry.ts";
import { normalizePluginError, RunCodeError } from "./run-code-errors.ts";
import { MAX_JSON_BYTES, snapshotJson } from "./run-code-json.ts";
import type { RunCodeLimits } from "./run-code-limits.ts";
import {
  DEFAULT_RUN_CODE_LIMITS,
  MAX_CONCURRENT_GENERATION_PLUGIN_CALLS,
  RUN_CODE_CLEANUP_GRACE_MS,
} from "./run-code-limits.ts";

export interface PluginSubCallRecord {
  sequence: number;
  callId: string;
  pluginId: string;
  method: string;
  source: string;
  state: "queued" | "running" | "complete" | "error" | "aborted";
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  errorCode?: string;
  progress?: JsonValue;
  sources?: PluginMethodSource[];
}

export type RunCodeAttachment =
  | { type: "image"; data: string; mimeType: string; name?: string }
  | {
      type: "file";
      artifactId: string;
      canonicalPath: string;
      name: string;
      mimeType?: string;
      size: number;
      sha256: string;
    };

export interface RunCodeExecution {
  readonly calls: PluginSubCallRecord[];
  readonly logs: Array<{ sequence: number; level: string; text: string }>;
  readonly attachments?: RunCodeAttachment[];
  progressBytes?: number;
  responseBytes?: number;
  fileBytes?: number;
  imageBytes?: number;
  active?: boolean;
  toolContext?: unknown;
}

interface StagedAttachment {
  attachment: PluginMethodAttachment;
  imageBytes: number;
  fileBytes: number;
}

interface PendingCommit<T> {
  action: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Serializes run-local observable commits while allowing method bodies to overlap. */
export class RunCodeCommitCoordinator {
  private nextSequence: number;
  private readonly pending = new Map<number, PendingCommit<unknown>>();
  private committing = false;
  private aborted?: RunCodeError;

  constructor(firstSequence = 1) {
    this.nextSequence = firstSequence;
  }

  commit<T>(sequence: number, action: () => Promise<T>): Promise<T> {
    if (this.aborted) return Promise.reject(this.aborted);
    if (sequence < this.nextSequence || this.pending.has(sequence)) {
      return Promise.reject(new RunCodeError("PLUGIN_METHOD_EXECUTION_FAILED", "Invalid plugin commit sequence"));
    }
    return new Promise<T>((resolvePromise, reject) => {
      this.pending.set(sequence, {
        action,
        resolve: (value) => resolvePromise(value as T),
        reject,
      });
      this.drain();
    });
  }

  abort(error: RunCodeError): void {
    if (this.aborted) return;
    this.aborted = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private drain(): void {
    if (this.committing || this.aborted) return;
    const pending = this.pending.get(this.nextSequence);
    if (!pending) return;
    this.pending.delete(this.nextSequence);
    this.committing = true;
    void pending
      .action()
      .then(pending.resolve, pending.reject)
      .finally(() => {
        this.nextSequence += 1;
        this.committing = false;
        this.drain();
      });
  }
}

interface QueuedWork {
  signal: AbortSignal;
  running: boolean;
  poisonTimer?: ReturnType<typeof setTimeout>;
  start: () => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

class AbortableSemaphore {
  private readonly limit: number;
  private active = 0;
  private readonly queue: QueuedWork[] = [];
  private poisoned?: RunCodeError;

  constructor(limit: number) {
    this.limit = limit;
  }

  run<T>(signal: AbortSignal, pluginId: string, action: () => Promise<T>): Promise<T> {
    if (this.poisoned) return Promise.reject(this.poisoned);
    if (signal.aborted) return Promise.reject(new RunCodeError("PLUGIN_CALL_ABORTED"));
    return new Promise<T>((resolvePromise, reject) => {
      const work: QueuedWork = {
        signal,
        running: false,
        reject,
        abort: () => {
          if (work.running) {
            if (work.poisonTimer) return;
            work.poisonTimer = setTimeout(() => {
              if (!work.running) return;
              const error = new RunCodeError(
                "PLUGIN_GENERATION_STALE",
                `Plugin method ${pluginId} ignored cancellation`,
                pluginId,
              );
              reject(error);
              this.poison(error);
            }, RUN_CODE_CLEANUP_GRACE_MS);
            return;
          }
          const index = this.queue.indexOf(work);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", work.abort);
          reject(new RunCodeError("PLUGIN_CALL_ABORTED"));
        },
        start: () => {
          work.running = true;
          this.active += 1;
          void action()
            .then(resolvePromise, reject)
            .finally(() => {
              work.running = false;
              if (work.poisonTimer) clearTimeout(work.poisonTimer);
              signal.removeEventListener("abort", work.abort);
              this.active -= 1;
              this.pump();
            });
        },
      };
      signal.addEventListener("abort", work.abort, { once: true });
      this.queue.push(work);
      this.pump();
    });
  }

  private pump(): void {
    if (this.poisoned) return;
    while (this.active < this.limit) {
      const work = this.queue.shift();
      if (!work) return;
      if (work.signal.aborted) {
        work.signal.removeEventListener("abort", work.abort);
        work.reject(new RunCodeError("PLUGIN_CALL_ABORTED"));
        continue;
      }
      work.start();
    }
  }

  private poison(error: RunCodeError): void {
    if (this.poisoned) return;
    this.poisoned = error;
    for (const work of this.queue.splice(0)) {
      work.signal.removeEventListener("abort", work.abort);
      work.reject(error);
    }
  }
}

type SerialWork = QueuedWork;

class PluginSerialLane {
  private readonly queue: SerialWork[] = [];
  private active?: SerialWork;
  private poisoned?: RunCodeError;

  run<T>(signal: AbortSignal, pluginId: string, action: () => Promise<T>): Promise<T> {
    if (this.poisoned) return Promise.reject(this.poisoned);
    if (signal.aborted) return Promise.reject(new RunCodeError("PLUGIN_CALL_ABORTED", undefined, pluginId));
    return new Promise<T>((resolvePromise, reject) => {
      const work: SerialWork = {
        signal,
        running: false,
        reject,
        abort: () => {
          if (!work.running) {
            const index = this.queue.indexOf(work);
            if (index >= 0) this.queue.splice(index, 1);
            signal.removeEventListener("abort", work.abort);
            reject(new RunCodeError("PLUGIN_CALL_ABORTED", undefined, pluginId));
            return;
          }
          work.poisonTimer = setTimeout(() => {
            if (this.active !== work) return;
            this.poison(new RunCodeError("PLUGIN_GENERATION_STALE", `Serial plugin ${pluginId} ignored cancellation`));
          }, RUN_CODE_CLEANUP_GRACE_MS);
        },
        start: () => {
          work.running = true;
          this.active = work;
          void action()
            .then((value) => {
              if (signal.aborted) reject(new RunCodeError("PLUGIN_CALL_ABORTED", undefined, pluginId));
              else resolvePromise(value);
            }, reject)
            .finally(() => {
              if (work.poisonTimer) clearTimeout(work.poisonTimer);
              signal.removeEventListener("abort", work.abort);
              if (this.active === work) this.active = undefined;
              this.pump(pluginId);
            });
        },
      };
      signal.addEventListener("abort", work.abort, { once: true });
      this.queue.push(work);
      this.pump(pluginId);
    });
  }

  private pump(pluginId: string): void {
    if (this.active || this.poisoned) return;
    const work = this.queue.shift();
    if (!work) return;
    if (work.signal.aborted) {
      work.signal.removeEventListener("abort", work.abort);
      work.reject(new RunCodeError("PLUGIN_CALL_ABORTED", undefined, pluginId));
      this.pump(pluginId);
      return;
    }
    work.start();
  }

  private poison(error: RunCodeError): void {
    if (this.poisoned) return;
    this.poisoned = error;
    this.active?.reject(error);
    for (const work of this.queue.splice(0)) {
      work.signal.removeEventListener("abort", work.abort);
      work.reject(error);
    }
  }
}

/** 将 run_code 内的 plugin.namespace.method 调用映射到已批准的方法表。 */
export class PluginMethodDispatcher {
  private readonly lanes = new Map<string, PluginSerialLane>();
  private readonly admission = new AbortableSemaphore(MAX_CONCURRENT_GENERATION_PLUGIN_CALLS);
  private readonly registry: PluginMethodRegistry;
  private readonly cwd: string;

  constructor(registry: PluginMethodRegistry, cwd: string) {
    this.registry = registry;
    this.cwd = cwd;
  }

  pluginIds(): string[] {
    return [...this.registry.keys()];
  }

  pluginMethods(): Record<string, string[]> {
    return Object.fromEntries([...this.registry].map(([pluginId, methods]) => [pluginId, [...methods.keys()]]));
  }

  async call(
    pluginId: string,
    methodName: string,
    args: unknown,
    signal: AbortSignal,
    toolCallId: string,
    details: RunCodeExecution,
    limits: RunCodeLimits = DEFAULT_RUN_CODE_LIMITS,
    onUpdate?: () => void,
    commits?: RunCodeCommitCoordinator,
  ): Promise<JsonValue> {
    const method = this.registry.get(pluginId)?.get(methodName);
    if (!method) {
      throw new RunCodeError(
        this.registry.has(pluginId) ? "PLUGIN_METHOD_NOT_FOUND" : "PLUGIN_NOT_FOUND",
        undefined,
        pluginId,
        methodName,
      );
    }
    if (signal.aborted || isInactive(details)) {
      throw new RunCodeError("PLUGIN_CALL_ABORTED", undefined, pluginId, methodName);
    }
    const record: PluginSubCallRecord = {
      sequence: details.calls.length + 1,
      callId: randomUUID(),
      pluginId,
      method: methodName,
      source: method.source,
      state: "queued",
    };
    const coordinator = commits ?? new RunCodeCommitCoordinator(record.sequence);
    details.calls.push(record);
    publish(details, onUpdate);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });

    const execute = async (): Promise<{
      value: JsonValue;
      responseBytes: number;
      attachments: StagedAttachment[];
      sources: PluginMethodSource[];
    }> => {
      if (signal.aborted || isInactive(details)) {
        throw new RunCodeError("PLUGIN_CALL_ABORTED", undefined, pluginId, methodName);
      }
      record.state = "running";
      record.startedAt = Date.now();
      publish(details, onUpdate);
      const stagedAttachments: StagedAttachment[] = [];
      const stagedSources: PluginMethodSource[] = [];
      const context: PluginMethodExecutionContext = {
        pluginId,
        methodName,
        callId: record.callId,
        toolCallId,
        cwd: this.cwd,
        signal: controller.signal,
        toolContext: details.toolContext,
        attach: (attachment) => {
          if (isInactive(details) || controller.signal.aborted) return;
          if (stagedAttachments.length >= limits.maxAttachments) {
            throw new RunCodeError(
              "PLUGIN_RESPONSE_LIMIT_EXCEEDED",
              "Attachment count limit exceeded",
              pluginId,
              methodName,
            );
          }
          stagedAttachments.push(snapshotAttachment(attachment, this.cwd, limits));
        },
        reportProgress: (progress) => {
          if (isInactive(details) || controller.signal.aborted) return;
          let value: JsonValue;
          try {
            value = snapshotJson(progress, limits.maxProgressBytes);
          } catch (error) {
            throw new RunCodeError(
              "PLUGIN_PROGRESS_LIMIT_EXCEEDED",
              error instanceof Error ? error.message : undefined,
              pluginId,
              methodName,
            );
          }
          const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
          details.progressBytes = (details.progressBytes ?? 0) + bytes;
          if (details.progressBytes > limits.maxCumulativeProgressBytes) {
            throw new RunCodeError("PLUGIN_PROGRESS_LIMIT_EXCEEDED", undefined, pluginId, methodName);
          }
          record.progress = value;
          publish(details, onUpdate);
        },
        reportSources: (sources) => {
          if (isInactive(details) || controller.signal.aborted) return;
          stagedSources.push(...snapshotSources(sources));
        },
      };
      let checkedArgs: JsonValue;
      try {
        const preparedArgs = method.prepareArguments ? method.prepareArguments(args) : args;
        checkedArgs = snapshotJson(preparedArgs, MAX_JSON_BYTES);
      } catch (error) {
        throw new RunCodeError(
          "PLUGIN_METHOD_INVALID_ARGUMENTS",
          error instanceof Error ? error.message : undefined,
          pluginId,
          methodName,
        );
      }
      if (!method.validateParameters(checkedArgs)) {
        throw new RunCodeError("PLUGIN_METHOD_INVALID_ARGUMENTS", undefined, pluginId, methodName);
      }
      const result = await method.execute(checkedArgs as never, controller.signal, context);
      if (isInactive(details) || signal.aborted) {
        throw new RunCodeError("PLUGIN_CALL_ABORTED", undefined, pluginId, methodName);
      }
      let value: JsonValue;
      try {
        value = snapshotJson(result, limits.maxMethodResponseBytes);
      } catch (error) {
        throw new RunCodeError(
          "PLUGIN_METHOD_INVALID_RESULT",
          error instanceof Error ? error.message : undefined,
          pluginId,
          methodName,
        );
      }
      if (!method.validateResult(value)) {
        throw new RunCodeError("PLUGIN_METHOD_INVALID_RESULT", undefined, pluginId, methodName);
      }
      return {
        value,
        responseBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
        attachments: stagedAttachments,
        sources: stagedSources,
      };
    };

    try {
      let outcome: { ok: true; prepared: Awaited<ReturnType<typeof execute>> } | { ok: false; error: RunCodeError };
      try {
        const invoke = () => this.admission.run(signal, pluginId, execute);
        const prepared =
          method.concurrency === "parallel"
            ? await invoke()
            : await this.serialLane(pluginId).run(signal, pluginId, invoke);
        outcome = { ok: true, prepared };
      } catch (error) {
        outcome = { ok: false, error: normalizePluginError(error, "PLUGIN_METHOD_EXECUTION_FAILED") };
      }

      return await coordinator.commit(record.sequence, async () => {
        if (!outcome.ok) throw outcome.error;
        if (signal.aborted || isInactive(details)) {
          throw new RunCodeError("PLUGIN_CALL_ABORTED", undefined, pluginId, methodName);
        }
        const nextResponseBytes = (details.responseBytes ?? 0) + outcome.prepared.responseBytes;
        if (nextResponseBytes > limits.maxCumulativeResponseBytes) {
          throw new RunCodeError("PLUGIN_RESPONSE_LIMIT_EXCEEDED", undefined, pluginId, methodName);
        }
        if ((details.attachments?.length ?? 0) + outcome.prepared.attachments.length > limits.maxAttachments) {
          throw new RunCodeError(
            "PLUGIN_RESPONSE_LIMIT_EXCEEDED",
            "Attachment count limit exceeded",
            pluginId,
            methodName,
          );
        }
        const nextImageBytes =
          (details.imageBytes ?? 0) + outcome.prepared.attachments.reduce((sum, item) => sum + item.imageBytes, 0);
        const nextFileBytes =
          (details.fileBytes ?? 0) + outcome.prepared.attachments.reduce((sum, item) => sum + item.fileBytes, 0);
        if (nextImageBytes > limits.maxImageBytes || nextFileBytes > limits.maxCumulativeFileBytes) {
          throw new RunCodeError("PLUGIN_ATTACHMENT_LIMIT_EXCEEDED", undefined, pluginId, methodName);
        }
        const committedAttachments = await Promise.all(
          outcome.prepared.attachments.map(({ attachment }) => materializeAttachment(attachment, this.cwd, limits)),
        );
        if (signal.aborted || isInactive(details)) {
          throw new RunCodeError("PLUGIN_CALL_ABORTED", undefined, pluginId, methodName);
        }
        details.responseBytes = nextResponseBytes;
        details.imageBytes = nextImageBytes;
        details.fileBytes = nextFileBytes;
        details.attachments?.push(...committedAttachments);
        if (outcome.prepared.sources.length > 0) record.sources = outcome.prepared.sources;
        record.state = "complete";
        return outcome.prepared.value;
      });
    } catch (error) {
      const normalized = normalizePluginError(error, "PLUGIN_METHOD_EXECUTION_FAILED");
      const attributed = new RunCodeError(normalized.code, normalized.message, pluginId, methodName);
      if (!isInactive(details)) {
        record.state = signal.aborted || attributed.code === "PLUGIN_CALL_ABORTED" ? "aborted" : "error";
        record.errorCode = attributed.code;
      }
      throw attributed;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!isInactive(details)) {
        record.completedAt = Date.now();
        record.durationMs = record.startedAt === undefined ? 0 : record.completedAt - record.startedAt;
        publish(details, onUpdate);
      }
    }
  }

  private serialLane(pluginId: string): PluginSerialLane {
    const existing = this.lanes.get(pluginId);
    if (existing) return existing;
    const lane = new PluginSerialLane();
    this.lanes.set(pluginId, lane);
    return lane;
  }
}

function publish(details: RunCodeExecution, onUpdate: (() => void) | undefined): void {
  if (!isInactive(details)) onUpdate?.();
}

function isInactive(details: RunCodeExecution): boolean {
  return details.active === false;
}

function snapshotSources(sources: readonly PluginMethodSource[]): PluginMethodSource[] {
  if (!Array.isArray(sources) || sources.length > 100) throw new RunCodeError("PLUGIN_INVALID_JSON");
  const result: PluginMethodSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source !== "object" || typeof source.url !== "string" || source.url.length > 2_048) {
      throw new RunCodeError("PLUGIN_INVALID_JSON");
    }
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new RunCodeError("PLUGIN_INVALID_JSON");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || seen.has(url.href)) continue;
    if (source.title !== undefined && (typeof source.title !== "string" || source.title.length > 512)) {
      throw new RunCodeError("PLUGIN_INVALID_JSON");
    }
    seen.add(url.href);
    result.push({ url: url.href, ...(source.title?.trim() ? { title: source.title.trim() } : {}) });
  }
  return result;
}

function snapshotAttachment(attachment: PluginMethodAttachment, cwd: string, limits: RunCodeLimits): StagedAttachment {
  if (!attachment || typeof attachment !== "object") throw new RunCodeError("PLUGIN_INVALID_JSON");
  if (attachment.type === "image") {
    if (typeof attachment.data !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(attachment.mimeType)) {
      throw new RunCodeError("PLUGIN_INVALID_JSON");
    }
    const decoded = Buffer.from(attachment.data, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") !== attachment.data.replace(/=+$/, "")) {
      throw new RunCodeError("PLUGIN_ATTACHMENT_LIMIT_EXCEEDED", "Image attachment is not valid base64");
    }
    if (decoded.byteLength > limits.maxImageBytes) throw new RunCodeError("PLUGIN_ATTACHMENT_LIMIT_EXCEEDED");
    return {
      attachment: {
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType,
        ...(attachment.name ? { name: attachment.name } : {}),
      },
      imageBytes: decoded.byteLength,
      fileBytes: 0,
    };
  }
  if (attachment.type === "file" && typeof attachment.path === "string") {
    const requested = isAbsolute(attachment.path) ? attachment.path : resolve(cwd, attachment.path);
    const canonicalPath = realpathSync(requested);
    const info = lstatSync(canonicalPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxFileBytes) {
      throw new RunCodeError("PLUGIN_ATTACHMENT_LIMIT_EXCEEDED");
    }
    return {
      attachment: {
        type: "file",
        path: canonicalPath,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.name ? { name: attachment.name } : {}),
      },
      imageBytes: 0,
      fileBytes: info.size,
    };
  }
  throw new RunCodeError("PLUGIN_INVALID_JSON");
}

async function materializeAttachment(
  attachment: PluginMethodAttachment,
  cwd: string,
  limits: RunCodeLimits,
): Promise<RunCodeAttachment> {
  if (attachment.type === "image") {
    const decoded = Buffer.from(attachment.data, "base64");
    if (decoded.byteLength > limits.maxImageBytes) throw new RunCodeError("PLUGIN_RESPONSE_LIMIT_EXCEEDED");
    return attachment;
  }
  const requested = isAbsolute(attachment.path) ? attachment.path : resolve(cwd, attachment.path);
  const canonicalPath = await realpath(requested);
  const info = await lstat(canonicalPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxFileBytes) {
    throw new RunCodeError("PLUGIN_RESPONSE_LIMIT_EXCEEDED");
  }
  return {
    type: "file",
    artifactId: randomUUID(),
    canonicalPath,
    name: attachment.name ?? basename(canonicalPath),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    size: info.size,
    sha256: await hashFile(canonicalPath),
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}
