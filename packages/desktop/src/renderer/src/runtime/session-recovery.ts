import type { SessionConnectionState } from "./pi-session-store.ts";

const INITIAL_RETRY_DELAY_MS = 800;
const MAX_RETRY_DELAY_MS = 10_000;

export interface SessionRecoveryOptions {
  getState(): SessionConnectionState;
  subscribe(listener: () => void): () => void;
  /** 每次重试执行的恢复操作（如 transport.recover），失败时按退避重试。 */
  ensure(): Promise<unknown>;
  /** 需要触发恢复的连接状态；默认仅 recovering。 */
  retryStates?: readonly SessionConnectionState[];
  setTimeout?(callback: () => void, delayMs: number): number;
  clearTimeout?(handle: number): void;
}

export interface SessionRecoveryLoop {
  dispose(): void;
}

/**
 * 连接进入 retryStates（如 recovering）时以指数退避重试 ensure，离开时停止并重置退避。
 * 通过订阅连接状态响应任意后续的 recovering 转换（含 ready 之后的 resync 失败），
 * 且任一时刻至多一个 in-flight ensure，避免重复 attach。
 */
export function createRecoveryLoop(options: SessionRecoveryOptions): SessionRecoveryLoop {
  const retryStates = options.retryStates ?? ["recovering"];
  const schedule =
    options.setTimeout ?? ((callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs));
  const clearScheduled = options.clearTimeout ?? ((handle: number) => window.clearTimeout(handle));
  let disposed = false;
  let timer: number | undefined;
  let inFlight = false;
  let attempts = 0;

  const retry = (): void => {
    if (disposed || inFlight) return;
    if (!retryStates.includes(options.getState())) {
      attempts = 0;
      return;
    }
    inFlight = true;
    options
      .ensure()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (disposed) return;
        if (!retryStates.includes(options.getState())) {
          attempts = 0;
          return;
        }
        attempts += 1;
        timer = schedule(retry, Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempts, MAX_RETRY_DELAY_MS));
      });
  };

  const onStateChange = (): void => {
    if (retryStates.includes(options.getState())) {
      // 无排队重试且无 in-flight 时立即恢复；已有退避定时器时保持原调度。
      if (!inFlight && timer === undefined) retry();
      return;
    }
    if (timer !== undefined) {
      clearScheduled(timer);
      timer = undefined;
      attempts = 0;
    }
  };

  const unsubscribe = options.subscribe(onStateChange);
  if (retryStates.includes(options.getState())) retry();

  return {
    dispose(): void {
      disposed = true;
      unsubscribe();
      if (timer !== undefined) clearScheduled(timer);
      timer = undefined;
    },
  };
}
