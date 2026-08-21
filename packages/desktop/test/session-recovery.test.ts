import { describe, expect, it, vi } from "vitest";
import { createSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";
import { createRecoveryLoop } from "../src/renderer/src/runtime/session-recovery.ts";
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

function stubWindow(attach: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal("window", {
    desktop: {
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
    },
  } as unknown as Window & typeof globalThis);
}

interface ScheduledTimer {
  callback: () => void;
  delay: number;
}

/** 冲刷足够多的微任务，使 ensure 的 catch/finally 链稳定落地。 */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createManualScheduler() {
  const timers = new Map<number, ScheduledTimer>();
  let nextHandle = 1;
  return {
    setTimeout: (callback: () => void, delay: number): number => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout: (handle: number): void => {
      timers.delete(handle);
    },
    fireAll(): void {
      for (const { callback } of [...timers.values()]) callback();
      timers.clear();
    },
    pendingCount(): number {
      return timers.size;
    },
    pendingDelays(): number[] {
      return [...timers.values()].map(({ delay }) => delay);
    },
  };
}

describe("session recovery loop", () => {
  it("首个 tick 处于非 recovering 时不会停止：后续 recovering 转换仍会触发恢复", async () => {
    const record = createSessionRecord({ projectId: "p", threadId: "t" });
    const connection = record.stores.connection;
    const ensure = vi.fn().mockResolvedValue(undefined);
    const scheduler = createManualScheduler();
    const loop = createRecoveryLoop({
      getState: () => connection.getSnapshot(),
      subscribe: (listener) => connection.subscribe(listener),
      ensure,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    try {
      connection.setState("ready");
      await flushMicrotasks();
      // 首次检查非 recovering：循环保持订阅，不会永久停止。
      expect(ensure).not.toHaveBeenCalled();
      expect(scheduler.pendingCount()).toBe(0);

      // 之后的 recovering 转换触发重试；ensure 成功后状态仍未离开 recovering，保持退避轮询。
      connection.setState("recovering");
      expect(ensure).toHaveBeenCalledTimes(1);
      await flushMicrotasks();
      expect(scheduler.pendingCount()).toBe(1);

      // 离开 recovering 后退避取消；再次失败仍可恢复。
      connection.setState("ready");
      expect(scheduler.pendingCount()).toBe(0);
      connection.setState("recovering");
      expect(ensure).toHaveBeenCalledTimes(2);
    } finally {
      loop.dispose();
    }
  });

  it("ensure 连续失败时按指数退避重试并封顶，且无重复 in-flight", async () => {
    const record = createSessionRecord({ projectId: "p", threadId: "t" });
    const connection = record.stores.connection;
    const ensure = vi.fn().mockRejectedValue(new Error("boom"));
    const scheduler = createManualScheduler();
    const loop = createRecoveryLoop({
      getState: () => connection.getSnapshot(),
      subscribe: (listener) => connection.subscribe(listener),
      ensure,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    try {
      connection.setState("recovering");
      expect(ensure).toHaveBeenCalledTimes(1);
      await flushMicrotasks();
      // 首次失败后调度 800 * 2^1 = 1600ms 退避。
      expect(scheduler.pendingDelays()).toEqual([1600]);

      scheduler.fireAll();
      await flushMicrotasks();
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(scheduler.pendingDelays()).toEqual([3200]);

      scheduler.fireAll();
      await flushMicrotasks();
      expect(ensure).toHaveBeenCalledTimes(3);
      expect(scheduler.pendingDelays()).toEqual([6400]);

      scheduler.fireAll();
      await flushMicrotasks();
      expect(ensure).toHaveBeenCalledTimes(4);
      // 退避封顶 10s。
      expect(scheduler.pendingDelays()).toEqual([10000]);

      scheduler.fireAll();
      await flushMicrotasks();
      expect(ensure).toHaveBeenCalledTimes(5);
      expect(scheduler.pendingDelays()).toEqual([10000]);
      // 任一时点只有一个 in-flight ensure（无并发重复 attach）。
      expect(scheduler.pendingCount()).toBe(1);
    } finally {
      loop.dispose();
    }
  });

  it("dispose 后不再重试", async () => {
    const record = createSessionRecord({ projectId: "p", threadId: "t" });
    const connection = record.stores.connection;
    const ensure = vi.fn().mockResolvedValue(undefined);
    const scheduler = createManualScheduler();
    const loop = createRecoveryLoop({
      getState: () => connection.getSnapshot(),
      subscribe: (listener) => connection.subscribe(listener),
      ensure,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    loop.dispose();
    connection.setState("recovering");
    expect(ensure).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("session recovery after post-ready resync failure", () => {
  it("ready 之后 resync 失败回到 recovering，恢复循环以 recover 替换租约并回到 ready", async () => {
    const record = createSessionRecord({ projectId: "p", threadId: "t" });
    const attach = vi
      .fn()
      .mockResolvedValueOnce(attachmentFor(record, "attachment-1"))
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValueOnce(attachmentFor(record, "attachment-2"));
    stubWindow(attach);
    const manager = new SessionTransportManager();

    // 初始 attach 成功：ready。
    const attached = await manager.ensure(record);
    expect(attached.attachmentId).toBe("attachment-1");
    expect(record.stores.connection.getSnapshot()).toBe("ready");
    expect(attach).toHaveBeenCalledTimes(1);

    const scheduler = createManualScheduler();
    const loop = createRecoveryLoop({
      getState: () => record.stores.connection.getSnapshot(),
      subscribe: (listener) => record.stores.connection.subscribe(listener),
      ensure: () => manager.recover(record),
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    try {
      // ready 期间循环空闲：无重试、无定时器。
      expect(scheduler.pendingCount()).toBe(0);

      // resync 失败：连接回到 recovering，旧租约仍在（ensure 无法自愈，recover 必须替换租约）。
      await expect(manager.resync(record)).rejects.toThrow("runtime unavailable");
      expect(record.stores.connection.getSnapshot()).toBe("recovering");
      expect(attach).toHaveBeenCalledTimes(2);

      // 恢复循环的首次重试会吞掉刚失败的 stale pending，随后进入退避；
      // 定时器触发后以 recover（resync 替换租约）重连成功。
      await vi.waitFor(() => expect(scheduler.pendingCount()).toBe(1));
      scheduler.fireAll();
      await vi.waitFor(() => expect(record.stores.connection.getSnapshot()).toBe("ready"));
      expect(attach).toHaveBeenCalledTimes(3);
      expect(attach.mock.calls[2]?.[0]).toMatchObject({ replaceAttachmentId: "attachment-1" });
      expect(manager.getCommittedAttachmentId(record)).toBe("attachment-2");
      // 恢复完成后循环停止，无退避定时器残留，且不再出现第二个顺序 resync。
      await flushMicrotasks();
      expect(attach).toHaveBeenCalledTimes(3);
      expect(scheduler.pendingCount()).toBe(0);
    } finally {
      loop.dispose();
    }
    vi.unstubAllGlobals();
  });

  it("post-ready 恢复再次失败时按退避重试直至成功", async () => {
    const record = createSessionRecord({ projectId: "p", threadId: "t" });
    const attach = vi
      .fn()
      .mockResolvedValueOnce(attachmentFor(record, "attachment-1"))
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockRejectedValueOnce(new Error("runtime still down"))
      .mockResolvedValueOnce(attachmentFor(record, "attachment-2"));
    stubWindow(attach);
    const manager = new SessionTransportManager();
    await manager.ensure(record);
    expect(record.stores.connection.getSnapshot()).toBe("ready");

    const scheduler = createManualScheduler();
    const loop = createRecoveryLoop({
      getState: () => record.stores.connection.getSnapshot(),
      subscribe: (listener) => record.stores.connection.subscribe(listener),
      ensure: () => manager.recover(record),
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    try {
      await expect(manager.resync(record)).rejects.toThrow("runtime unavailable");
      expect(record.stores.connection.getSnapshot()).toBe("recovering");
      expect(attach).toHaveBeenCalledTimes(2);

      // 首次恢复尝试吞掉 stale pending 后进入退避；定时器触发后的恢复再次失败，继续退避。
      await vi.waitFor(() => expect(scheduler.pendingCount()).toBe(1));
      scheduler.fireAll();
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(3));
      expect(record.stores.connection.getSnapshot()).toBe("recovering");
      await vi.waitFor(() => expect(scheduler.pendingCount()).toBe(1));

      // 再次触发定时器后恢复成功。
      scheduler.fireAll();
      await vi.waitFor(() => expect(record.stores.connection.getSnapshot()).toBe("ready"));
      expect(attach).toHaveBeenCalledTimes(4);
      expect(scheduler.pendingCount()).toBe(0);
    } finally {
      loop.dispose();
    }
    vi.unstubAllGlobals();
  });
});

describe("single recovery owner per mounted active session", () => {
  it("一次 recovering 转换只触发一次替换 attach：transport 直接 resync 与唯一恢复循环不产生第二个顺序 resync", async () => {
    const record = createSessionRecord({ projectId: "p", threadId: "t" });
    // 第 3 次调用若被消费（重复 UI 所有者导致的第二次顺序替换 attach）即断言失败。
    const attach = vi
      .fn()
      .mockResolvedValueOnce(attachmentFor(record, "attachment-1"))
      .mockResolvedValueOnce(attachmentFor(record, "attachment-2"))
      .mockResolvedValueOnce(attachmentFor(record, "attachment-3"));
    stubWindow(attach);
    const manager = new SessionTransportManager();

    // SessionContent 挂载语义：cache.ensure 发起初始 attach。
    const attached = await manager.ensure(record);
    expect(attached.attachmentId).toBe("attachment-1");
    expect(record.stores.connection.getSnapshot()).toBe("ready");
    expect(attach).toHaveBeenCalledTimes(1);

    const scheduler = createManualScheduler();
    // 唯一恢复循环：嵌套 SessionProvider 的恢复循环（retryStates 仅 recovering）。
    const loop = createRecoveryLoop({
      getState: () => record.stores.connection.getSnapshot(),
      subscribe: (listener) => record.stores.connection.subscribe(listener),
      ensure: () => manager.recover(record),
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    try {
      // 后续 recovering 转换：handlePush 的直接 resync 与循环订阅者（setState 同步通知）并发响应。
      const directResync = manager.resync(record).catch(() => undefined);
      await vi.waitFor(() => expect(record.stores.connection.getSnapshot()).toBe("ready"));
      await directResync;

      // 恰好一次替换 attach：无 resyncAfterPending 链式第二次替换。
      expect(attach).toHaveBeenCalledTimes(2);
      expect(attach.mock.calls[1]?.[0]).toMatchObject({ replaceAttachmentId: "attachment-1" });
      expect(manager.getCommittedAttachmentId(record)).toBe("attachment-2");
      // 恢复完成后（含微任务冲刷）不再出现第二个顺序 resync。
      await flushMicrotasks();
      expect(attach).toHaveBeenCalledTimes(2);
      expect(scheduler.pendingCount()).toBe(0);
    } finally {
      loop.dispose();
    }
    vi.unstubAllGlobals();
  });

  it("重复 UI 所有者（两个恢复循环）并发 recover 时仍只产生一次替换 attach", async () => {
    const record = createSessionRecord({ projectId: "p", threadId: "t" });
    const attach = vi
      .fn()
      .mockResolvedValueOnce(attachmentFor(record, "attachment-1"))
      .mockResolvedValueOnce(attachmentFor(record, "attachment-2"))
      .mockResolvedValueOnce(attachmentFor(record, "attachment-3"));
    stubWindow(attach);
    const manager = new SessionTransportManager();
    await manager.ensure(record);
    expect(record.stores.connection.getSnapshot()).toBe("ready");

    const scheduler = createManualScheduler();
    // 修复前的 SessionContent 循环（attaching+recovering）与 SessionProvider 循环并发订阅。
    const firstLoop = createRecoveryLoop({
      getState: () => record.stores.connection.getSnapshot(),
      subscribe: (listener) => record.stores.connection.subscribe(listener),
      ensure: () => manager.recover(record),
      retryStates: ["attaching", "recovering"],
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    const secondLoop = createRecoveryLoop({
      getState: () => record.stores.connection.getSnapshot(),
      subscribe: (listener) => record.stores.connection.subscribe(listener),
      ensure: () => manager.recover(record),
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    try {
      const directResync = manager.resync(record).catch(() => undefined);
      await vi.waitFor(() => expect(record.stores.connection.getSnapshot()).toBe("ready"));
      await directResync;

      // 无论多少个 UI 订阅者，transport 只允许一次替换 attach（后续 resync 返回已提交租约）。
      expect(attach).toHaveBeenCalledTimes(2);
      expect(manager.getCommittedAttachmentId(record)).toBe("attachment-2");
      await flushMicrotasks();
      expect(attach).toHaveBeenCalledTimes(2);
      expect(scheduler.pendingCount()).toBe(0);
    } finally {
      firstLoop.dispose();
      secondLoop.dispose();
    }
    vi.unstubAllGlobals();
  });
});
