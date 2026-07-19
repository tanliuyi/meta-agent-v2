/** 编辑工具中可结构化展示的单次文本替换。 */
export interface ToolEdit {
  oldText: string;
  newText: string;
}

/** 按候选键顺序读取第一个字符串参数。 */
export function readToolStringArgument(args: Readonly<Record<string, unknown>>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string") return value;
  }
  return "";
}

/** 从未知输入中提取结构有效的编辑记录。 */
export function parseToolEdits(value: unknown): ToolEdit[] {
  if (!Array.isArray(value)) return [];
  const edits: ToolEdit[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const edit = item as Record<string, unknown>;
    if (typeof edit.oldText === "string" && typeof edit.newText === "string") {
      edits.push({ oldText: edit.oldText, newText: edit.newText });
    }
  }
  return edits;
}

/** 将字符串或 JSON 值格式化为工具面板可直接展示的文本。 */
export function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}
