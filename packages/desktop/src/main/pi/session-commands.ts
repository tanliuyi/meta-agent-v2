import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "../../shared/contracts.ts";

type CommandSession = Pick<AgentSession, "extensionRunner" | "promptTemplates" | "resourceLoader">;

export type DesktopCommand = { name: "compact" } | { name: "reload" } | { name: "name"; title: string };

const DESKTOP_COMMANDS: SlashCommand[] = [
	{ name: "compact", description: "压缩当前会话上下文", source: "builtin" },
	{ name: "name", description: "设置当前会话名称", source: "builtin" },
	{ name: "reload", description: "重新加载 extensions、skills、prompts 和上下文文件", source: "builtin" },
];

/** 从 Pi session 的真实资源生成 Composer slash command。 */
export function getSessionCommands(session: CommandSession): SlashCommand[] {
	const extensions = session.extensionRunner.getRegisteredCommands().map((command) => ({
		name: command.invocationName,
		description: command.description,
		source: "extension" as const,
	}));
	const prompts = session.promptTemplates.map((prompt) => ({
		name: prompt.name,
		description: prompt.description,
		source: "prompt" as const,
	}));
	const skills = session.resourceLoader.getSkills().skills.map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill" as const,
	}));
	return [...DESKTOP_COMMANDS, ...extensions, ...prompts, ...skills];
}

/** 解析由 Desktop 自身处理且有 Pi SDK 等价能力的命令。 */
export function parseDesktopCommand(text: string): DesktopCommand | null {
	const [command, ...args] = text.trim().split(/\s+/);
	if (command === "/compact") return { name: "compact" };
	if (command === "/reload") return { name: "reload" };
	if (command === "/name") return { name: "name", title: args.join(" ").trim() };
	return null;
}
