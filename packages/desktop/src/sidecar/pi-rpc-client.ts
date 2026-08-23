import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcResponse, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PiRpcEvent } from "../shared/contracts.ts";
import type { ProbedSystemPi } from "./system-pi-resolver.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const MAX_JSONL_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_STDIN_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

export type PiRpcCommand = RpcCommand;
export type PiRpcResponse = RpcResponse;
type PiRpcSuccessResponse<Command extends PiRpcCommand["type"]> = Extract<
  PiRpcResponse,
  { command: Command; success: true }
>;

export interface PiRpcHandshake {
  state: Record<string, unknown>;
  entries: { entries: SessionEntry[]; leafId: string | null };
  commands: unknown[];
  models: unknown[];
}

export interface PiRpcClientOptions {
  pi: ProbedSystemPi;
  cwd: string;
  piArgs?: string[];
  environment: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  onEvent?(event: PiRpcEvent): void;
  onStderr?(text: string): void;
}

interface PendingRequest {
  command: string;
  resolve(response: PiRpcResponse): void;
  reject(error: Error): void;
  timeout?: NodeJS.Timeout;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function responseData(response: PiRpcResponse): Record<string, unknown> {
  if (!("data" in response)) throw new Error(`${response.command} response is missing data`);
  return asRecord(response.data, `${response.command} response data`);
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function appendStderr(current: string, text: string): string {
  const combined = current + text;
  const bytes = Buffer.byteLength(combined);
  if (bytes <= MAX_STDERR_BYTES) return combined;
  const buffer = Buffer.from(combined);
  return buffer.subarray(buffer.byteLength - MAX_STDERR_BYTES).toString("utf8");
}

export class PiRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();
  private readonly expiredRequestIds = new Set<string>();
  private readonly onEvent?: (event: PiRpcEvent) => void;
  private readonly onStderr?: (text: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly piVersion: string;
  private lineBuffer = "";
  private pendingStdinBytes = 0;
  private writeTail = Promise.resolve();
  private stderrTail = "";
  private terminalError: Error | undefined;
  private closing = false;

  private constructor(child: ChildProcessWithoutNullStreams, options: PiRpcClientOptions) {
    this.child = child;
    this.onEvent = options.onEvent;
    this.onStderr = options.onStderr;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.piVersion = options.pi.version;

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stdin.on("error", (error) => {
      if (!this.closing) this.fail(new Error(`System Pi stdin error: ${error.message}`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = appendStderr(this.stderrTail, text);
      this.onStderr?.(text);
    });
    child.on("error", (error) => this.fail(new Error(`System Pi process error: ${error.message}`)));
    child.on("close", (code, signal) => {
      const remainder = this.lineBuffer + this.decoder.end();
      if (remainder.length > 0 && !this.terminalError) {
        this.fail(new Error("System Pi stdout ended with an incomplete JSONL frame"));
      }
      if (!this.terminalError && !this.closing) {
        this.fail(
          new Error(
            `System Pi exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""}`,
          ),
        );
      }
      this.rejectPending(this.terminalError ?? new Error("System Pi RPC client closed"));
    });
  }

  static async launch(options: PiRpcClientOptions): Promise<{ client: PiRpcClient; handshake: PiRpcHandshake }> {
    const child = spawn(options.pi.command, [...options.pi.argsPrefix, "--mode", "rpc", ...(options.piArgs ?? [])], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const client = new PiRpcClient(child, options);
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    try {
      const handshake = await withTimeout(
        client.handshake(),
        startupTimeoutMs,
        `System Pi RPC handshake timed out after ${startupTimeoutMs}ms`,
      );
      return { client, handshake };
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get version(): string {
    return this.piVersion;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  async request<const Command extends PiRpcCommand>(
    command: Command,
    timeoutMs: number | null = this.requestTimeoutMs,
  ): Promise<PiRpcSuccessResponse<Command["type"]>> {
    if (this.terminalError) throw this.terminalError;
    if (this.closing) throw new Error("System Pi RPC client is closing");
    const id = randomUUID();
    const responsePromise = new Promise<PiRpcResponse>((resolve, reject) => {
      const pending: PendingRequest = { command: command.type, resolve, reject };
      if (timeoutMs !== null) {
        pending.timeout = setTimeout(() => {
          this.pending.delete(id);
          this.rememberExpiredRequest(id);
          reject(new Error(`System Pi RPC request '${command.type}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.timeout.unref();
      }
      this.pending.set(id, pending);
    });
    void responsePromise.catch(() => undefined);

    try {
      await Promise.race([this.write({ ...command, id }), responsePromise.then(() => undefined)]);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
    return responsePromise as Promise<PiRpcSuccessResponse<Command["type"]>>;
  }

  async send(message: Record<string, unknown>): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    if (this.closing) throw new Error("System Pi RPC client is closing");
    await this.write(message);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.rejectPending(new Error("System Pi RPC client closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    const writeDrainTimeoutMs = 2_000;
    const writesDrained = await Promise.race([
      this.writeTail.then(
        () => true,
        () => true,
      ),
      delay(writeDrainTimeoutMs).then(() => false),
    ]);
    if (!writesDrained) {
      this.killProcessTree();
      await Promise.race([exited, delay(2_000)]);
      return;
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 2_000);
        timeout.unref();
      }),
    ]);
    if (graceful) return;

    this.killProcessTree();
    await Promise.race([exited, delay(2_000)]);
  }

  private async handshake(): Promise<PiRpcHandshake> {
    const [stateResponse, entriesResponse, commandsResponse, modelsResponse] = await Promise.all([
      this.request({ type: "get_state" }),
      this.request({ type: "get_entries" }),
      this.request({ type: "get_commands" }),
      this.request({ type: "get_available_models" }),
    ]);
    const state = responseData(stateResponse);
    if (typeof state.sessionId !== "string" || typeof state.isStreaming !== "boolean") {
      throw new Error("get_state response is missing required session fields");
    }

    const entriesData = responseData(entriesResponse);
    const entries = assertArray(entriesData.entries, "get_entries.data.entries") as SessionEntry[];
    const leafId = entriesData.leafId;
    if (leafId !== null && typeof leafId !== "string") {
      throw new Error("get_entries.data.leafId must be a string or null");
    }

    const commands = assertArray(responseData(commandsResponse).commands, "get_commands.data.commands");
    const models = assertArray(responseData(modelsResponse).models, "get_available_models.data.models");
    return { state, entries: { entries, leafId }, commands, models };
  }

  private write(value: Record<string, unknown>): Promise<void> {
    let serialized: string;
    try {
      serialized = `${JSON.stringify(value)}\n`;
    } catch (error) {
      return Promise.reject(
        new Error(`Unable to serialize Pi RPC message: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_JSONL_FRAME_BYTES) {
      return Promise.reject(new Error(`Pi RPC stdin frame exceeds ${MAX_JSONL_FRAME_BYTES} bytes`));
    }
    if (this.pendingStdinBytes + bytes > MAX_PENDING_STDIN_BYTES) {
      return Promise.reject(new Error(`Pi RPC stdin queue exceeds ${MAX_PENDING_STDIN_BYTES} bytes`));
    }
    this.pendingStdinBytes += bytes;

    const operation = this.writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.child.stdin.write(serialized, "utf8", (error) => {
            this.pendingStdinBytes -= bytes;
            if (error) reject(new Error(`Unable to write Pi RPC message: ${error.message}`));
            else resolve();
          });
        }),
    );
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private handleStdout(chunk: Buffer): void {
    if (this.terminalError) return;
    this.lineBuffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.lineBuffer) > MAX_JSONL_FRAME_BYTES && !this.lineBuffer.includes("\n")) {
      this.fail(new Error(`System Pi JSONL frame exceeds ${MAX_JSONL_FRAME_BYTES} bytes`));
      this.killProcessTree();
      return;
    }

    let newline = this.lineBuffer.indexOf("\n");
    while (newline !== -1) {
      let line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) this.handleLine(line);
      if (this.terminalError) return;
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line) > MAX_JSONL_FRAME_BYTES) {
      this.fail(new Error(`System Pi JSONL frame exceeds ${MAX_JSONL_FRAME_BYTES} bytes`));
      this.killProcessTree();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.fail(
        new Error(`System Pi emitted invalid JSONL: ${error instanceof Error ? error.message : String(error)}`),
      );
      this.killProcessTree();
      return;
    }
    if (!isRecord(parsed)) {
      this.fail(new Error("System Pi emitted a non-object JSONL message"));
      this.killProcessTree();
      return;
    }
    const message = parsed;
    if (message.type !== "response") {
      try {
        this.onEvent?.(message as PiRpcEvent);
      } catch (error) {
        this.fail(
          new Error(`System Pi event handler failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        this.killProcessTree();
      }
      return;
    }
    if (typeof message.id !== "string" || typeof message.command !== "string" || typeof message.success !== "boolean") {
      this.fail(new Error("System Pi emitted a malformed RPC response"));
      this.killProcessTree();
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      if (this.expiredRequestIds.delete(message.id)) return;
      this.fail(new Error(`System Pi emitted an unknown or duplicate response id '${message.id}'`));
      this.killProcessTree();
      return;
    }
    if (pending.command !== message.command) {
      this.fail(
        new Error(`System Pi response command mismatch: expected '${pending.command}', received '${message.command}'`),
      );
      this.killProcessTree();
      return;
    }
    this.pending.delete(message.id);
    if (pending.timeout) clearTimeout(pending.timeout);

    const response = message as PiRpcResponse;
    if (!response.success) {
      pending.reject(new Error(response.error ?? `System Pi RPC command '${response.command}' failed`));
      return;
    }
    pending.resolve(response);
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.rejectPending(error);
  }

  private rememberExpiredRequest(id: string): void {
    this.expiredRequestIds.add(id);
    if (this.expiredRequestIds.size <= 1_024) return;
    const oldest = this.expiredRequestIds.values().next().value;
    if (oldest) this.expiredRequestIds.delete(oldest);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private killProcessTree(): void {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
      return;
    }
    this.child.kill("SIGKILL");
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
