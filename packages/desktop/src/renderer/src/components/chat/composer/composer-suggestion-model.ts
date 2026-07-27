import { unstable_defaultDirectiveFormatter } from "@assistant-ui/react";
import type { FileNode, SlashCommand } from "../../../../../shared/contracts.ts";

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

const COMMAND_SOURCE_SEARCH_TERMS: Record<SlashCommand["source"], string> = {
  builtin: "builtin built in 内置 命令",
  extension: "extension 扩展 命令",
  prompt: "prompt template 提示词 模板",
  skill: "skill 技能",
};

function normalizedSearchTerms(value: string): string[] {
  return value
    .trim()
    .replace(/^\/+/, "")
    .toLocaleLowerCase()
    .split(/[\s:_-]+/u)
    .filter(Boolean);
}

function commandSearchScore(command: SlashCommand, terms: readonly string[]): number | null {
  if (terms.length === 0) return 0;
  const name = command.name.toLocaleLowerCase();
  const normalizedName = normalizedSearchTerms(name).join(" ");
  const description = command.description?.toLocaleLowerCase() ?? "";
  const searchable = `${normalizedName} ${description} ${COMMAND_SOURCE_SEARCH_TERMS[command.source]}`;
  if (!terms.every((term) => searchable.includes(term))) return null;

  const query = terms.join(" ");
  if (name === query || normalizedName === query) return 0;
  if (name.startsWith(query) || normalizedName.startsWith(query)) return 10;

  const compactQuery = terms.join("");
  const compactName = normalizedName.replaceAll(" ", "");
  if (compactName.startsWith(compactQuery)) return 20;
  if (compactName.includes(compactQuery)) return 30;
  if (terms.every((term) => normalizedName.includes(term))) {
    return 40 + terms.reduce((score, term) => score + normalizedName.indexOf(term), 0);
  }
  return 100 + terms.reduce((score, term) => score + searchable.indexOf(term), 0);
}

/** 移除命令协议前缀，仅用于建议列表展示。 */
export function slashCommandDisplayName(command: SlashCommand): string {
  return command.source === "skill" ? command.name.replace(/^skill:/, "") : command.name;
}

/** 规范化命令名、来源和说明并按名称相关度排序。 */
export function searchSlashCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const terms = normalizedSearchTerms(query);
  return commands
    .map((command, index) => ({ command, index, score: commandSearchScore(command, terms) }))
    .filter((entry): entry is { command: SlashCommand; index: number; score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ command }) => command);
}

/** 生成旧 ComposerSuggestions 使用的命令建议。 */
export function commandSuggestions(commands: readonly SlashCommand[], query: string): ComposerSuggestion[] {
  return searchSlashCommands(commands, query).map((command) => ({
    id: `${command.source}:${command.name}`,
    label: `/${command.name}`,
    detail: command.description,
    type: "command",
    text: `/${command.name} `,
  }));
}

/** 将 Project 文件结果映射为 assistant-ui directive 引用建议。 */
export function fileSuggestions(files: readonly FileNode[]): ComposerSuggestion[] {
  return files.map((file) => ({
    id: `${file.type}:${file.path}`,
    label: file.path,
    detail: file.type === "directory" ? "目录" : "文件",
    type: file.type,
    text: `${unstable_defaultDirectiveFormatter.serialize({
      id: file.path,
      type: "file",
      label: file.path,
    })} `,
  }));
}

/** 为 combobox 活动建议生成稳定 DOM id。 */
export function composerSuggestionOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

/** 键盘选择变化时只滚动建议列表，不影响 Thread viewport。 */
export function scrollSelectedSuggestion(container: HTMLElement | null): void {
  container
    ?.querySelector<HTMLElement>('[aria-selected="true"], [data-highlighted]')
    ?.scrollIntoView({ block: "nearest" });
}
