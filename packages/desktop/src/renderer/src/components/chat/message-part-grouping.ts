import { type GroupByContext, groupPartByType, type PartState } from "@assistant-ui/react";

const GROUP_CHAIN_OF_THOUGHT_PARTS = groupPartByType({
  reasoning: ["group-chainOfThought"],
  "tool-call": ["group-chainOfThought"],
  "standalone-tool-call": [],
});

export function createProcessGroupBy(parts: readonly PartState[], isRunning: boolean) {
  const indexByPart = new Map(parts.map((part, index) => [part, index]));
  const finalTextIndex = isRunning ? -1 : finalResponseTextIndex(parts);

  return (part: PartState, context: GroupByContext): readonly `group-${string}`[] => {
    if (indexByPart.get(part) === finalTextIndex) return [];
    if (part.type === "text") return ["group-process"];
    const nestedGroups = GROUP_CHAIN_OF_THOUGHT_PARTS(part, context);
    return nestedGroups.length > 0 ? ["group-process", ...nestedGroups] : [];
  };
}

export function hasFinalResponseText(parts: readonly PartState[]): boolean {
  return finalResponseTextIndex(parts) >= 0;
}

function finalResponseTextIndex(parts: readonly PartState[]): number {
  const lastMeaningfulIndex = parts.findLastIndex((part) => part.type !== "text" || part.text.trim().length > 0);
  return parts[lastMeaningfulIndex]?.type === "text" ? lastMeaningfulIndex : -1;
}

const TOOL_SUMMARIES: Readonly<Record<string, string>> = {
  read: "读取了一些文件",
  write: "修改了一些文件",
  edit: "修改了一些文件",
  bash: "执行了一些命令",
  grep: "搜索了一些内容",
  find: "查找了一些文件",
  ls: "查看了一些目录",
};

export function summarizeChainOfThought(parts: readonly PartState[], indices: readonly number[]): string {
  const summaries = new Set<string>();
  let hasUnknownTool = false;

  for (const index of indices) {
    const part = parts[index];
    if (part?.type !== "tool-call") continue;
    const summary = TOOL_SUMMARIES[part.toolName];
    if (summary) summaries.add(summary);
    else hasUnknownTool = true;
  }

  if (hasUnknownTool) summaries.add("使用了其他工具");
  const values = [...summaries];
  if (values.length === 0) return "思考过程";
  if (values.length <= 3) return values.join("，");
  return `${values.slice(0, 3).join("，")}等操作`;
}
