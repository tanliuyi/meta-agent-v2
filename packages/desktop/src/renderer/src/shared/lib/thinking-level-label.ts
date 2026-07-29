import type { ThinkingLevel } from "../../../../shared/contracts.ts";

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "关",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

/** Returns the default Desktop label for a Pi thinking level. */
export function getThinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_LEVEL_LABELS[level];
}
