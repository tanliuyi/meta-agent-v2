import { ChevronDown, ChevronRight, File, FileCode2, Folder, FolderOpen, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { FileNode, TextFile } from "../../../../shared/contracts.ts";
import { useDesktop } from "../../state/desktop-context.tsx";

/** session 独立的文件预览和 Project cwd 文件树。 */
export function FilePanel() {
	const { project, workbench, updateWorkbench } = useDesktop();
	const [query, setQuery] = useState("");
	const [roots, setRoots] = useState<FileNode[]>([]);
	const [children, setChildren] = useState<Record<string, FileNode[]>>({});
	const [file, setFile] = useState<TextFile | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!project) return;
		let active = true;
		void window.desktop.files
			.list(project.id, "", query)
			.then((items) => {
				if (active) setRoots(items);
			})
			.catch((value: unknown) => {
				if (active) setError(errorMessage(value));
			});
		return () => {
			active = false;
		};
	}, [project, query]);

	useEffect(() => {
		if (!project || !workbench?.activeFile) {
			setFile(null);
			return;
		}
		let active = true;
		setFile(null);
		setError(null);
		void window.desktop.files
			.read(project.id, workbench.activeFile)
			.then((value) => {
				if (active) setFile(value);
			})
			.catch((value: unknown) => {
				if (active) setError(errorMessage(value));
			});
		return () => {
			active = false;
		};
	}, [project, workbench?.activeFile]);

	if (!project || !workbench) return null;

	const toggle = async (node: FileNode) => {
		if (node.type !== "directory") return;
		const expanded = new Set(workbench.expandedPaths);
		if (expanded.has(node.path)) expanded.delete(node.path);
		else {
			expanded.add(node.path);
			if (!children[node.path]) {
				const items = await window.desktop.files.list(project.id, node.path);
				setChildren((current) => ({ ...current, [node.path]: items }));
			}
		}
		updateWorkbench({ expandedPaths: [...expanded] });
	};

	const open = (node: FileNode) => {
		if (node.type === "directory") {
			void toggle(node);
			return;
		}
		const openFiles = workbench.openFiles.includes(node.path) ? workbench.openFiles : [...workbench.openFiles, node.path];
		updateWorkbench({ openFiles, activeFile: node.path });
	};

	return (
		<div className="file-workspace">
			<section className="file-preview">
				{file ? (
					<>
						<header>
							<FileCode2 size={14} />
							<span>{file.path}</span>
						</header>
						<pre data-language={file.language}>{file.content}</pre>
					</>
				) : (
					<div className="file-empty">
						<FolderOpen size={28} />
						<strong>打开文件</strong>
						<span>从工作区目录树中选择文件</span>
					</div>
				)}
			</section>
			<aside className="file-tree-panel">
				<label className="file-search">
					<Search size={14} />
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选文件..." />
				</label>
				{error ? <p className="panel-error">{error}</p> : null}
				<div className="file-tree">
					<FileTree
						nodes={roots}
						children={children}
						expanded={new Set(workbench.expandedPaths)}
						active={workbench.activeFile}
						onOpen={open}
					/>
				</div>
			</aside>
		</div>
	);
}

interface FileTreeProps {
	nodes: FileNode[];
	children: Record<string, FileNode[]>;
	expanded: Set<string>;
	active?: string;
	onOpen(node: FileNode): void;
	depth?: number;
}

function FileTree({ nodes, children, expanded, active, onOpen, depth = 0 }: FileTreeProps) {
	return nodes.map((node) => {
		const open = expanded.has(node.path);
		return (
			<div key={node.path}>
				<button
					type="button"
					className={active === node.path ? "file-row is-active" : "file-row"}
					style={{ paddingLeft: 8 + depth * 14 }}
					onClick={() => onOpen(node)}
				>
					{node.type === "directory" ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="file-spacer" />}
					{node.type === "directory" ? open ? <FolderOpen size={14} /> : <Folder size={14} /> : <File size={14} />}
					<span>{node.name}</span>
				</button>
				{node.type === "directory" && open && children[node.path] ? (
					<FileTree nodes={children[node.path]} children={children} expanded={expanded} active={active} onOpen={onOpen} depth={depth + 1} />
				) : null}
			</div>
		);
	});
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
