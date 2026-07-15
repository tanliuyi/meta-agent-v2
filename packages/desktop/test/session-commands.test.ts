import { describe, expect, it } from "vitest";
import { getSessionCommands, parseDesktopCommand } from "../src/main/pi/session-commands.ts";

describe("session commands", () => {
	it("合并 Desktop、extension、prompt 和 skill 命令", () => {
		const commands = getSessionCommands({
			extensionRunner: {
				getRegisteredCommands: () => [{ invocationName: "review", description: "审查代码" }],
			},
			promptTemplates: [{ name: "fix", description: "修复问题" }],
			resourceLoader: {
				getSkills: () => ({ skills: [{ name: "frontend", description: "前端设计" }] }),
			},
		});

		expect(commands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "compact", source: "builtin" }),
				{ name: "review", description: "审查代码", source: "extension" },
				{ name: "fix", description: "修复问题", source: "prompt" },
				{ name: "skill:frontend", description: "前端设计", source: "skill" },
			]),
		);
	});

	it("只解析 Desktop 有等价 SDK 能力的命令", () => {
		expect(parseDesktopCommand("/compact")).toEqual({ name: "compact" });
		expect(parseDesktopCommand("/name  调研 assistant-ui ")).toEqual({
			name: "name",
			title: "调研 assistant-ui",
		});
		expect(parseDesktopCommand("/skill:frontend")).toBeNull();
	});
});
