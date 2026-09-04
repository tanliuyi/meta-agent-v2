import { randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { Worker } from "node:worker_threads";
import type { JsonValue } from "../../../shared/contracts.ts";
import type { PluginMethodDispatcher, RunCodeExecution } from "./plugin-method-dispatcher.ts";
import { isRunCodeErrorCode, normalizePluginError, RunCodeError, type RunCodeErrorCode } from "./run-code-errors.ts";
import { snapshotJson } from "./run-code-json.ts";
import { DEFAULT_RUN_CODE_LIMITS, type RunCodeLimits } from "./run-code-limits.ts";

const CLEANUP_GRACE_MS = 350;

interface ActiveRun {
  controller: AbortController;
  finished: Promise<void>;
}

export class RunCodeRunManager {
  private readonly runs = new Set<ActiveRun>();
  private stale = false;

  register(controller: AbortController): () => void {
    if (this.stale) throw new RunCodeError("PLUGIN_GENERATION_STALE");
    let resolveFinished: (() => void) | undefined;
    const run: ActiveRun = {
      controller,
      finished: new Promise<void>((resolvePromise) => {
        resolveFinished = resolvePromise;
      }),
    };
    this.runs.add(run);
    return () => {
      this.runs.delete(run);
      resolveFinished?.();
    };
  }

  async dispose(): Promise<void> {
    this.stale = true;
    const runs = [...this.runs];
    for (const run of runs) run.controller.abort("PLUGIN_GENERATION_STALE");
    await Promise.allSettled(runs.map((run) => run.finished));
    this.runs.clear();
  }
}

interface WorkerCallMessage {
  type: "call";
  runId: string;
  id: number;
  pluginId: string;
  method: string;
  args: unknown;
}

interface WorkerTerminalMessage {
  type: "done" | "failed";
  runId: string;
  value?: unknown;
  error?: { code: string; message: string; pluginId?: string; method?: string };
}

interface WorkerLogMessage {
  type: "log";
  runId: string;
  level: string;
  text: string;
}

type WorkerMessage =
  | WorkerCallMessage
  | WorkerTerminalMessage
  | WorkerLogMessage
  | { type: "heartbeat"; runId: string; busyMs?: number }
  | { type: "cleanup-complete"; runId: string }
  | { type: "child-start" | "child-end"; runId: string; pid: number };

/** 在独立 worker 中执行模型生成的程序，并把插件调用回送到 Desktop dispatcher。 */
export async function executePluginProgram(
  code: string,
  dispatcher: PluginMethodDispatcher,
  toolCallId: string,
  signal: AbortSignal | undefined,
  _cwd: string,
  limits: RunCodeLimits = DEFAULT_RUN_CODE_LIMITS,
  details: RunCodeExecution = { calls: [], logs: [], attachments: [] },
  manager?: RunCodeRunManager,
  onUpdate?: () => void,
): Promise<JsonValue | undefined> {
  if (Buffer.byteLength(code, "utf8") > limits.maxCodeBytes) {
    throw new RunCodeError("PLUGIN_OUTPUT_LIMIT_EXCEEDED", "Plugin code exceeds the byte limit");
  }
  if (signal?.aborted) throw new RunCodeError("PLUGIN_CALL_ABORTED");
  let stripped: string;
  try {
    stripped = stripPluginBody(code);
  } catch (error) {
    throw new RunCodeError("PLUGIN_CODE_SYNTAX_ERROR", error instanceof Error ? error.message : String(error));
  }
  const runId = randomUUID();
  const root = new AbortController();
  details.active = true;
  const abortFromPi = () => root.abort("PLUGIN_CALL_ABORTED");
  signal?.addEventListener("abort", abortFromPi, { once: true });
  let worker: Worker;
  try {
    worker = new Worker(workerSource(runId, stripped, dispatcher.pluginMethods(), limits), {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb },
    });
  } catch (error) {
    signal?.removeEventListener("abort", abortFromPi);
    throw new RunCodeError("PLUGIN_CODE_EXCEPTION", error instanceof Error ? error.message : String(error));
  }
  let unregister: (() => void) | undefined;
  try {
    unregister = manager?.register(root);
  } catch (error) {
    signal?.removeEventListener("abort", abortFromPi);
    await worker.terminate();
    throw error;
  }

  return new Promise<JsonValue | undefined>((resolve, reject) => {
    let settled = false;
    let activeCalls = 0;
    let lastHeartbeat = Date.now();
    let logBytes = 0;
    let nextCallId = 1;
    const childPids = new Set<number>();
    const inFlightCalls = new Set<Promise<void>>();
    let resolveCleanup: (() => void) | undefined;

    const cleanupComplete = new Promise<void>((resolvePromise) => {
      resolveCleanup = resolvePromise;
    });
    const queued: WorkerCallMessage[] = [];

    const finish = async (error?: RunCodeError, value?: JsonValue): Promise<void> => {
      if (settled) return;
      settled = true;
      if (!root.signal.aborted) root.abort(error?.code ?? "PLUGIN_CALL_ABORTED");
      details.active = false;
      clearTimeout(wallTimer);
      clearInterval(computeTimer);
      signal?.removeEventListener("abort", abortFromPi);
      root.signal.removeEventListener("abort", abortRun);
      queued.length = 0;
      try {
        worker.postMessage({
          type: "abort",
          runId,
          error: serializeError(error ?? new RunCodeError("PLUGIN_CALL_ABORTED")),
        });
      } catch {
        // Worker may already have exited.
      }
      await Promise.race([
        cleanupComplete,
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, CLEANUP_GRACE_MS)),
      ]);
      await worker.terminate();
      await Promise.race([
        Promise.allSettled(inFlightCalls),
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, CLEANUP_GRACE_MS)),
      ]);
      await terminateDescendants(childPids);
      unregister?.();
      onUpdate?.();
      if (error) reject(error);
      else resolve(value);
    };

    const abortRun = () => {
      const reason = root.signal.reason;
      const code: RunCodeErrorCode =
        typeof reason === "string" && isRunCodeErrorCode(reason) ? reason : "PLUGIN_CALL_ABORTED";
      void finish(new RunCodeError(code));
    };
    root.signal.addEventListener("abort", abortRun, { once: true });

    const wallTimer = setTimeout(() => root.abort("PLUGIN_CALL_TIMEOUT"), limits.timeoutMs);
    const computeTimer = setInterval(
      () => {
        if (activeCalls === 0 && Date.now() - lastHeartbeat > limits.computeTimeoutMs) {
          root.abort("PLUGIN_CALL_TIMEOUT");
        }
      },
      Math.min(250, Math.max(25, Math.floor(limits.computeTimeoutMs / 4))),
    );

    const pump = () => {
      while (!settled && activeCalls < limits.maxConcurrentCalls) {
        const message = queued.shift();
        if (!message) return;
        activeCalls += 1;
        const pending = dispatcher
          .call(message.pluginId, message.method, message.args, root.signal, toolCallId, details, limits, onUpdate)
          .then(
            (value) => post({ type: "resolve", runId, id: message.id, value }),
            (error: unknown) =>
              post({
                type: "reject",
                runId,
                id: message.id,
                error: serializeError(normalizePluginError(error, "PLUGIN_METHOD_EXECUTION_FAILED")),
              }),
          )
          .finally(() => {
            inFlightCalls.delete(pending);
            activeCalls -= 1;
            pump();
          });
        inFlightCalls.add(pending);
      }
    };

    const post = (message: object) => {
      if (!settled) worker.postMessage(message);
    };

    worker.on("message", (raw: unknown) => {
      if (!isWorkerMessage(raw) || raw.runId !== runId) return;
      if (raw.type === "cleanup-complete") {
        resolveCleanup?.();
        return;
      }
      if (raw.type === "child-start" || raw.type === "child-end") {
        if (raw.type === "child-start") childPids.add(raw.pid);
        else childPids.delete(raw.pid);
        return;
      }
      if (settled) return;
      if (raw.type === "heartbeat") {
        lastHeartbeat = Date.now();
        if ((raw.busyMs ?? 0) > limits.computeTimeoutMs) root.abort("PLUGIN_CALL_TIMEOUT");
        return;
      }
      if (raw.type === "log") {
        const bytes = Buffer.byteLength(raw.text, "utf8");
        if (logBytes + bytes <= limits.maxLogBytes) {
          logBytes += bytes;
          details.logs.push({ sequence: details.logs.length + 1, level: raw.level, text: raw.text });
          onUpdate?.();
        }
        return;
      }
      if (raw.type === "call") {
        if (raw.id !== nextCallId || raw.id > limits.maxCalls) {
          root.abort("PLUGIN_CALL_LIMIT_EXCEEDED");
        } else {
          nextCallId += 1;
          queued.push(raw);
          pump();
        }
        return;
      }
      if (raw.type === "failed") {
        const wire = raw.error;
        const code = isRunCodeErrorCode(wire?.code) ? wire.code : "PLUGIN_CODE_EXCEPTION";
        void finish(new RunCodeError(code, wire?.message ?? code, wire?.pluginId, wire?.method));
        return;
      }
      if (raw.type !== "done") return;
      try {
        const value = raw.value === undefined ? undefined : snapshotJson(raw.value, limits.maxOuterOutputBytes);
        void finish(undefined, value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void finish(
          new RunCodeError(
            message.includes("PLUGIN_INVALID_JSON") || message.includes("PLUGIN_JSON_DEPTH_EXCEEDED")
              ? "PLUGIN_CODE_INVALID_OUTPUT"
              : "PLUGIN_OUTPUT_LIMIT_EXCEEDED",
            message,
          ),
        );
      }
    });
    worker.on("error", (error) => {
      const code: RunCodeErrorCode =
        error instanceof SyntaxError ? "PLUGIN_CODE_SYNTAX_ERROR" : "PLUGIN_CODE_EXCEPTION";
      root.abort(code);
      void finish(new RunCodeError(code, error.message));
    });
    worker.on("exit", () => {
      if (!settled) void finish(new RunCodeError("PLUGIN_CODE_WORKER_EXIT"));
    });
  });
}

