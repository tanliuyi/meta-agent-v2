import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../src/shared/channels.ts";
import type { SessionAttachment, SessionBootstrap, SessionPush, SessionPushPayload } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";
import type { DesktopApi } from "../src/shared/desktop-api.ts";
import "../src/preload/index.ts";

const electron = vi.hoisted(() => ({
  exposed: undefined as DesktopApi | undefined,
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  invoke: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: DesktopApi) => {
      electron.exposed = api;
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    sendSync: electron.sendSync,
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      electron.listeners.set(channel, listener);
    },
    removeListener: electron.removeListener,
  },
}));

describe("preload session attachment leases", () => {
  it("buffers and flushes A/B independently", async () => {
    const api = requiredApi();
    electron.invoke.mockReset().mockResolvedValueOnce(attachment("a", "a")).mockResolvedValueOnce(attachment("b", "b"));
    electron.send.mockReset();
    const receivedA: SessionPushPayload[] = [];
    const receivedB: SessionPushPayload[] = [];
    const a = await api.sessions.attach(input("a", "request-a"), (update) => receivedA.push(update));
    const b = await api.sessions.attach(input("b", "request-b"), (update) => receivedB.push(update));

    push(controlPush(a.attachmentId, "a", 1));
    push(controlPush(b.attachmentId, "b", 1));
    expect(receivedA).toEqual([]);
    expect(receivedB).toEqual([]);

    expect(api.sessions.flush(a.attachmentId)).toEqual({ state: "flushed" });
    expect(receivedA).toHaveLength(1);
    expect(receivedB).toEqual([]);
    expect(api.sessions.flush(b.attachmentId)).toEqual({ state: "flushed" });
    expect(receivedB).toHaveLength(1);
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.sessionsAck, a.attachmentId, "worker-1", 1);
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.sessionsAck, b.attachmentId, "worker-1", 1);
  });

  it("detaches only the selected lease", async () => {
    const api = requiredApi();
    electron.invoke.mockReset().mockResolvedValueOnce(attachment("a", "a")).mockResolvedValueOnce(attachment("b", "b"));
    electron.send.mockReset();
    const receivedB: SessionPushPayload[] = [];
    const a = await api.sessions.attach(input("a", "request-a"), () => {});
    const b = await api.sessions.attach(input("b", "request-b"), (update) => receivedB.push(update));
    api.sessions.detach(a.attachmentId);
    push(controlPush(b.attachmentId, "b", 2));
    api.sessions.flush(b.attachmentId);
    expect(receivedB).toHaveLength(1);
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.sessionsDetach, a.attachmentId);
    expect(electron.send).not.toHaveBeenCalledWith(CHANNELS.sessionsDetach, b.attachmentId);
  });

  it("reports recovery only for the overflowing lease", async () => {
    const api = requiredApi();
    electron.invoke.mockReset().mockResolvedValueOnce(attachment("a", "a")).mockResolvedValueOnce(attachment("b", "b"));
    const a = await api.sessions.attach(input("a", "request-a"), () => {});
    const receivedB: SessionPushPayload[] = [];
    const b = await api.sessions.attach(input("b", "request-b"), (update) => receivedB.push(update));
    for (let sequence = 1; sequence <= 129; sequence += 1) push(controlPush(a.attachmentId, "a", sequence));
    push(controlPush(b.attachmentId, "b", 1));
    expect(api.sessions.flush(a.attachmentId)).toEqual({ state: "recovering", reason: "preload-buffer-overflow" });
    expect(api.sessions.flush(b.attachmentId)).toEqual({ state: "flushed" });
    expect(receivedB).toHaveLength(1);
  });

  it("replacement attach 会释放 preload 中的旧 listener", async () => {
    const api = requiredApi();
    electron.invoke
      .mockReset()
      .mockResolvedValueOnce(attachment("old", "thread"))
      .mockResolvedValueOnce(attachment("replacement", "thread"));
    const receivedOld: SessionPushPayload[] = [];
    const old = await api.sessions.attach(input("thread", "old-request"), (update) => receivedOld.push(update));
    api.sessions.flush(old.attachmentId);

    await api.sessions.attach(input("thread", "replacement-request", old.attachmentId), () => {});
    push(controlPush(old.attachmentId, "thread", 3));

    expect(receivedOld).toEqual([]);
  });
});

function requiredApi(): DesktopApi {
  if (!electron.exposed) throw new Error("DesktopApi was not exposed");
  return electron.exposed;
}

function input(threadId: string, requestId: string, replaceAttachmentId?: string) {
  return {
    projectId: "project",
    threadId,
    requestId,
    ...(replaceAttachmentId ? { replaceAttachmentId } : {}),
  };
}

function push(update: SessionPush): void {
  electron.listeners.get(CHANNELS.sessionsPush)?.({}, update);
}

function attachment(attachmentId: string, threadId: string): SessionAttachment {
  return { protocolVersion: PROTOCOL_VERSION, attachmentId, bootstrap: bootstrap(threadId) };
}

function controlPush(attachmentId: string, threadId: string, sequence: number): SessionPush {
  return {
    attachmentId,
    workerInstanceId: `worker-${sequence}`,
    sidecarSequence: sequence,
    type: "control",
    projectId: "project",
    threadId,
    control: { ...bootstrap(threadId).control, revision: sequence },
  };
}

function bootstrap(threadId: string): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId,
    timeline: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId,
      cursor: 0,
      headId: null,
      nodes: [],
      queue: [],
      phase: "idle",
    },
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: "project",
      threadId,
      title: threadId,
      updatedAt: 0,
      cwd: "/workspace",
      running: false,
      queueModes: { steering: "one-at-a-time", followUp: "one-at-a-time" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionUi: { statuses: {}, workingVisible: false, editorRevision: 0, toolsExpanded: false, widgets: [] },
    },
  };
}
