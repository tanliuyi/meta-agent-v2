import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { FileNode, TextFile } from "../../shared/contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;

/** 只允许访问已注册 Project cwd 内部文件的工作区文件服务。 */
export class FileService {
	private readonly projects: ProjectStore;

	constructor(projects: ProjectStore) {
		this.projects = projects;
	}

	/** 列出目录；提供 query 时在 Project 内执行有上限的名称搜索。 */
	async list(projectId: string, path = "", query = ""): Promise<FileNode[]> {
		const cwd = this.projects.getCwd(projectId);
		if (query.trim()) return this.search(cwd, query.trim().toLowerCase());
		const target = resolveInside(cwd, path);
		const entries = await readdir(target, { withFileTypes: true });
		return Promise.all(
			entries
				.sort(
					(left, right) =>
						Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name),
				)
				.map(async (entry) => {
					const child = resolve(target, entry.name);
					return {
						name: entry.name,
						path: normalizeRelative(relative(cwd, child)),
						type: entry.isDirectory() ? "directory" : "file",
						hasChildren: entry.isDirectory() ? await directoryHasChildren(child) : undefined,
					} satisfies FileNode;
				}),
		);
	}

	/** 读取 Project 内的小型 UTF-8 文本文件。 */
	async read(projectId: string, path: string): Promise<TextFile> {
		const cwd = this.projects.getCwd(projectId);
		const target = resolveInside(cwd, path);
		const info = await stat(target);
		if (!info.isFile()) throw new Error("目标不是文件");
		if (info.size > MAX_FILE_BYTES) throw new Error("文件超过 1 MiB，无法在工作台预览");
		return {
			path: normalizeRelative(relative(cwd, target)),
			content: await readFile(target, "utf8"),
			language: languageOf(target),
		};
	}

	private async search(cwd: string, query: string): Promise<FileNode[]> {
		const results: FileNode[] = [];
		const pending = [cwd];
		while (pending.length > 0 && results.length < MAX_SEARCH_RESULTS) {
			const folder = pending.pop();
			if (!folder) break;
			for (const entry of await readdir(folder, { withFileTypes: true })) {
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				const target = resolve(folder, entry.name);
				if (entry.isDirectory()) pending.push(target);
				if (!entry.name.toLowerCase().includes(query)) continue;
				results.push({
					name: entry.name,
					path: normalizeRelative(relative(cwd, target)),
					type: entry.isDirectory() ? "directory" : "file",
					hasChildren: entry.isDirectory(),
				});
				if (results.length >= MAX_SEARCH_RESULTS) break;
			}
		}
		return results;
	}
}

function resolveInside(cwd: string, path: string): string {
	const target = resolve(cwd, path);
	const child = relative(cwd, target);
	if (child === ".." || child.startsWith(`..${sep}`) || resolve(target) === resolve(cwd, "..")) {
		throw new Error("文件路径超出 Project cwd");
	}
	return target;
}

async function directoryHasChildren(path: string): Promise<boolean> {
	return (await readdir(path)).length > 0;
}

function normalizeRelative(path: string): string {
	return path.split(sep).join("/");
}

function languageOf(path: string): string {
	const extension = extname(path).slice(1).toLowerCase();
	return extension || "text";
}
