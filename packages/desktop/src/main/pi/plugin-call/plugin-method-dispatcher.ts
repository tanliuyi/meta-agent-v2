import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { JsonValue } from "../../../shared/contracts.ts";
import type {
  PluginMethodAttachment,
  PluginMethodExecutionContext,
} from "../../../shared/desktop-extension-contracts.ts";
import { normalizePluginError, PluginCallError } from "./plugin-call-errors.ts";
import { MAX_JSON_BYTES, snapshotJson } from "./plugin-call-json.ts";
import type { PluginCallLimits } from "./plugin-call-limits.ts";
import { DEFAULT_PLUGIN_CALL_LIMITS } from "./plugin-call-limits.ts";
import type { PluginMethodRegistry } from "./plugin-method-registry.ts";

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
}

export type PluginCallAttachment =
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

export interface PluginCallExecution {
  readonly calls: PluginSubCallRecord[];
  readonly logs: Array<{ sequence: number; level: string; text: string }>;
  readonly attachments?: PluginCallAttachment[];
  progressBytes?: number;
  responseBytes?: number;
  fileBytes?: number;
  imageBytes?: number;
  active?: boolean;
  toolContext?: unknown;
}

export class PluginMethodDispatcher {
  private readonly lanes = new Map<string, Promise<void>>();
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
    details: PluginCallExecution,
    limits: PluginCallLimits = DEFAULT_PLUGIN_CALL_LIMITS,
    onUpdate?: () => void,
  ): Promise<JsonValue> {
    const method = this.registry.get(pluginId)?.get(methodName);
    if (!method) {
      throw new PluginCallError(
        this.registry.has(pluginId) ? "PLUGIN_METHOD_NOT_FOUND" : "PLUGIN_NOT_FOUND",
        undefined,
        pluginId,
        methodName,
      );
    }
    if (signal.aborted || details.active === false) {
      throw new PluginCallError("PLUGIN_CALL_ABORTED", undefined, pluginId, methodName);
    }
    const callId = randomUUID();
    const record: PluginSubCallRecord = {
      sequence: details.calls.length + 1,
      callId,
      pluginId,
      method: methodName,
      source: method.source,
      state: "queued",
    };
    details.calls.push(record);
    onUpdate?.();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });

    const invoke = async (): Promise<JsonValue> => {
      if (signal.aborted || isInactive(details)) {
        record.state = "aborted";
        throw new PluginCallError("PLUGIN_CALL_ABORTED", undefined, pluginId, methodName);
      }
      record.state = "running";
      record.startedAt = Date.now();
      onUpdate?.();
      const stagedAttachments: PluginMethodAttachment[] = [];
      const context: PluginMethodExecutionContext = {
        pluginId,
        methodName,
        callId,
        toolCallId,
        cwd: this.cwd,
        signal: controller.signal,
        toolContext: details.toolContext,
        attach: (attachment) => {
          if (isInactive(details) || controller.signal.aborted) return;
          if ((details.attachments?.length ?? 0) + stagedAttachments.length >= limits.maxAttachments) {
            throw new PluginCallError(
              "PLUGIN_RESPONSE_LIMIT_EXCEEDED",
              "Attachment count limit exceeded",
              pluginId,
              methodName,
            );
          }
          stagedAttachments.push(snapshotAttachment(attachment, this.cwd, details, limits));
        },
        reportProgress: (progress) => {
          if (isInactive(details) || controller.signal.aborted) return;
          let value: JsonValue;
          try {
            value = snapshotJson(progress, limits.maxProgressBytes);
          } catch (error) {
            throw new PluginCallError(
              "PLUGIN_PROGRESS_LIMIT_EXCEEDED",
              error instanceof Error ? error.message : undefined,
              pluginId,
              methodName,
            );
          }
          const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
          details.progressBytes = (details.progressBytes ?? 0) + bytes;
          if (details.progressBytes > limits.maxCumulativeProgressBytes) {
            throw new PluginCallError("PLUGIN_PROGRESS_LIMIT_EXCEEDED", undefined, pluginId, methodName);
          }
          record.progress = value;
          onUpdate?.();
        },
      };
      try {
        let checkedArgs: JsonValue;
        try {
          const preparedArgs = method.prepareArguments ? method.prepareArguments(args) : args;
          checkedArgs = snapshotJson(preparedArgs, MAX_JSON_BYTES);
        } catch (error) {
          throw new PluginCallError(
            "PLUGIN_METHOD_INVALID_ARGUMENTS",
            error instanceof Error ? error.message : undefined,
            pluginId,
            methodName,
          );
        }
        if (!method.validateParameters(checkedArgs)) {
          throw new PluginCallError("PLUGIN_METHOD_INVALID_ARGUMENTS", undefined, pluginId, methodName);
        }
        const result = await method.execute(checkedArgs as never, controller.signal, context);
        if (isInactive(details) || signal.aborted) {
          throw new PluginCallError("PLUGIN_CALL_ABORTED", undefined, pluginId, methodName);
        }
        let value: JsonValue;
        try {
          value = snapshotJson(result, limits.maxMethodResponseBytes);
        } catch (error) {
          throw new PluginCallError(
            "PLUGIN_METHOD_INVALID_RESULT",
            error instanceof Error ? error.message : undefined,
            pluginId,
            methodName,
          );
        }
        if (!method.validateResult(value)) {
          throw new PluginCallError("PLUGIN_METHOD_INVALID_RESULT", undefined, pluginId, methodName);
        }
        const responseBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
        details.responseBytes = (details.responseBytes ?? 0) + responseBytes;
        if (details.responseBytes > limits.maxCumulativeResponseBytes) {
          throw new PluginCallError("PLUGIN_RESPONSE_LIMIT_EXCEEDED", undefined, pluginId, methodName);
        }
        const committedAttachments = await Promise.all(
          stagedAttachments.map((attachment) => materializeAttachment(attachment, this.cwd, limits)),
        );
        if (!isInactive(details)) details.attachments?.push(...committedAttachments);
        record.state = "complete";
        return value;
      } catch (error) {
        const normalized = normalizePluginError(error, "PLUGIN_METHOD_EXECUTION_FAILED");
        record.state = signal.aborted || normalized.code === "PLUGIN_CALL_ABORTED" ? "aborted" : "error";
        record.errorCode = normalized.code;
        throw normalized;
      } finally {
        record.completedAt = Date.now();
        record.durationMs = record.startedAt === undefined ? 0 : record.completedAt - record.startedAt;
        signal.removeEventListener("abort", abort);
        onUpdate?.();
      }
    };

    if (method.concurrency === "parallel") return invoke();
    const previous = this.lanes.get(pluginId) ?? Promise.resolve();
    const current = previous.then(invoke, invoke);
    this.lanes.set(
      pluginId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }
}

