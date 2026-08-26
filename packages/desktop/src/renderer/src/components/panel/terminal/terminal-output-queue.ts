export interface TerminalOutputTarget {
  reset(): void;
  write(data: string | Uint8Array, callback?: () => void): void;
}

type PendingOperation =
  | { kind: "write"; data: string | Uint8Array; dataLength: number }
  | { kind: "reset"; resolve: () => void }
  | { kind: "replace"; data: string | Uint8Array; resolve: () => void };

const DEFAULT_MAX_PENDING_DATA_LENGTH = 1024 * 1024;

/** xterm 的 write 是异步队列；合并增量写，并把 reset/replace 作为有序屏障。 */
export class TerminalOutputQueue {
  private readonly target: TerminalOutputTarget;
  private readonly maxPendingDataLength: number;
  private readonly pending: PendingOperation[] = [];
  private pendingDataLength = 0;
  private processing = false;
  private disposed = false;
  private releaseCurrentWrite: (() => void) | undefined;

  constructor(target: TerminalOutputTarget, maxPendingDataLength = DEFAULT_MAX_PENDING_DATA_LENGTH) {
    this.target = target;
    this.maxPendingDataLength = maxPendingDataLength;
  }

  write(data: string | Uint8Array): boolean {
    if (this.disposed || data.length > this.maxPendingDataLength - this.pendingDataLength) return false;
    const last = this.pending.at(-1);
    if (last?.kind === "write" && typeof last.data === "string" && typeof data === "string") {
      last.data += data;
      last.dataLength += data.length;
    } else {
      this.pending.push({ kind: "write", data, dataLength: data.length });
    }
    this.pendingDataLength += data.length;
    this.startProcessing();
    return true;
  }

  replace(data: string | Uint8Array): Promise<void> {
    this.discardPending();
    return new Promise((resolve) => {
      if (this.disposed) {
        resolve();
        return;
      }
      this.pending.push({ kind: "replace", data, resolve });
      this.startProcessing();
    });
  }

  reset(): Promise<void> {
    this.discardPending();
    return new Promise((resolve) => {
      if (this.disposed) {
        resolve();
        return;
      }
      this.pending.push({ kind: "reset", resolve });
      this.startProcessing();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.discardPending();
    this.releaseCurrentWrite?.();
    this.releaseCurrentWrite = undefined;
  }

  private startProcessing(): void {
    if (this.processing) return;
    this.processing = true;
    void this.process();
  }

  private async process(): Promise<void> {
    try {
      while (!this.disposed) {
        const operation = this.pending.shift();
        if (!operation) return;
        if (operation.kind === "write") {
          this.pendingDataLength -= operation.dataLength;
          await this.writeNow(operation.data);
          continue;
        }
        if (operation.kind === "reset") {
          this.target.reset();
          operation.resolve();
          continue;
        }
        this.target.reset();
        await this.writeNow(operation.data);
        operation.resolve();
      }
    } finally {
      this.processing = false;
      if (!this.disposed && this.pending.length > 0) this.startProcessing();
    }
  }

  private discardPending(): void {
    for (const operation of this.pending.splice(0)) {
      if (operation.kind === "write") this.pendingDataLength -= operation.dataLength;
      else operation.resolve();
    }
    this.pendingDataLength = 0;
  }

  private writeNow(data: string | Uint8Array): Promise<void> {
    if (data.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (this.releaseCurrentWrite === finish) this.releaseCurrentWrite = undefined;
        resolve();
      };
      this.releaseCurrentWrite = finish;
      try {
        this.target.write(data, finish);
      } catch {
        finish();
      }
    });
  }
}
