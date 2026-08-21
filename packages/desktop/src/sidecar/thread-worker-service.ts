import { createReadStream, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  SidecarBinding,
  SidecarCommand,
  ThreadSidecarCommand,
  ThreadWorkerBinding,
} from "../shared/sidecar-contracts.ts";
import { PiRpcSessionRuntime } from "./pi-rpc-session-runtime.ts";
import type { SidecarService, SidecarServiceContext } from "./sidecar-host.ts";

export class ThreadWorkerService implements SidecarService {
  private readonly runtime: PiRpcSessionRuntime;

  private constructor(runtime: PiRpcSessionRuntime) {
    this.runtime = runtime;
  }

  static async create(
    binding: SidecarBinding,
    context: SidecarServiceContext,
  ): Promise<{ service: ThreadWorkerService; readyResult: unknown }> {
    if (binding.role !== "thread") throw new Error(`Thread worker received ${binding.role} binding`);
    const input = binding.value;
    const runtimeBinding: ThreadWorkerBinding =
      input.mode === "open" ? { ...input, sessionFile: await resolveCanonicalSessionFile(input) } : input;
    const runtime = await PiRpcSessionRuntime.create({
      binding: runtimeBinding,
      push: (payload) => context.emit({ type: "session-push", payload }),
      onSummaryChanged: (current) => context.emit({ type: "summary-changed", summary: current.threadSummary(false) }),
    });
    if (input.mode === "create") {
      const sessionFile = runtime.sessionFile;
      if (!sessionFile) {
        await runtime.dispose();
        throw new Error("Created system Pi session did not materialize a session file");
      }
      context.emit({
        type: "session-materialized",
        projectId: input.projectId,
        sessionId: input.sessionId,
        sessionFile,
      });
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
      case "cancel":
        return this.runtime.cancel();
      case "compact":
        await this.runtime.compact();
        return null;
      case "setModel":
        await this.runtime.setModel(command.provider, command.modelId);
        return null;
      case "setThinking":
        await this.runtime.setThinking(command.level);
        return null;
      case "rename":
        await this.runtime.rename(command.title);
        return null;
      case "getImageResource":
        return this.runtime.readImageResource(command.resourceId);
      case "respondHostUi":
        await this.runtime.respond(command.response);
        return null;
      case "getSummary":
        return this.runtime.threadSummary(command.archived);
      case "ping":
        return { pong: true };
    }
  }
}

async function resolveCanonicalSessionFile(input: Extract<ThreadWorkerBinding, { mode: "open" }>): Promise<string> {
  return validateCanonicalSessionFile(input.sessionFile, input.projectId, input.threadId);
}

async function validateCanonicalSessionFile(sessionFile: string, projectId: string, threadId: string): Promise<string> {
  const requestedPath = resolve(sessionFile);
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
  if (!isSessionHeader(header) || header.id !== threadId) {
    throw new Error(`Session identity does not match ${projectId}/${threadId}: ${requestedPath}`);
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
