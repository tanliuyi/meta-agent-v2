import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getShellConfig, getWindowsBashCandidates } from "../src/utils/shell.ts";

describe("Windows Bash resolution", () => {
	it("places the Desktop-managed runtime after system Git installations", () => {
		expect(
			getWindowsBashCandidates({
				ProgramFiles: "C:\\Program Files",
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				PI_CODING_AGENT_MANAGED_BASH_PATH: "C:\\Meta Agent\\resources\\managed-shell\\bin\\bash.exe",
			}),
		).toEqual([
			"C:\\Program Files\\Git\\bin\\bash.exe",
			"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
			"C:\\Meta Agent\\resources\\managed-shell\\bin\\bash.exe",
		]);
	});

	it("omits an unavailable managed runtime candidate", () => {
		expect(getWindowsBashCandidates({ ProgramFiles: "D:\\Apps" })).toEqual(["D:\\Apps\\Git\\bin\\bash.exe"]);
	});

	it("selects an existing managed runtime before searching PATH", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-managed-bash-"));
		const managedShellPath = join(root, "bash.exe");
		writeFileSync(managedShellPath, "");
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const originalProgramFiles = process.env.ProgramFiles;
		const originalProgramFilesX86 = process.env["ProgramFiles(x86)"];
		const originalManagedShellPath = process.env.PI_CODING_AGENT_MANAGED_BASH_PATH;
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			process.env.ProgramFiles = join(root, "missing-program-files");
			process.env["ProgramFiles(x86)"] = join(root, "missing-program-files-x86");
			process.env.PI_CODING_AGENT_MANAGED_BASH_PATH = managedShellPath;

			expect(getShellConfig()).toEqual({ shell: managedShellPath, args: ["-c"] });
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
			restoreEnvironment("ProgramFiles", originalProgramFiles);
			restoreEnvironment("ProgramFiles(x86)", originalProgramFilesX86);
			restoreEnvironment("PI_CODING_AGENT_MANAGED_BASH_PATH", originalManagedShellPath);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
