import { type GroupByContext, groupPartByType, type PartState } from "@assistant-ui/react";

export const groupMessagePart = groupPartByType({
  reasoning: ["group-chainOfThought"],
  "tool-call": ["group-chainOfThought"],
  "standalone-tool-call": [],
});

export function createRunGroupPart(parts: readonly PartState[]) {
  const lastStepIndex = parts.findLastIndex((part) => part.type === "reasoning" || part.type === "tool-call");
  const lastTextIndex = parts.findLastIndex((part) => part.type === "text" && part.text.trim().length > 0);
  const finalTextIndex = lastTextIndex > lastStepIndex ? lastTextIndex : -1;

  return (part: PartState, context: GroupByContext): readonly `group-${string}`[] => {
    const index = parts.indexOf(part);
    const stepPath = groupMessagePart(part, context);
    const standaloneTool = part.type === "tool-call" && stepPath.length === 0;
    const eligibleType = part.type === "text" || part.type === "reasoning" || part.type === "tool-call";
    const belongsToRunGroup =
      index >= 0 && eligibleType && !standaloneTool && (finalTextIndex < 0 || index < finalTextIndex);
    return belongsToRunGroup ? ["group-runActivity", ...stepPath] : stepPath;
  };
}

export function hasTextAfterGroup(parts: readonly PartState[], indices: readonly number[]): boolean {
  const endIndex = indices.at(-1);
  return endIndex !== undefined && parts.slice(endIndex + 1).some((part) => part.type === "text");
}

const TOOL_SUMMARIES: Readonly<Record<string, string>> = {
  read: "读取一些文件",
  write: "修改一些文件",
  edit: "修改一些文件",
  bash: "执行一些命令",
  grep: "搜索一些内容",
  find: "查找一些文件",
  ls: "查看一些目录",
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

  if (hasUnknownTool) summaries.add("使用其他工具");
  const values = [...summaries];
  if (values.length === 0) return "思考过程";
  if (values.length <= 3) return values.join("，");
  return `${values.slice(0, 3).join("，")}等操作`;
}