function stripPluginBody(code: string): string {
  const prefix = "async function __desktopRunCode__() {\n";
  const suffix = "\n}";
  const stripped = stripTypeScriptTypes(`${prefix}${code}${suffix}`, { mode: "strip", sourceMap: false });
  if (!stripped.startsWith(prefix) || !stripped.endsWith(suffix))
    throw new SyntaxError("Plugin code wrapper is invalid");
  return stripped.slice(prefix.length, -suffix.length);
}

function workerSource(runId: string, code: string, methods: Record<string, string[]>, limits: RunCodeLimits): string {
  return `
    const { parentPort } = require("node:worker_threads");
    const { performance } = require("node:perf_hooks");
    const { syncBuiltinESMExports } = require("node:module");
    const childProcess = require("node:child_process");
    const workerThreads = require("node:worker_threads");
    const cluster = require("node:cluster");
    const runId = ${JSON.stringify(runId)};
    const methods = ${JSON.stringify(methods)};
    const calls = new Map();
    const trackedChildren = new Map();
    let nextId = 0;
    const send = (message) => parentPort.postMessage({ ...message, runId });
    const rejectsDetached = (values) => values.some((value) => value && typeof value === "object" && value.detached === true);
    const trackChild = (child) => {
      if (Number.isSafeInteger(child?.pid)) {
        trackedChildren.set(child.pid, child);
        send({ type: "child-start", pid: child.pid });
        child.once("close", () => {
          trackedChildren.delete(child.pid);
          send({ type: "child-end", pid: child.pid });
        });
      }
      return child;
    };
    const cleanupChildren = async () => {
      const children = [...trackedChildren.values()];
      for (const child of children) {
        try { child.kill("SIGTERM"); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }
    };
    for (const name of ["spawn", "exec", "execFile", "fork"]) {
      const original = childProcess[name].bind(childProcess);
      childProcess[name] = (...args) => {
        if (rejectsDetached(args)) throw Object.assign(new Error("Detached subprocesses are not supported"), { code: "PLUGIN_CODE_EXCEPTION" });
        return trackChild(original(...args));
      };
    }
    for (const name of ["spawnSync", "execSync", "execFileSync"]) {
      const original = childProcess[name].bind(childProcess);
      childProcess[name] = (...args) => {
        if (rejectsDetached(args)) throw Object.assign(new Error("Detached subprocesses are not supported"), { code: "PLUGIN_CODE_EXCEPTION" });
        return original(...args);
      };
    }
    try {
      workerThreads.Worker = class DisabledNestedWorker { constructor() { throw Object.assign(new Error("Nested workers are not supported"), { code: "PLUGIN_CODE_EXCEPTION" }); } };
    } catch {}
    try {
      cluster.fork = () => { throw Object.assign(new Error("Cluster workers are not supported"), { code: "PLUGIN_CODE_EXCEPTION" }); };
    } catch {}
    syncBuiltinESMExports();
    const fail = (error, fallback = "PLUGIN_CODE_EXCEPTION") => ({
      code: typeof error?.code === "string" ? error.code : fallback,
      message: error instanceof Error ? error.message : String(error),
      ...(typeof error?.pluginId === "string" ? { pluginId: error.pluginId } : {}),
      ...(typeof error?.method === "string" ? { method: error.method } : {}),
    });
    const invoke = (pluginId, method, args) => {
      const id = ++nextId;
      if (id > ${limits.maxCalls}) return Promise.reject(Object.assign(new Error("PLUGIN_CALL_LIMIT_EXCEEDED"), { code: "PLUGIN_CALL_LIMIT_EXCEEDED" }));
      send({ type: "call", id, pluginId, method, args: args === undefined ? {} : args });
      return new Promise((resolve, reject) => calls.set(id, { resolve, reject }));
    };
    const namespace = (parts) => new Proxy(Object.create(null), {
      get(_target, property) {
        if (typeof property !== "string" || ["then", "constructor", "prototype", "__proto__"].includes(property)) return undefined;
        const joined = [...parts, property].join(".");
        if (methods[parts.join(".")]?.includes(property)) return (args) => invoke(parts.join("."), property, args);
        if (methods[joined]) return namespace([joined]);
        if (Object.keys(methods).some((id) => id.startsWith(joined + "."))) return namespace([...parts, property]);
        if (methods[parts.join(".")]) return (args) => invoke(parts.join("."), property, args);
        return namespace([...parts, property]);
      }
    });
    const plugin = new Proxy(Object.create(null), {
      get(_target, property) {
        if (typeof property !== "string" || ["then", "constructor", "prototype", "__proto__"].includes(property)) return undefined;
        if (methods[property]) return namespace([property]);
        return namespace([property]);
      }
    });
    const stringify = (value) => { try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); } };
    globalThis.console = Object.freeze(Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (...values) => send({ type: "log", level, text: values.map(stringify).join(" ") })])));
    parentPort.on("message", (message) => {
      if (!message || message.runId !== runId) return;
      if (message.type === "resolve" || message.type === "reject") {
        const pending = calls.get(message.id);
        if (!pending) return;
        calls.delete(message.id);
        if (message.type === "resolve") pending.resolve(message.value);
        else pending.reject(Object.assign(new Error(message.error?.message ?? "Plugin method failed"), message.error));
      }
      if (message.type === "abort") {
        for (const pending of calls.values()) pending.reject(Object.assign(new Error(message.error?.message), message.error));
        void cleanupChildren().finally(() => send({ type: "cleanup-complete" }));
      }
    });
    let utilization = performance.eventLoopUtilization();
    let busyMs = 0;
    const heartbeat = setInterval(() => {
      const next = performance.eventLoopUtilization(utilization);
      utilization = performance.eventLoopUtilization();
      busyMs += next.active;
      send({ type: "heartbeat", busyMs });
    }, 100);
    (async () => {
      try {
        const value = await (async function() { "use strict"; ${code}\n }).call(undefined);
        clearInterval(heartbeat);
        send({ type: "done", value });
      } catch (error) {
        clearInterval(heartbeat);
        send({ type: "failed", error: fail(error) });
      }
    })();
  `;
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.runId !== "string") return false;
  if (record.type === "heartbeat") return record.busyMs === undefined || typeof record.busyMs === "number";
  if (record.type === "cleanup-complete") return true;
  if (record.type === "child-start" || record.type === "child-end") {
    return Number.isSafeInteger(record.pid) && Number(record.pid) > 0;
  }
  if (record.type === "log") return typeof record.level === "string" && typeof record.text === "string";
  if (record.type === "call") {
    return Number.isSafeInteger(record.id) && typeof record.pluginId === "string" && typeof record.method === "string";
  }
  if (record.type === "done") return true;
  return record.type === "failed" && !!record.error && typeof record.error === "object";
}

function serializeError(error: RunCodeError): { code: string; message: string; pluginId?: string; method?: string } {
  return {
    code: error.code,
    message: error.message,
    ...(error.pluginId ? { pluginId: error.pluginId } : {}),
    ...(error.method ? { method: error.method } : {}),
  };
}

async function terminateDescendants(pids: ReadonlySet<number>): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
  if (pids.size === 0) return;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process exited after SIGTERM.
    }
  }
}
