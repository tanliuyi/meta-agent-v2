import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/main/store/project-store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectStore", () => {
	it("按 project 和 session 独立恢复 Workbench 状态", async () => {
		const { file, project, store } = await createStore();
		const first = store.getWorkbench(project.id, "first");
		const second = store.getWorkbench(project.id, "second");

		await Promise.all([
			store.setWorkbench({ ...first, panel: "files", panelOpen: true, openFiles: ["README.md"] }),
			store.setWorkbench({ ...second, panel: "tasks", panelOpen: true, terminalOpen: true }),
		]);

		const restored = new ProjectStore(file);
		await restored.load();
		expect(restored.getWorkbench(project.id, "first")).toMatchObject({
			threadId: "first",
			panel: "files",
			openFiles: ["README.md"],
			terminalOpen: false,
		});
		expect(restored.getWorkbench(project.id, "second")).toMatchObject({
			threadId: "second",
			panel: "tasks",
			openFiles: [],
			terminalOpen: true,
		});
	});

	it("并发保存后状态文件仍是完整 JSON", async () => {
		const { file, project, store } = await createStore();
		await Promise.all(
			Array.from({ length: 20 }, (_, index) => store.setArchived(project.id, `thread-${index}`, true)),
		);

		const persisted: unknown = JSON.parse(await readFile(file, "utf8"));
		expect(persisted).toEqual(
			expect.objectContaining({
				archivedThreads: {
					[project.id]: Array.from({ length: 20 }, (_, index) => `thread-${index}`),
				},
			}),
		);
	});
});

async function createStore() {
	const root = await mkdtemp(join(tmpdir(), "meta-agent-project-store-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	const file = join(root, "state", "desktop-state.json");
	await mkdir(cwd);
	const store = new ProjectStore(file);
	await store.load();
	const project = await store.add(cwd);
	return { file, project, store };
}
