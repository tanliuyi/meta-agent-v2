import { createReadStream, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validateResolvedExtensionSet } from "../main/pi/desktop-extension-runtime-policy.ts";
import { SessionRuntime } from "../main/pi/session-runtime.ts";
import { DesktopSubagentRuntime } from "../main/pi/subagents/desktop-subagent-runtime.ts";
import type {
  SidecarBinding,
  SidecarCommand,
  ThreadSidecarCommand,
  ThreadWorkerBinding,
} from "../shared/sidecar-contracts.ts";
import type { SidecarService, SidecarServiceContext } from "./sidecar-host.ts";

export class ThreadWorkerService implements SidecarService {
  private readonly runtime: SessionRuntime;

  private constructor(runtime: SessionRuntime) {
    this.runtime = runtime;
  }

  static async create(
    binding: SidecarBinding,
    context: SidecarServiceContext,
  ): Promise<{ service: ThreadWorkerService; readyResult: unknown }> {
    if (binding.role !== "thread") throw new Error(`Thread worker received ${binding.role} binding`);
    const input = binding.value;
    const extensionSet = await validateResolvedExtensionSet(input.projectId, input.extensionSet);
    const createSessionId = input.mode === "create" ? input.sessionId : undefined;
    let sessionManager: SessionManager | undefined;
    if (input.mode === "create") {
      sessionManager = SessionManager.create(input.cwd, undefined, { id: createSessionId });
    } else {
      const sessionFile = await resolveCanonicalSessionFile(input);
      sessionManager = SessionManager.open(sessionFile, undefined, input.cwd);
    }
    const parentThreadId = input.mode === "create" ? input.sessionId : input.threadId;
    const subagentRuntime = new DesktopSubagentRuntime({
      projectId: input.projectId,
      parentThreadId,
      requestHost: context.requestHost,
    });
    let runtime: SessionRuntime;
    try {
      runtime = await SessionRuntime.create({
        projectId: input.projectId,
        cwd: input.cwd,
        agentDir: input.agentDir,
        sessionManager,
        createInput: input.mode === "create" ? input.createInput : undefined,
        extensionSet,
        subagentRuntime,
        push: (payload) => context.emit({ type: "session-push", payload }),
        onSummaryChanged: (current) => context.emit({ type: "summary-changed", summary: current.threadSummary(false) }),
      });
    } catch (error) {
      await subagentRuntime.dispose();
      throw error;
    }
    if (input.mode === "create") {
      const sessionFile = sessionManager?.getSessionFile();
      if (!sessionFile) {
        await runtime.dispose();
        throw new Error("Created session did not materialize a session file");
      }
      context.emit({
        type: "session-materialized",
        projectId: input.projectId,
        sessionId: input.sessionId,
        sessionFile,
      });
    }
    if (input.mode === "open" && runtime.id !== input.threadId) {
      await runtime.dispose();
      throw new Error(`Opened session ID mismatch: expected ${input.threadId}, got ${runtime.id}`);
    }
    return {
      service: new ThreadWorkerService(runtime),
      readyResult: runtime.bootstrap(),
    };
  }

  async command(command: SidecarCommand): Promise<unknown> {
    return this.threadCommand(command as ThreadSidecarCommand);
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }

  private async threadCommand(command: ThreadSidecarCommand): Promise<unknown> {
    switch (command.type) {
      case "bootstrap":
        return this.runtime.bootstrap();
      case "prompt":
        return this.runtime.prompt(command.input);
      case "edit":
        return this.runtime.edit(command.input);
      case "reload":
        return this.runtime.reload(command.input);
      case "branch":
        return this.runtime.branch(command.input);
      case "cancel":
        await this.runtime.cancel();
        return null;
      case "clearQueue":
        return this.runtime.clearQueue();
      case "compact":
        await this.runtime.compact();
        return null;
      case "refreshModels":
        this.runtime.refreshModels();
        return null;
      case "setModel":
        await this.runtime.setModel(command.provider, command.modelId);
        return null;
      case "setThinking":
        this.runtime.setThinking(command.level);
        return null;
      case "rename":
        this.runtime.rename(command.title);
        return null;
      case "respondHostUi":
        this.runtime.respond(command.response);
        return null;
      case "getSummary":
        return this.runtime.threadSummary(command.archived);
      case "ping":
        return { pong: true };
    }
  }
}

async function resolveCanonicalSessionFile(input: Extract<ThreadWorkerBinding, { mode: "open" }>): Promise<string> {
  const requestedPath = resolve(input.sessionFile);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(requestedPath);
  } catch {
    throw new Error(`Session file does not exist before open: ${requestedPath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Session file is not a regular file before open: ${requestedPath}`);
  }
  const lines = createInterface({ input: createReadStream(requestedPath, { encoding: "utf8" }), crlfDelay: Infinity });
  let header: unknown;
  for await (const line of lines) {
    try {
      header = JSON.parse(line);
    } catch {
      header = null;
    }
    break;
  }
  lines.close();
  if (!isSessionHeader(header) || header.id !== input.threadId) {
    throw new Error(`Session identity does not match ${input.projectId}/${input.threadId}: ${requestedPath}`);
  }
  return requestedPath;
}

function isSessionHeader(value: unknown): value is { type: "session"; id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "session" &&
    "id" in value &&
    typeof value.id === "string"
  );
}

export function threadWorkerBinding(value: ThreadWorkerBinding): SidecarBinding {
  return { role: "thread", value };
}
