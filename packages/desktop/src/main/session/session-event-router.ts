import type { SessionPushPayload, Thread } from "../../shared/contracts.ts";
/** session supervisor 接收 worker 事件的最小接口。 */
export interface SessionEventReceiver {
  receive(payload: SessionPushPayload, workerInstanceId: string, sidecarSequence: number): void;
  workerFailed(projectId: string, threadId: string, error: Error): void;
  resyncRequired(projectId: string, threadId: string, reason: string): void;
}

/** session event router 的 renderer catalog 广播回调。 */
export interface SessionEventRouterOptions {
  publishCatalogChanged(thread: Thread): void;
}

/** 集中承接 worker/subagent 到 SessionSupervisor 的主进程事件路由。 */
/** 将 thread/subagent worker 事件路由到 supervisor，并转发 catalog 变化。 */
export class SessionEventRouter {
  private readonly options: SessionEventRouterOptions;
  private threadAcknowledger: ((workerInstanceId: string, sidecarSequence: number) => void) | undefined;
  private subagentAcknowledger: ((workerInstanceId: string, sidecarSequence: number) => void) | undefined;
  private supervisor: SessionEventReceiver | undefined;

  constructor(options: SessionEventRouterOptions) {
    this.options = options;
  }

  bindThreadAcknowledger(acknowledge: (workerInstanceId: string, sidecarSequence: number) => void): void {
    if (this.threadAcknowledger) throw new Error("Thread acknowledger is already bound");
    this.threadAcknowledger = acknowledge;
  }

  bindSubagentAcknowledger(acknowledge: (workerInstanceId: string, sidecarSequence: number) => void): void {
    if (this.subagentAcknowledger) throw new Error("Subagent acknowledger is already bound");
    this.subagentAcknowledger = acknowledge;
  }

  bindSupervisor(supervisor: SessionEventReceiver): void {
    if (this.supervisor) throw new Error("Session event router is already bound");
    this.supervisor = supervisor;
  }

  threadEvent(payload: SessionPushPayload, workerInstanceId: string, sidecarSequence: number): void {
    if (this.supervisor) {
      this.supervisor.receive(payload, workerInstanceId, sidecarSequence);
      return;
    }
    if (!this.threadAcknowledger) throw new Error("Thread acknowledger is not bound");
    this.threadAcknowledger(workerInstanceId, sidecarSequence);
  }

  subagentEvent(payload: SessionPushPayload, workerInstanceId: string, sidecarSequence: number): void {
    if (this.supervisor) {
      this.supervisor.receive(payload, workerInstanceId, sidecarSequence);
      return;
    }
    if (!this.subagentAcknowledger) throw new Error("Subagent acknowledger is not bound");
    this.subagentAcknowledger(workerInstanceId, sidecarSequence);
  }

  workerFailed(projectId: string, threadId: string, error: Error): void {
    this.supervisor?.workerFailed(projectId, threadId, error);
  }

  resyncRequired(projectId: string, threadId: string, reason: string): void {
    this.supervisor?.resyncRequired(projectId, threadId, reason);
  }

  catalogChanged(thread: Thread): void {
    this.options.publishCatalogChanged(thread);
  }
}
