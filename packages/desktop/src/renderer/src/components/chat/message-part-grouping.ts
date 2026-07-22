import { type GroupByContext, groupPartByType, type PartState } from "@assistant-ui/react";

const GROUP_BY_MEMO_KEY = Symbol.for("@assistant-ui/groupBy.memoKey");
const RUN_GROUP_MEMO_KEY = "pi-run-activity:v1";

export const groupMessagePart = groupPartByType({
  reasoning: ["group-chainOfThought"],
  "tool-call": ["group-chainOfThought"],
  "standalone-tool-call": [],
});

/** 预计算 part identity 索引，并声明 assistant-ui 可识别的稳定分组配置。 */
export function createRunGroupPart(parts: readonly PartState[]) {
  const finalTextIndex = findFinalResponseTextIndex(parts);
  const partIndexes = new Map(parts.map((part, index) => [part, index]));

  const groupPart = (part: PartState, context: GroupByContext): readonly `group-${string}`[] => {
    const index = partIndexes.get(part) ?? -1;
    const stepPath = groupMessagePart(part, context);
    const standaloneTool = part.type === "tool-call" && stepPath.length === 0;
    const eligibleType = isRunActivityPart(part);
    const belongsToRunGroup =
      index >= 0 && eligibleType && !standaloneTool && (finalTextIndex < 0 || index < finalTextIndex);
    return belongsToRunGroup ? ["group-runActivity", ...stepPath] : stepPath;
  };
  Object.defineProperty(groupPart, GROUP_BY_MEMO_KEY, { value: RUN_GROUP_MEMO_KEY });
  return groupPart;
}

function isRunActivityPart(part: PartState): boolean {
  return part.type === "text" || part.type === "reasoning" || part.type === "tool-call" || isNonCompactionNotice(part);
}

function isNonCompactionNotice(part: PartState): boolean {
  return (
    part.type === "data" &&
    part.name === "pi-notice" &&
    typeof part.data === "object" &&
    part.data !== null &&
    "noticeType" in part.data &&
    part.data.noticeType !== "compaction"
  );
}

export function hasFinalResponseText(parts: readonly PartState[]): boolean {
  return findFinalResponseTextIndex(parts) >= 0;
}

function findFinalResponseTextIndex(parts: readonly PartState[]): number {
  const lastStepIndex = parts.findLastIndex((part) => part.type === "reasoning" || part.type === "tool-call");
  const lastTextIndex = parts.findLastIndex((part) => part.type === "text" && part.text.trim().length > 0);
  return lastTextIndex > lastStepIndex ? lastTextIndex : -1;
}

export function hasTextAfterGroup(parts: readonly PartState[], indices: readonly number[]): boolean {
  const endIndex = indices.at(-1);
  if (endIndex === undefined) return false;
  for (let index = endIndex + 1; index < parts.length; index += 1) {
    if (parts[index]?.type === "text") return true;
  }
  return false;
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
