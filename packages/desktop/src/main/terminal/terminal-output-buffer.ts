/** 有界分块文本缓冲；追加时不复制完整历史输出。 */
export class TerminalOutputBuffer {
  private static readonly TARGET_CHUNK_SIZE = 4096;
  private chunks: string[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private length = 0;
  private absoluteStart = 0;
  private absoluteEnd = 0;
  private newlineOffsets: number[] = [];
  private newlineHead = 0;
  private readonly maxLength: number;

  constructor(maxLength: number) {
    if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new Error("Terminal output limit must be positive");
    this.maxLength = maxLength;
  }

  append(value: string): void {
    if (!value) return;
    this.indexNewlines(value);
    this.appendChunk(value);
    this.length += value.length;
    this.absoluteEnd += value.length;
    if (this.length <= this.maxLength) return;

    const excess = this.length - this.maxLength;
    const searchOffset = this.absoluteStart + excess;
    while (
      this.newlineOffsets[this.newlineHead] !== undefined &&
      this.newlineOffsets[this.newlineHead]! < searchOffset
    ) {
      this.newlineHead += 1;
    }
    const newlineOffset = this.newlineOffsets[this.newlineHead];
    this.discard(newlineOffset === undefined ? excess : newlineOffset - this.absoluteStart + 1);
  }

  toString(): string {
    if (this.length === 0) return "";
    const visible = this.chunks.slice(this.headIndex);
    visible[0] = visible[0]!.slice(this.headOffset);
    return visible.join("");
  }

  private indexNewlines(value: string): void {
    let index = value.indexOf("\n");
    while (index !== -1) {
      this.newlineOffsets.push(this.absoluteEnd + index);
      index = value.indexOf("\n", index + 1);
    }
  }

  private appendChunk(value: string): void {
    const lastIndex = this.chunks.length - 1;
    const canMergeTail =
      lastIndex >= this.headIndex &&
      (lastIndex !== this.headIndex || this.headOffset === 0) &&
      this.chunks[lastIndex]!.length + value.length <= TerminalOutputBuffer.TARGET_CHUNK_SIZE;
    if (canMergeTail) this.chunks[lastIndex] += value;
    else this.chunks.push(value);
  }

  private discard(count: number): void {
    this.length -= count;
    this.absoluteStart += count;
    let remaining = count;
    while (remaining > 0) {
      const chunk = this.chunks[this.headIndex]!;
      const available = chunk.length - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        this.headIndex += 1;
        this.headOffset = 0;
      }
    }

    if (this.headIndex === this.chunks.length) {
      this.chunks = [];
      this.headIndex = 0;
    } else if (this.headIndex > 64 && this.headIndex * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }

    while (
      this.newlineOffsets[this.newlineHead] !== undefined &&
      this.newlineOffsets[this.newlineHead]! < this.absoluteStart
    ) {
      this.newlineHead += 1;
    }
    if (this.newlineHead > 64 && this.newlineHead * 2 > this.newlineOffsets.length) {
      this.newlineOffsets = this.newlineOffsets.slice(this.newlineHead);
      this.newlineHead = 0;
    }
    if (this.length === 0) {
      this.absoluteStart = 0;
      this.absoluteEnd = 0;
      this.newlineOffsets = [];
      this.newlineHead = 0;
    }
  }
}
