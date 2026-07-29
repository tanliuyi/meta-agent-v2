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

const HIDDEN_UI_ONLY_EXTENSION_COMMANDS = new Set([
  "memory-insights",
  "memory-skills",
  "memory-preview-context",
  "memory-switch-project",
  "learn-memory-tool",
]);

const BUILTIN_EXTENSION_COMMAND_LOCALIZATIONS: Readonly<Record<string, { name: string; description: string }>> = {
  "memory-insights": { name: "记忆概览", description: "查看持久记忆中存储的内容" },
  "memory-skills": { name: "记忆技能", description: "列出已管理和已加载的流程技能" },
  "memory-interview": { name: "记忆访谈", description: "回答问题并预先填写用户资料，以便跨会话记住你" },
  "memory-switch-project": { name: "切换记忆项目", description: "切换项目级记忆的当前项目" },
  "learn-memory-tool": { name: "了解记忆工具", description: "学习如何有效使用 Hermes Memory 扩展" },
  "memory-sync-markdown": { name: "同步 Markdown 记忆", description: "协调 SQLite 搜索镜像与 Markdown 记忆" },
  "memory-preview-context": { name: "预览记忆上下文", description: "预览记忆策略或旧版记忆上下文块" },
  "memory-index-sessions": { name: "索引历史会话", description: "将过去的 Pi 会话导入搜索数据库" },
  "memory-consolidate": { name: "整理记忆", description: "手动触发记忆整理以释放空间" },
  subagents: { name: "管理子代理", description: "检查子代理信息并更新模型、思考级别或提示词" },
  run: { name: "运行子代理", description: "直接运行一个子代理" },
  chain: { name: "串行运行子代理", description: "按顺序运行多个子代理" },
  "run-chain": { name: "运行已保存链", description: "运行已保存的子代理链" },
  parallel: { name: "并行运行子代理", description: "并行运行多个子代理" },
  "subagent-cost": { name: "子代理成本", description: "显示当前会话中主代理与子代理的用量成本" },
  "subagents-doctor": { name: "子代理诊断", description: "显示子代理诊断信息" },
  "subagents-fleet": { name: "子代理运行列表", description: "打开实时只读的子代理运行列表" },
  "subagents-stop": { name: "停止子代理", description: "停止当前会话中的异步子代理运行" },
  "prompt-workflow": { name: "运行提示词工作流", description: "通过原生子代理运行一个提示词模板" },
  "chain-prompts": { name: "串联提示词", description: "将多个提示词模板作为原生子代理链运行" },
  "subagents-models": { name: "子代理模型", description: "显示运行时加载的内置子代理模型" },
  "subagents-profiles": { name: "子代理配置方案", description: "列出已保存的子代理配置方案" },
  "subagents-load-profile": { name: "加载子代理配置", description: "将子代理配置方案加载到设置中" },
  "subagents-refresh-provider-models": { name: "刷新提供商模型", description: "刷新指定提供商的缓存模型目录" },
  "subagents-generate-profiles": { name: "生成子代理配置", description: "生成指定提供商的配额与质量配置方案" },
  "subagents-check-profile": { name: "检查子代理配置", description: "检查已保存的配置方案是否仍指向可用模型" },
  "subagents-watchdog": { name: "子代理监视器", description: "查看或切换默认关闭的子代理监视器" },
};

function builtinExtensionCommandLocalization(command: SlashCommand) {
  return command.source === "extension" ? BUILTIN_EXTENSION_COMMAND_LOCALIZATIONS[command.name] : undefined;
}

function isHiddenUiOnlyCommand(command: SlashCommand): boolean {
  return command.source === "extension" && HIDDEN_UI_ONLY_EXTENSION_COMMANDS.has(command.name);
}

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
  const localization = builtinExtensionCommandLocalization(command);
  const displayName = localization?.name.toLocaleLowerCase() ?? "";
  const description = command.description?.toLocaleLowerCase() ?? "";
  const displayDescription = localization?.description.toLocaleLowerCase() ?? "";
  const searchable = `${normalizedName} ${displayName} ${description} ${displayDescription} ${COMMAND_SOURCE_SEARCH_TERMS[command.source]}`;
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

/** 本地化内置扩展命令，其他资源仅移除技能协议前缀。 */
export function slashCommandDisplayName(command: SlashCommand): string {
  return (
    builtinExtensionCommandLocalization(command)?.name ??
    (command.source === "skill" ? command.name.replace(/^skill:/, "") : command.name)
  );
}

export function slashCommandDisplayDescription(command: SlashCommand): string | undefined {
  return builtinExtensionCommandLocalization(command)?.description ?? command.description;
}

/** 规范化命令名、来源和说明并按名称相关度排序。 */
export function searchSlashCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const terms = normalizedSearchTerms(query);
  return commands
    .filter((command) => !isHiddenUiOnlyCommand(command))
    .map((command, index) => ({ command, index, score: commandSearchScore(command, terms) }))
    .filter((entry): entry is { command: SlashCommand; index: number; score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ command }) => command);
}

/** 生成旧 ComposerSuggestions 使用的命令建议。 */
export function commandSuggestions(commands: readonly SlashCommand[], query: string): ComposerSuggestion[] {
  return searchSlashCommands(commands, query).map((command) => ({
    id: `${command.source}:${command.name}`,
    label: `/${command.source === "extension" ? slashCommandDisplayName(command) : command.name}`,
    detail: slashCommandDisplayDescription(command),
    type: "command",
    text: `/${command.name} `,
  }));
}

/** 将 Project 文件结果映射为 assistant-ui directive 引用建议。 */
export function fileSuggestions(files: readonly FileNode[]): ComposerSuggestion[] {
  return files.map((file) => {
    const normalizedPath = file.path.replaceAll("\\", "/");
    const separatorIndex = normalizedPath.lastIndexOf("/");
    return {
      id: file.path,
      label: file.name,
      detail: separatorIndex >= 0 ? normalizedPath.slice(0, separatorIndex) : undefined,
      type: file.type,
      text: `${unstable_defaultDirectiveFormatter.serialize({
        id: file.path,
        type: "file",
        label: file.path,
      })} `,
    };
  });
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
