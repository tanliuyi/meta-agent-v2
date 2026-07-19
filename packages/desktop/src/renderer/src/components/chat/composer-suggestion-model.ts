import type { FileNode, SlashCommand } from "../../../../shared/contracts.ts";

export interface ComposerSuggestion {
  id: string;
  label: string;
  detail?: string;
  type: "command" | "file" | "directory";
  text: string;
}

export interface ComposerCompletionContext {
  type: "command" | "file";
  query: string;
  start: number;
}

/** 根据输入末尾解析 slash command 或文件引用补全上下文。 */
export function composerCompletionContext(text: string): ComposerCompletionContext | null {
  if (/^\/[^\s]*$/.test(text)) return { type: "command", query: text.slice(1), start: 0 };
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  if (!match || match.index === undefined) return null;
  const at = text.lastIndexOf("@", match.index + match[0].length);
  return { type: "file", query: match[1] ?? "", start: at };
}

/** 按命令名过滤 extension command，不截断完整结果集。 */
export function commandSuggestions(commands: readonly SlashCommand[], query: string): ComposerSuggestion[] {
  const normalizedQuery = query.toLowerCase();
  return commands
    .filter(({ name }) => name.toLowerCase().includes(normalizedQuery))
    .map((command) => ({
      id: `${command.source}:${command.name}`,
      label: `/${command.name}`,
      detail: command.description,
      type: "command",
      text: `/${command.name} `,
    }));
}

/** 将 Project 文件结果映射为 Composer 引用建议。 */
export function fileSuggestions(files: readonly FileNode[]): ComposerSuggestion[] {
  return files.map((file) => ({
    id: `${file.type}:${file.path}`,
    label: file.path,
    detail: file.type === "directory" ? "目录" : "文件",
    type: file.type,
    text: `@${file.path} `,
  }));
}

/** 为 combobox 活动建议生成稳定 DOM id。 */
export function composerSuggestionOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

/** 键盘选择变化时只滚动建议列表，不影响 Thread viewport。 */
export function scrollSelectedSuggestion(container: HTMLElement | null): void {
  container?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
