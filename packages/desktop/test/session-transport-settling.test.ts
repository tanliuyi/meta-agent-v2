import { describe, expect, it, vi } from "vitest";
import { createSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";
import { SessionTransportManager } from "../src/renderer/src/runtime/session-transport-manager.ts";
import type { SessionAttachment, SessionControlState } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

const EMPTY_CONTROL: SessionControlState = {
  protocolVersion: PROTOCOL_VERSION,
  revision: 1,
  projectId: "p",
  threadId: "t",
  title: "Test",
  updatedAt: 1,
  cwd: "/tmp",
  running: false,
  queueModes: { steering: "all", followUp: "all" },
  models: [],
  commands: [],
  thinkingLevel: "off",
  thinkingLevels: ["off"],
  readiness: { state: "ready" },
  hostRequests: [],
  extensionSet: { generation: "g", diagnostics: [], reloadRequired: false },
  extensionHost: {
    statuses: {},
    widgets: [],
  },
};

function attachmentFor(record: ReturnType<typeof createSessionRecord>, attachmentId: string): SessionAttachment {
  return {
    protocolVersion: PROTOCOL_VERSION,
    attachmentId,
    bootstrap: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: record.identity.projectId,
      threadId: record.identity.threadId,
      timeline: record.stores.timeline.getSnapshot(),
      control: EMPTY_CONTROL,
    },
  };
}

interface WindowStub {
  desktop: {
    sessions: { attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> };
    workbench: { get: ReturnType<typeof vi.fn> };
  };
}

function stubWindow(attach: ReturnType<typeof vi.fn>): WindowStub["desktop"] {
  const desktop = {
    sessions: { attach, detach: vi.fn(), flush: vi.fn(() => ({ state: "flushed" as const })) },
    workbench: {
      get: vi.fn().mockResolvedValue({
        projectId: "p",
        threadId: "t",
        panelOpen: false,
        panelWidth: 420,
        terminalOpen: false,
        terminalHeight: 240,
        openFiles: [],
        expandedPaths: [],
      }),
    },
  };
  vi.stubGlobal("window", { desktop } as unknown as Window & typeof globalThis);
  return desktop;
}

