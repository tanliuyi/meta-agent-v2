import { describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";

describe("bash description parameter", () => {
	it("exposes description as optional metadata without changing the executed command", async () => {
		let executedCommand: string | undefined;
		const operations: BashOperations = {
			exec: async (command) => {
				executedCommand = command;
				return { exitCode: 0 };
			},
		};
		const tool = createBashTool(process.cwd(), { operations });

		expect(tool.parameters.properties.description).toMatchObject({
			type: "string",
			description: "Natural-language description of what the command does",
		});
		expect(tool.parameters.required).not.toContain("description");

		await tool.execute("bash-description", {
			command: "printf ok",
			description: "Print a success marker",
		});

		expect(executedCommand).toBe("printf ok");
	});
});
