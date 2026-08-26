import type { TerminalEvent } from "../../../../../shared/contracts.ts";

const DEFAULT_MAX_DATA_LENGTH = 1024 * 1024;
const DEFAULT_MAX_EVENT_COUNT = 8192;

export interface TerminalStartupDrain {
  events: TerminalEvent[];
  truncated: boolean;
}

/** Buffers startup deltas without allowing stalled terminal.open IPC to retain unbounded output. */
export class TerminalStartupBuffer {
  private readonly maxDataLength: number;
  private readonly maxEventCount: number;
  private events: Array<TerminalEvent | undefined> = [];
  private activeEventCount = 0;
  private dataLength = 0;
  private dataTrimIndex = 0;
  private headIndex = 0;
  private truncated = false;

  constructor(maxDataLength = DEFAULT_MAX_DATA_LENGTH, maxEventCount = DEFAULT_MAX_EVENT_COUNT) {
    this.maxDataLength = maxDataLength;
    this.maxEventCount = maxEventCount;
  }

  append(event: TerminalEvent): void {
    if (event.type === "reset") this.clear();
    this.events.push(event);
    this.activeEventCount += 1;
    if (event.type === "data") this.dataLength += event.data.length;
    this.trimEventCount();
    this.trimData();
    this.compact();
  }

  drain(): TerminalStartupDrain {
    const events = this.events.filter((event): event is TerminalEvent => event !== undefined);
    const truncated = this.truncated;
    this.clear();
    return { events, truncated };
  }

  clear(): void {
    this.events = [];
    this.activeEventCount = 0;
    this.dataLength = 0;
    this.dataTrimIndex = 0;
    this.headIndex = 0;
    this.truncated = false;
  }

  private trimEventCount(): void {
    while (this.activeEventCount > this.maxEventCount) {
      const event = this.events[this.headIndex];
      this.events[this.headIndex] = undefined;
      this.headIndex += 1;
      if (!event) continue;
      this.activeEventCount -= 1;
      this.truncated = true;
      if (event.type === "data") this.dataLength -= event.data.length;
    }
  }

  private trimData(): void {
    let overflow = this.dataLength - this.maxDataLength;
    while (overflow > 0 && this.dataTrimIndex < this.events.length) {
      const event = this.events[this.dataTrimIndex];
      if (event?.type !== "data") {
        this.dataTrimIndex += 1;
        continue;
      }
      this.events[this.dataTrimIndex] = undefined;
      this.activeEventCount -= 1;
      this.dataLength -= event.data.length;
      overflow -= event.data.length;
      this.dataTrimIndex += 1;
      this.truncated = true;
    }
  }

  private compact(): void {
    if (this.events.length <= this.maxEventCount * 2) return;
    this.events = this.events.filter((event): event is TerminalEvent => event !== undefined);
    this.headIndex = 0;
    this.dataTrimIndex = 0;
  }
}
