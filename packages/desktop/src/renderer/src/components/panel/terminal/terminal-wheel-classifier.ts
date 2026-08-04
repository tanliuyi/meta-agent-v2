/**
 * 物理滚轮 / 触控板分类器（移植 VS Code MouseWheelClassifier 算法）。
 *
 * 物理鼠标滚轮的 delta 值通常是整数（120 的倍数或小整数），触控板则产生
 * 连续的分数 delta。分类器保留最近 5 个 wheel 样本，按时间衰减加权累计
 * "物理滚轮特征分"：delta 为整数且在相邻样本间呈倍数关系时得分低，
 * 总分 <= 0.5 判定为物理滚轮。
 *
 * 用途：平滑滚动动画只对物理滚轮启用（触控板自带平滑，叠加动画会卡顿），
 * 对齐 VS Code terminal.integrated.smoothScrolling 的实现。
 */

interface WheelSample {
  timestamp: number;
  deltaX: number;
  deltaY: number;
  /** 物理滚轮特征分：0=物理滚轮特征明显，1=触控板特征明显。 */
  score: number;
}

export class MouseWheelClassifier {
  private static readonly instance = new MouseWheelClassifier();

  static get INSTANCE(): MouseWheelClassifier {
    return MouseWheelClassifier.instance;
  }

  private readonly capacity = 5;
  private readonly memory: WheelSample[] = [];
  private front = -1;
  private rear = -1;

  /** 最近样本判定为物理滚轮；无样本时返回 false（保守：不启用平滑动画）。 */
  isPhysicalMouseWheel(): boolean {
    if (this.front === -1 && this.rear === -1) return false;
    let weight = 1;
    let total = 0;
    let halfLife = 1;
    let index = this.rear;
    for (;;) {
      const factor = index === this.front ? weight : 2 ** -halfLife;
      weight -= factor;
      total += this.memory[index].score * factor;
      if (index === this.front) break;
      index = (this.capacity + index - 1) % this.capacity;
      halfLife += 1;
    }
    return total <= 0.5;
  }

  /** 接受一个 wheel 事件（delta 为事件原始值，不需要 zoomFactor）。 */
  acceptStandardWheelEvent(deltaX: number, deltaY: number): void {
    this.accept(Date.now(), deltaX, deltaY);
  }

  private accept(timestamp: number, deltaX: number, deltaY: number): void {
    const sample: WheelSample = { timestamp, deltaX, deltaY, score: 0 };
    let previous: WheelSample | undefined;
    if (this.front === -1 && this.rear === -1) {
      this.memory[0] = sample;
      this.front = 0;
      this.rear = 0;
    } else {
      previous = this.memory[this.rear];
      this.rear = (this.rear + 1) % this.capacity;
      if (this.rear === this.front) this.front = (this.front + 1) % this.capacity;
      this.memory[this.rear] = sample;
    }
    sample.score = this.computeScore(sample, previous);
  }

  /**
   * 特征分：双轴同时滚动记 1（触控板手势）；delta 非整数加 0.25（物理滚轮产生整数 delta）；
   * 与前一样本成倍数关系（物理滚轮的刻度节奏）减 0.5。钳制在 [0, 1]。
   */
  private computeScore(current: WheelSample, previous: WheelSample | undefined): number {
    if (Math.abs(current.deltaX) > 0 && Math.abs(current.deltaY) > 0) return 1;
    let score = 0.5;
    if (!this.isAlmostInt(current.deltaX) || !this.isAlmostInt(current.deltaY)) {
      score += 0.25;
    }
    if (previous) {
      const currentX = Math.abs(current.deltaX);
      const currentY = Math.abs(current.deltaY);
      const previousX = Math.abs(previous.deltaX);
      const previousY = Math.abs(previous.deltaY);
      const minX = Math.max(Math.min(currentX, previousX), 1);
      const minY = Math.max(Math.min(currentY, previousY), 1);
      const maxX = Math.max(currentX, previousX);
      const maxY = Math.max(currentY, previousY);
      if (maxX % minX === 0 && maxY % minY === 0) {
        score -= 0.5;
      }
    }
    return Math.min(Math.max(score, 0), 1);
  }

  private isAlmostInt(value: number): boolean {
    return Math.abs(Math.round(value) - value) < 0.01;
  }
}
