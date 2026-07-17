import {
  AbstractAgent,
  type BaseEvent,
  BaseEventSchema,
  EventType,
  type Message,
  MessageSchema,
  MessagesSnapshotEventSchema,
  type RunAgentInput,
  type RunAgentParameters,
} from "@ag-ui/client";
import { Observable, type Subscriber } from "rxjs";
import {
  CONSUMED_USER_MESSAGE_EVENT,
  type SessionBootstrap,
  type SessionEventBatch,
} from "../../../shared/contracts.ts";
import { sessionEventBus } from "./session-event-bus.ts";

/** 使用 Electron IPC 作为 AG-UI transport 的本地 agent。 */
export class ElectronPiAgent extends AbstractAgent {
  private readonly onSnapshot?: (messages: Message[]) => void;
  private readonly onConsumedUserMessage?: (message: Extract<Message, { role: "user" }>) => void;
  private projectId?: string;
  private activeRun?: SessionBootstrap["activeRun"];
  private lastSequence = 0;
  private current?: Subscriber<BaseEvent>;
  private paused = false;
  private pendingSnapshot?: Message[];

  constructor(
    onSnapshot?: (messages: Message[]) => void,
    onConsumedUserMessage?: (message: Extract<Message, { role: "user" }>) => void,
  ) {
    super({
      agentId: "pi-desktop",
      description: "Pi coding agent over Electron IPC",
      threadId: "detached",
      initialMessages: [],
      initialState: {},
    });
    this.onSnapshot = onSnapshot;
    this.onConsumedUserMessage = onConsumedUserMessage;
  }

  get attachedSession(): { projectId: string; threadId: string } | undefined {
    return this.projectId ? { projectId: this.projectId, threadId: this.threadId } : undefined;
  }

  async attach(bootstrap: SessionBootstrap): Promise<void> {
    await this.detachActiveRun();
    this.projectId = bootstrap.projectId;
    this.threadId = bootstrap.threadId;
    this.messages = bootstrap.messages;
    this.state = bootstrap.state;
    this.activeRun = bootstrap.activeRun;
    this.lastSequence = bootstrap.cursor;
    this.paused = false;
    this.pendingSnapshot = undefined;
  }

  async detach(): Promise<void> {
    await this.detachActiveRun();
    this.projectId = undefined;
    this.activeRun = undefined;
    this.paused = false;
    this.pendingSnapshot = undefined;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const projectId = this.projectId;
      if (!projectId) {
        subscriber.error(new Error("ElectronPiAgent 尚未 attach session"));
        return;
      }
      this.current = subscriber;
      this.paused = false;
      this.pendingSnapshot = undefined;
      const replay = this.activeRun;
      const runId = replay?.runId ?? input.runId;
      this.activeRun = undefined;
      for (const event of replay?.events ?? []) {
        if (!BaseEventSchema.safeParse(event).success) {
          this.requestResync(subscriber, () => {});
          return;
        }
        this.applyConsumedUserMessage(event);
        subscriber.next(event);
      }
      let release = () => {};
      release = sessionEventBus.subscribeEvents((batch) => {
        this.consume(batch, runId, subscriber, release);
      });
      window.desktop.sessions.flush();
      if (!replay) {
        void window.desktop.sessions
          .run({ projectId, threadId: this.threadId, input })
          .catch((error: unknown) => subscriber.error(error));
      }
      return () => {
        release();
        if (this.current === subscriber) this.current = undefined;
      };
    });
  }

  cancelActive(): void {
    if (!this.current || this.current.closed) return;
    this.current.error(new DOMException("Pi run cancelled", "AbortError"));
    this.current = undefined;
  }

  protected override prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
    const input = super.prepareRunAgentInput(parameters);
    return this.activeRun ? { ...input, runId: this.activeRun.runId } : input;
  }

  private consume(
    batch: SessionEventBatch,
    runId: string,
    subscriber: Subscriber<BaseEvent>,
    release: () => void,
  ): void {
    if (this.paused || batch.toSequence <= this.lastSequence) return;
    if (batch.fromSequence > this.lastSequence + 1) {
      this.requestResync(subscriber, release);
      return;
    }
    for (const envelope of batch.events) {
      if (envelope.sequence <= this.lastSequence) continue;
      if (envelope.sequence !== this.lastSequence + 1) {
        this.requestResync(subscriber, release);
        return;
      }
      this.lastSequence = envelope.sequence;
      if (envelope.runId && envelope.runId !== runId) continue;
      if (!BaseEventSchema.safeParse(envelope.event).success) {
        this.requestResync(subscriber, release);
        return;
      }
      if (envelope.event.type === EventType.MESSAGES_SNAPSHOT) {
        const snapshot = MessagesSnapshotEventSchema.safeParse(envelope.event);
        if (!snapshot.success) {
          this.requestResync(subscriber, release);
          return;
        }
        this.pendingSnapshot = snapshot.data.messages;
        continue;
      }
      if (envelope.event.type === EventType.RUN_ERROR) {
        subscriber.error(new Error("message" in envelope.event ? String(envelope.event.message) : "Pi run failed"));
        this.applyPendingSnapshot();
        return;
      }
      this.applyConsumedUserMessage(envelope.event);
      subscriber.next(envelope.event);
      if (envelope.event.type === EventType.RUN_FINISHED) {
        subscriber.complete();
        this.applyPendingSnapshot();
        return;
      }
    }
  }

  private applyConsumedUserMessage(event: BaseEvent): void {
    if (event.type !== EventType.CUSTOM || event.name !== CONSUMED_USER_MESSAGE_EVENT) return;
    const message = MessageSchema.safeParse(event.value);
    if (message.success && message.data.role === "user") this.onConsumedUserMessage?.(message.data);
  }

  private applyPendingSnapshot(): void {
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = undefined;
    if (!snapshot) return;
    this.messages = snapshot;
    this.onSnapshot?.(snapshot);
  }

  private requestResync(subscriber: Subscriber<BaseEvent>, release: () => void): void {
    if (this.paused) return;
    const projectId = this.projectId;
    if (!projectId) {
      subscriber.error(new DOMException("AG-UI session detached", "AbortError"));
      return;
    }
    this.paused = true;
    release();
    void sessionEventBus.resync(projectId, this.threadId).then(
      () => subscriber.error(new DOMException("AG-UI resync required", "AbortError")),
      () => subscriber.error(new DOMException("AG-UI resync failed", "AbortError")),
    );
  }
}
