import { type GroupByContext, groupPartByType, type PartState } from "@assistant-ui/react";

const GROUP_PROCESS_PARTS = groupPartByType({
  reasoning: ["group-process", "group-reasoning"],
  "tool-call": ["group-process", "group-tool"],
  "standalone-tool-call": [],
});

/** 将最终回答之前的文本与 reasoning/tool 合并为一个连续过程组。 */
export function createProcessGroupBy(parts: readonly PartState[], isRunning: boolean) {
  const indexByPart = new Map(parts.map((part, index) => [part, index]));
  const finalTextIndex = isRunning
    ? -1
    : parts.findLastIndex((part) => part.type === "text" && part.text.trim().length > 0);

  return (part: PartState, context: GroupByContext): readonly `group-${string}`[] => {
    if (part.type === "text" && indexByPart.get(part) !== finalTextIndex) {
      return ["group-process", "group-intermediate-text"];
    }
    return GROUP_PROCESS_PARTS(part, context);
  };
}