function isInactive(details: PluginCallExecution): boolean {
  return details.active === false;
}

function snapshotAttachment(
  attachment: PluginMethodAttachment,
  cwd: string,
  details: PluginCallExecution,
  limits: PluginCallLimits,
): PluginMethodAttachment {
  if (!attachment || typeof attachment !== "object") throw new PluginCallError("PLUGIN_INVALID_JSON");
  if (attachment.type === "image") {
    if (typeof attachment.data !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(attachment.mimeType)) {
      throw new PluginCallError("PLUGIN_INVALID_JSON");
    }
    const decoded = Buffer.from(attachment.data, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") !== attachment.data.replace(/=+$/, "")) {
      throw new PluginCallError("PLUGIN_ATTACHMENT_LIMIT_EXCEEDED", "Image attachment is not valid base64");
    }
    details.imageBytes = (details.imageBytes ?? 0) + decoded.byteLength;
    if (details.imageBytes > limits.maxImageBytes) throw new PluginCallError("PLUGIN_ATTACHMENT_LIMIT_EXCEEDED");
    return {
      type: "image",
      data: attachment.data,
      mimeType: attachment.mimeType,
      ...(attachment.name ? { name: attachment.name } : {}),
    };
  }
  if (attachment.type === "file" && typeof attachment.path === "string") {
    const requested = isAbsolute(attachment.path) ? attachment.path : resolve(cwd, attachment.path);
    const canonicalPath = realpathSync(requested);
    const info = lstatSync(canonicalPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxFileBytes) {
      throw new PluginCallError("PLUGIN_ATTACHMENT_LIMIT_EXCEEDED");
    }
    details.fileBytes = (details.fileBytes ?? 0) + info.size;
    if (details.fileBytes > limits.maxCumulativeFileBytes) {
      throw new PluginCallError("PLUGIN_ATTACHMENT_LIMIT_EXCEEDED");
    }
    return {
      type: "file",
      path: canonicalPath,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.name ? { name: attachment.name } : {}),
    };
  }
  throw new PluginCallError("PLUGIN_INVALID_JSON");
}

async function materializeAttachment(
  attachment: PluginMethodAttachment,
  cwd: string,
  limits: PluginCallLimits,
): Promise<PluginCallAttachment> {
  if (attachment.type === "image") {
    const decoded = Buffer.from(attachment.data, "base64");
    if (decoded.byteLength > limits.maxImageBytes) throw new PluginCallError("PLUGIN_RESPONSE_LIMIT_EXCEEDED");
    return attachment;
  }
  const requested = isAbsolute(attachment.path) ? attachment.path : resolve(cwd, attachment.path);
  const canonicalPath = await realpath(requested);
  const info = await lstat(canonicalPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxFileBytes) {
    throw new PluginCallError("PLUGIN_RESPONSE_LIMIT_EXCEEDED");
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
