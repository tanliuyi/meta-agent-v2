import FileCode2 from "lucide-react/dist/esm/icons/file-code-corner.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileNode, TextFile } from "../../../../shared/contracts.ts";
import { errorMessage } from "../../shared/lib/error-message.ts";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import {
  selectActiveExpandedPaths,
  selectActiveFile,
  selectActiveOpenFiles,
  selectActiveProjectId,
  selectHasActiveWorkbench,
} from "../../state/desktop-selectors.ts";
import { FileTree } from "./file-tree.tsx";

const FILE_SEARCH_DELAY = 180;

/** session 独立的文件预览和 Project cwd 文件树。 */
export function FilePanel() {
  const actions = useDesktopActions();
  const projectId = useDesktopSelector(selectActiveProjectId);
  const hasWorkbench = useDesktopSelector(selectHasActiveWorkbench);
  const activeFile = useDesktopSelector(selectActiveFile);
  const openFiles = useDesktopSelector(selectActiveOpenFiles);
  const expandedPaths = useDesktopSelector(selectActiveExpandedPaths);
  const [query, setQuery] = useState("");
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [children, setChildren] = useState<Record<string, FileNode[]>>({});
  const [file, setFile] = useState<TextFile | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const treeGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const activeProjectId = useRef(projectId);
  const directoryRequests = useRef(new Map<string, Promise<FileNode[]>>());
  activeProjectId.current = projectId;

  useEffect(() => {
    setRoots([]);
    setChildren({});
    setFile(null);
    setTreeError(null);
    setFileError(null);
    directoryRequests.current.clear();
  }, [projectId]);

  useEffect(() => {
    const generation = ++treeGeneration.current;
    setTreeError(null);
    if (!projectId) {
      setRoots([]);
      setTreeLoading(false);
      return;
    }
    setTreeLoading(true);
    const timeout = window.setTimeout(
      () => {
        void window.desktop.files
          .list(projectId, "", query)
          .then((items) => {
            if (generation === treeGeneration.current) setRoots(items);
          })
          .catch((value: unknown) => {
            if (generation === treeGeneration.current) setTreeError(errorMessage(value));
          })
          .finally(() => {
            if (generation === treeGeneration.current) setTreeLoading(false);
          });
      },
      query ? FILE_SEARCH_DELAY : 0,
    );
    return () => window.clearTimeout(timeout);
  }, [projectId, query]);

  useEffect(() => {
    const generation = ++fileGeneration.current;
    setFileError(null);
    if (!projectId || !activeFile) {
      setFile(null);
      return;
    }
    setFile(null);
    void window.desktop.files
      .read(projectId, activeFile)
      .then((value) => {
        if (generation === fileGeneration.current) setFile(value);
      })
      .catch((value: unknown) => {
        if (generation === fileGeneration.current) setFileError(errorMessage(value));
      });
  }, [activeFile, projectId]);

  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths]);

  const toggleDirectory = useCallback(
    async (node: FileNode) => {
      if (node.type !== "directory" || !projectId) return;
      const nextExpanded = new Set(expandedPaths);
      if (nextExpanded.delete(node.path)) {
        actions.updateWorkbench({ expandedPaths: [...nextExpanded] });
        return;
      }
      nextExpanded.add(node.path);
      actions.updateWorkbench({ expandedPaths: [...nextExpanded] });
      if (children[node.path]) return;

      let request = directoryRequests.current.get(node.path);
      if (!request) {
        request = window.desktop.files
          .list(projectId, node.path)
          .finally(() => directoryRequests.current.delete(node.path));
        directoryRequests.current.set(node.path, request);
      }
      try {
        const items = await request;
        if (activeProjectId.current !== projectId) return;
        setChildren((current) => ({ ...current, [node.path]: items }));
      } catch (value) {
        if (activeProjectId.current === projectId) setTreeError(errorMessage(value));
      }
    },
    [actions, children, expandedPaths, projectId],
  );

  const openNode = useCallback(
    (node: FileNode) => {
      if (node.type === "directory") {
        void toggleDirectory(node);
        return;
      }
      actions.updateWorkbench({
        openFiles: openFiles.includes(node.path) ? [...openFiles] : [...openFiles, node.path],
        activeFile: node.path,
      });
    },
    [actions, openFiles, toggleDirectory],
  );

  if (!projectId || !hasWorkbench) return null;

  return (
    <div className="file-workspace">
      <section className="file-preview" aria-label="文件预览">
        {fileError ? (
          <p className="panel-error" role="alert">
            {fileError}
          </p>
        ) : file ? (
          <>
            <header>
              <FileCode2 size={14} aria-hidden="true" />
              <span title={file.path}>{file.path}</span>
            </header>
            <pre tabIndex={0} aria-label={`${file.path} 内容`} data-language={file.language}>
              {file.content}
            </pre>
          </>
        ) : (
          <div className="file-empty">
            <FolderOpen size={28} aria-hidden="true" />
            <strong>打开文件</strong>
            <span>从工作区目录树中选择文件</span>
          </div>
        )}
      </section>
      <aside className="file-tree-panel" aria-label="项目文件">
        <label className="file-search">
          <Search size={14} aria-hidden="true" />
          <span className="sr-only">筛选文件</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选文件..."
          />
        </label>
        {treeError ? (
          <p className="panel-error" role="alert">
            {treeError}
          </p>
        ) : null}
        <div className="file-tree" aria-busy={treeLoading}>
          {treeLoading && roots.length === 0 ? (
            <p className="file-tree-status" role="status">
              正在加载文件
            </p>
          ) : (
            <FileTree
              nodes={roots}
              children={children}
              expanded={expanded}
              active={activeFile ?? undefined}
              onOpen={openNode}
            />
          )}
        </div>
      </aside>
    </div>
  );
}
