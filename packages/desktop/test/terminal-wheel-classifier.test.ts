import { describe, expect, it } from "vitest";
import { MouseWheelClassifier } from "../src/renderer/src/components/panel/terminal/terminal-wheel-classifier.ts";

describe("MouseWheelClassifier", () => {
  it("无样本时判定为触控板（不启用平滑动画）", () => {
    expect(new MouseWheelClassifier().isPhysicalMouseWheel()).toBe(false);
  });

  it("物理滚轮的整数倍 delta 序列判定为物理滚轮", () => {
    const classifier = new MouseWheelClassifier();
    classifier.acceptStandardWheelEvent(0, 120);
    classifier.acceptStandardWheelEvent(0, 120);
    classifier.acceptStandardWheelEvent(0, 120);
    expect(classifier.isPhysicalMouseWheel()).toBe(true);
  });

  it("触控板的分数 delta 序列判定为非物理滚轮", () => {
    const classifier = new MouseWheelClassifier();
    classifier.acceptStandardWheelEvent(0, 1.4);
    classifier.acceptStandardWheelEvent(0, 3.2);
    classifier.acceptStandardWheelEvent(0, -2.7);
    classifier.acceptStandardWheelEvent(0, 5.1);
    expect(classifier.isPhysicalMouseWheel()).toBe(false);
  });

  it("物理滚轮小增量（行滚动）也能识别", () => {
    const classifier = new MouseWheelClassifier();
    classifier.acceptStandardWheelEvent(0, 3);
    classifier.acceptStandardWheelEvent(0, 3);
    classifier.acceptStandardWheelEvent(0, 3);
    expect(classifier.isPhysicalMouseWheel()).toBe(true);
  });

  it("双轴同时滚动（触控板手势）判定为非物理滚轮", () => {
    const classifier = new MouseWheelClassifier();
    classifier.acceptStandardWheelEvent(5, 120);
    classifier.acceptStandardWheelEvent(5, 120);
    expect(classifier.isPhysicalMouseWheel()).toBe(false);
  });

  it("滚动方向变化不影响判定", () => {
    const classifier = new MouseWheelClassifier();
    classifier.acceptStandardWheelEvent(0, 120);
    classifier.acceptStandardWheelEvent(0, -120);
    classifier.acceptStandardWheelEvent(0, 120);
    expect(classifier.isPhysicalMouseWheel()).toBe(true);
  });
});