describe("SessionTransportManager attach settling", () => {
  it("被 detach 中断的 in-flight attach 收尾前不会发起新 attach", async () => {
    let resolveFirst!: (attachment: SessionAttachment) => void;
    const first = new Promise<SessionAttachment>((done) => {
      resolveFirst = done;
    });
    const attach = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(attachmentFor(createSessionRecord({ projectId: "p", threadId: "t" }), "attachment-2"));
    const desktop = stubWindow(attach);
    const manager = new SessionTransportManager();
    const record = createSessionRecord({ projectId: "p", threadId: "t" });

    const firstEnsure = manager.ensure(record);
    expect(attach).toHaveBeenCalledTimes(1);

    // attach #1 尚未完成时 detach：主进程可能已建 subscription，需等其 abort 清理完成。
    const detach = manager.detach(record.key);
    const reensure = manager.ensure(record);
    await Promise.resolve();
    expect(attach).toHaveBeenCalledTimes(1);

    // 放行 attach #1：renderer 检测到已 tombstone，abort 并发出主进程 detach。
    resolveFirst(attachmentFor(record, "attachment-1"));
    await expect(firstEnsure).rejects.toThrow();
    await detach;
    expect(desktop.sessions.detach).toHaveBeenCalledWith("attachment-1");

    // 收尾完成后才发起 attach #2 并成功完成。
    const attached = await reensure;
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attached.attachmentId).toBe("attachment-2");
    vi.unstubAllGlobals();
  });

  it("detach 后重新 attach 正常完成", async () => {
    const record = createSessionRecord({ projectId: "p", threadId: "t" });
    const attach = vi.fn().mockResolvedValue(attachmentFor(record, "attachment-2"));
    stubWindow(attach);
    const manager = new SessionTransportManager();
    const attached = await manager.ensure(record);
    expect(attached.attachmentId).toBe("attachment-2");
    vi.unstubAllGlobals();
  });

  it("detach -> 排队 ensure -> retire -> 收尾：retire 使排队中的 ensure 失效，不重建 attachment", async () => {
    let resolveFirst!: (attachment: SessionAttachment) => void;
    const first = new Promise<SessionAttachment>((done) => {
      resolveFirst = done;
    });
    const attach = vi.fn().mockReturnValueOnce(first);
    const desktop = stubWindow(attach);
    const manager = new SessionTransportManager();
    const record = createSessionRecord({ projectId: "p", threadId: "t" });

    const firstEnsure = manager.ensure(record);
    expect(attach).toHaveBeenCalledTimes(1);

    // attach #1 尚未完成时 detach：后续 ensure 在收尾上排队。
    const detach = manager.detach(record.key);
    const queuedEnsure = manager.ensure(record);
    await Promise.resolve();
    expect(attach).toHaveBeenCalledTimes(1);

    // detach 已移除 keyState：retire 必须使排队中的 ensure 失效，防止为已 retire 的 record 重建 attachment。
    const retire = manager.retire(record.key);
    resolveFirst(attachmentFor(record, "attachment-1"));
    await expect(firstEnsure).rejects.toThrow();
    await detach;
    await retire;

    await expect(queuedEnsure).rejects.toThrow(/is retired$/);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(desktop.sessions.detach).toHaveBeenCalledWith("attachment-1");
    vi.unstubAllGlobals();
  });

  it("retire 直接中断 in-flight attach 时同样使排队中的 ensure 失效", async () => {
    let resolveFirst!: (attachment: SessionAttachment) => void;
    const first = new Promise<SessionAttachment>((done) => {
      resolveFirst = done;
    });
    const attach = vi.fn().mockReturnValueOnce(first);
    const desktop = stubWindow(attach);
    const manager = new SessionTransportManager();
    const record = createSessionRecord({ projectId: "p", threadId: "t" });

    const firstEnsure = manager.ensure(record);
    expect(attach).toHaveBeenCalledTimes(1);

    const retire = manager.retire(record.key);
    const queuedEnsure = manager.ensure(record);
    resolveFirst(attachmentFor(record, "attachment-1"));
    await expect(firstEnsure).rejects.toThrow();
    await retire;

    await expect(queuedEnsure).rejects.toThrow(/is retired$/);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(desktop.sessions.detach).toHaveBeenCalledWith("attachment-1");
    vi.unstubAllGlobals();
  });

  it("recover 无 committed 租约时走 ensure，有 committed 时以 resync 替换租约", async () => {
    const record = createSessionRecord({ projectId: "p", threadId: "t" });
    const attach = vi
      .fn()
      .mockResolvedValueOnce(attachmentFor(record, "attachment-1"))
      .mockResolvedValueOnce(attachmentFor(record, "attachment-2"));
    stubWindow(attach);
    const manager = new SessionTransportManager();

    const attached = await manager.recover(record);
    expect(attached.attachmentId).toBe("attachment-1");
    expect(attach).toHaveBeenCalledTimes(1);

    const recovered = await manager.recover(record);
    expect(recovered.attachmentId).toBe("attachment-2");
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach.mock.calls[1]?.[0]).toMatchObject({ replaceAttachmentId: "attachment-1" });
    vi.unstubAllGlobals();
  });

  it("detach -> 排队 ensure -> detachAll -> 收尾：detachAll 使排队中的 ensure 失效，不重建 attachment", async () => {
    let resolveFirst!: (attachment: SessionAttachment) => void;
    const first = new Promise<SessionAttachment>((done) => {
      resolveFirst = done;
    });
    const attach = vi.fn().mockReturnValueOnce(first);
    const desktop = stubWindow(attach);
    const manager = new SessionTransportManager();
    const record = createSessionRecord({ projectId: "p", threadId: "t" });

    const firstEnsure = manager.ensure(record);
    expect(attach).toHaveBeenCalledTimes(1);

    // attach #1 尚未完成时 detach：后续 ensure 在收尾上排队。
    const detach = manager.detach(record.key);
    const queuedEnsure = manager.ensure(record);
    await Promise.resolve();
    expect(attach).toHaveBeenCalledTimes(1);

    // detachAll 必须覆盖 detach 留下的收尾 entry（与 retireProject 一致），
    // 否则窗口卸载后排队中的 ensure 会在收尾完成后重建 attachment。
    const detachAll = manager.detachAll();
    resolveFirst(attachmentFor(record, "attachment-1"));
    await expect(firstEnsure).rejects.toThrow();
    await detach;
    await detachAll;

    await expect(queuedEnsure).rejects.toThrow(/is retired$/);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(desktop.sessions.detach).toHaveBeenCalledWith("attachment-1");
    vi.unstubAllGlobals();
  });

  it("detachAll 释放所有已提交租约并清空 keyStates", async () => {
    const first = createSessionRecord({ projectId: "p", threadId: "t" });
    const second = createSessionRecord({ projectId: "p", threadId: "t2" });
    const attach = vi
      .fn()
      .mockResolvedValueOnce(attachmentFor(first, "attachment-1"))
      .mockResolvedValueOnce(attachmentFor(second, "attachment-2"));
    const desktop = stubWindow(attach);
    const manager = new SessionTransportManager();

    await manager.ensure(first);
    await manager.ensure(second);
    expect(attach).toHaveBeenCalledTimes(2);

    await manager.detachAll();

    expect(desktop.sessions.detach).toHaveBeenCalledWith("attachment-1");
    expect(desktop.sessions.detach).toHaveBeenCalledWith("attachment-2");
    expect(manager.hasCommittedLease(first)).toBe(false);
    expect(manager.hasCommittedLease(second)).toBe(false);
    expect(manager.getConnectionState(first.key)).toBeNull();
    expect(manager.getConnectionState(second.key)).toBeNull();
    vi.unstubAllGlobals();
  });
});
