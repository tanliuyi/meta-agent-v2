import type { SubagentRunEvent, SubagentRunRequest } from "../../../shared/subagent-contracts.ts";
import type {
  SubagentRuntime,
  SubagentRuntimeResumeRequest,
  SubagentRuntimeRunRequest,
} from "../extensions/pi-subagents/src/runtime/subagent-runtime.ts";

interface DesktopSubagentRuntimeOptions {
  projectId: string;
  parentThreadId: string;
  parentWorker?: Pick<SubagentRunRequest, "runId" | "rootRunId" | "childIndex" | "depth" | "maxDepth" | "lineage">;
  requestHost(
    request:
      | { type: "subagent.run"; request: SubagentRuntimeRunRequest & { projectId: string; parentThreadId: string } }
      | { type: "subagent.cancel"; projectId: string; parentThreadId: string; runId: string; childIndex: number }
      | {
          type: "subagent.steer";
          projectId: string;
          parentThreadId: string;
          runId: string;
          childIndex: number;
          message: string;
        },
    onEvent?: (event: SubagentRunEvent) => void,
  ): Promise<unknown>;
}

class SubagentEventStream implements AsyncIterable<SubagentRunEvent> {
  private readonly pending: SubagentRunEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<SubagentRunEvent>) => void> = [];
  private closed = false;

  push(event: SubagentRunEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.pending.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SubagentRunEvent> {
    return {
      next: () => {
        const event = this.pending.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Thread-side adapter for Main-owned programmatic subagent workers. */
export class DesktopSubagentRuntime implements SubagentRuntime {
  private readonly options: DesktopSubagentRuntimeOptions;
  private readonly active = new Map<string, number>();
  private disposePromise?: Promise<void>;
  private disposed = false;

  constructor(options: DesktopSubagentRuntimeOptions) {
    this.options = options;
  }

  run(request: SubagentRuntimeRunRequest): AsyncIterable<SubagentRunEvent> {
    if (this.disposed) throw new Error("Desktop subagent runtime is disposed");
    const authorizedRequest = this.authorizeRequest(request);
    const key = runKey(authorizedRequest.runId, authorizedRequest.childIndex);
    if (this.active.has(key)) throw new Error(`Subagent run already active: ${request.runId}/${request.childIndex}`);
    this.active.set(key, request.childIndex);
    const stream = new SubagentEventStream();
    let terminalEventSeen = false;
    void this.options
      .requestHost(
        {
          type: "subagent.run",
          request: {
            ...authorizedRequest,
            projectId: this.options.projectId,
            parentThreadId: this.options.parentThreadId,
          },
        },
        (event) => {
          terminalEventSeen ||= event.type === "completed" || event.type === "failed";
          stream.push(event);
        },
      )
      .catch((error: unknown) => {
        if (terminalEventSeen) return;
        stream.push({
          type: "failed",
          runId: authorizedRequest.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.active.delete(key);
        stream.close();
      });
    return stream;
  }

  private authorizeRequest(request: SubagentRuntimeRunRequest): SubagentRuntimeRunRequest {
    const parent = this.options.parentWorker;
    if (!parent) {
      if (
        request.depth !== 1 ||
        request.maxDepth < request.depth ||
        request.rootRunId !== request.runId ||
        request.lineage.length !== 0
      ) {
        throw new Error("Root subagent request has invalid lineage");
      }
      return request;
    }
    const depth = parent.depth + 1;
    const maxDepth = Math.min(parent.maxDepth, request.maxDepth);
    if (parent.depth >= parent.maxDepth || maxDepth < depth) {
      throw new Error(`Nested subagent call blocked (depth=${depth}, max=${maxDepth})`);
    }
    return {
      ...request,
      rootRunId: parent.rootRunId,
      depth,
      maxDepth,
      lineage: [...parent.lineage, { runId: parent.runId, childIndex: parent.childIndex }],
    };
  }

  resume(request: SubagentRuntimeResumeRequest): AsyncIterable<SubagentRunEvent> {
    return this.run(request);
  }

  async cancel(runId: string, childIndex: number): Promise<void> {
    await this.options.requestHost({
      type: "subagent.cancel",
      projectId: this.options.projectId,
      parentThreadId: this.options.parentThreadId,
      runId,
      childIndex,
    });
  }

  async steer(runId: string, childIndex: number, message: string): Promise<void> {
    await this.options.requestHost({
      type: "subagent.steer",
      projectId: this.options.projectId,
      parentThreadId: this.options.parentThreadId,
      runId,
      childIndex,
      message,
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = Promise.allSettled(
      [...this.active.entries()].map(([key, childIndex]) =>
        this.cancel(key.slice(0, key.lastIndexOf("\0")), childIndex),
      ),
    ).then(() => {
      this.active.clear();
    });
    return this.disposePromise;
  }
}

function runKey(runId: string, childIndex: number): string {
  return `${runId}\0${childIndex}`;
}
