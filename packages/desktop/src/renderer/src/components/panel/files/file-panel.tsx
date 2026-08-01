import * as Tabs from "@radix-ui/react-tabs";
import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import type { HighlightResult } from "@streamdown/code";
import Eye from "lucide-react/dist/esm/icons/eye.mjs";
import FileCode2 from "lucide-react/dist/esm/icons/file-code-corner.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import PanelRightClose from "lucide-react/dist/esm/icons/panel-right-close.mjs";
import PanelRightOpen from "lucide-react/dist/esm/icons/panel-right-open.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import WrapText from "lucide-react/dist/esm/icons/wrap-text.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { FileNode, TextFile } from "../../../../../shared/contracts.ts";
import { errorMessage } from "../../../shared/lib/error-message.ts";
import { STREAMDOWN_COMPONENTS } from "../../assistant-ui/streamdown/streamdown-code.tsx";
import { resolveTokenStyle } from "../../assistant-ui/streamdown/streamdown-code-block.tsx";
import { LINK_SAFETY, SHIKI_THEMES, STREAMDOWN_PLUGINS } from "../../assistant-ui/streamdown/streamdown-config.ts";
import { useSessionScope, useSessionWorkbench } from "../../session-context.tsx";
import { closeWorkbenchFile, replaceActiveWorkbenchFile } from "../panel-model.ts";
import { highlightFileCode } from "./file-highlight-client.ts";
import { FilePathBreadcrumb } from "./file-path-breadcrumb.tsx";
import { FileTree } from "./file-tree.tsx";

const FILE_SEARCH_DELAY = 180;
const FILE_TREE_DEFAULT_WIDTH = 240;
const FILE_TREE_MIN_WIDTH = 180;
const FILE_TREE_MAX_WIDTH = 360;
const FILE_PREVIEW_MIN_WIDTH = 260;
/** panel 宽度低于该值时，未显式设置的会话默认收起文件树。 */
const FILE_TREE_COLLAPSE_BREAKPOINT = 520;

/** session 独立的文件预览和 Project cwd 文件树。 */
export function FilePanel() {
  const { record, updateWorkbench } = useSessionScope();
  const workbench = useSessionWorkbench();
  const projectId = record.identity.projectId;
  const activeFile = workbench?.activeFile ?? null;
  const openFiles = workbench?.openFiles ?? [];
  const expandedPaths = workbench?.expandedPaths ?? [];
  const fileTreeWidth = workbench?.fileTreeWidth ?? FILE_TREE_DEFAULT_WIDTH;
  const fileWrap = workbench?.fileWrapMode ?? false;
  const fileMarkdownPreview = workbench?.fileMarkdownPreview ?? false;
  const isMarkdown = /\.(md|markdown)$/iu.test(activeFile ?? "");
  const fileTreeCollapsed =
    workbench?.fileTreeCollapsed ?? (workbench?.panelWidth ?? 360) < FILE_TREE_COLLAPSE_BREAKPOINT;
  const fileTreeContentId = useId();
  const [query, setQuery] = useState("");
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [children, setChildren] = useState<Record<string, FileNode[]>>({});
  const [file, setFile] = useState<TextFile | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [highlight, setHighlight] = useState<{ file: TextFile; tokens: HighlightResult } | null>(null);
  const treeGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const highlightGeneration = useRef(0);
  const workspace = useRef<HTMLDivElement>(null);
  const activeProjectId = useRef(projectId);
  const directoryRequests = useRef(new Map<string, Promise<FileNode[]>>());
  const resize = useResizableRegion<HTMLElement>({
    value: fileTreeWidth,
    min: FILE_TREE_MIN_WIDTH,
    getMaxSize: () =>
      Math.min(
        FILE_TREE_MAX_WIDTH,
        (workspace.current?.clientWidth ?? FILE_TREE_MAX_WIDTH + FILE_PREVIEW_MIN_WIDTH) - FILE_PREVIEW_MIN_WIDTH,
      ),
    direction: -1,
    orientation: "vertical",
    constraintRef: workspace,
    onCommit: (nextFileTreeWidth) => {
      if (nextFileTreeWidth !== fileTreeWidth) updateWorkbench({ fileTreeWidth: nextFileTreeWidth });
    },
  });
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
          .list(projectId, "", query, "file-panel-root")
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

  useEffect(() => {
    const generation = ++highlightGeneration.current;
    setHighlight(null);
    if (!file) return;
    void highlightFileCode(file.content, file.language, SHIKI_THEMES).then((tokens) => {
      if (generation === highlightGeneration.current && tokens) {
        setHighlight({ file, tokens });
      }
    });
  }, [file]);

  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths]);

  const preview = useMemo(() => {
    if (!file) return null;
    if (fileMarkdownPreview && isMarkdown) {
      return (
        <div className="file-preview-markdown">
          <Streamdown
            mode="static"
            components={STREAMDOWN_COMPONENTS}
            plugins={STREAMDOWN_PLUGINS}
            linkSafety={LINK_SAFETY}
            shikiTheme={SHIKI_THEMES}
            className="aui-md"
          >
            {file.content}
          </Streamdown>
        </div>
      );
    }
    const lines = highlight?.file === file ? highlight.tokens.tokens : null;
    if (lines) {
      return (
        <pre
          tabIndex={0}
          aria-label={`${file.path} 内容`}
          data-language={file.language}
          data-wrap={fileWrap || undefined}
          style={
            {
              "--file-preview-line-number-width": `${Math.max(2, String(lines.length).length)}ch`,
            } as CSSProperties
          }
        >
          {lines.map((tokensOfLine, lineIndex) => (
            <span className="file-preview-line" key={lineIndex}>
              <span className="file-preview-line-number" aria-hidden="true">
                {lineIndex + 1}
              </span>
              <span className="file-preview-line-text">
                {tokensOfLine.length === 0
                  ? " "
                  : tokensOfLine.map((token, tokenIndex) => (
                      <span
                        className="file-preview-token"
                        key={`${tokenIndex}:${token.offset}`}
                        style={resolveTokenStyle(token)}
                      >
                        {token.content}
                      </span>
                    ))}
              </span>
            </span>
          ))}
        </pre>
      );
    }
    const plainLines = file.content.split("\n");
    return (
      <pre
        tabIndex={0}
        aria-label={`${file.path} 内容`}
        data-language={file.language}
        data-wrap={fileWrap || undefined}
        style={
          {
            "--file-preview-line-number-width": `${Math.max(2, String(plainLines.length).length)}ch`,
          } as CSSProperties
        }
      >
        {plainLines.map((line, lineIndex) => (
          <span className="file-preview-line" key={lineIndex}>
            <span className="file-preview-line-number" aria-hidden="true">
              {lineIndex + 1}
            </span>
            <span className="file-preview-line-text">{line}</span>
          </span>
        ))}
      </pre>
    );
  }, [file, fileWrap, fileMarkdownPreview, isMarkdown, highlight]);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!projectId || children[path] !== undefined) return;
      let request = directoryRequests.current.get(path);
      if (!request) {
        const created = window.desktop.files.list(projectId, path, "", `file-panel-directory:${path}`);
        directoryRequests.current.set(path, created);
        void created
          .finally(() => {
            if (directoryRequests.current.get(path) === created) directoryRequests.current.delete(path);
          })
          .catch(() => undefined);
        request = created;
      }
      try {
        const items = await request;
        if (activeProjectId.current !== projectId) return;
        setChildren((current) => ({ ...current, [path]: items }));
      } catch (value) {
        if (activeProjectId.current === projectId) setTreeError(errorMessage(value));
      }
    },
    [children, projectId],
  );

  useEffect(() => {
    for (const path of expandedPaths) void loadDirectory(path);
  }, [expandedPaths, loadDirectory]);

  const toggleDirectory = useCallback(
    async (node: FileNode) => {
      if (node.type !== "directory" || !projectId) return;
      const nextExpanded = new Set(expandedPaths);
      if (nextExpanded.delete(node.path)) {
        updateWorkbench({ expandedPaths: [...nextExpanded] });
        return;
      }
      nextExpanded.add(node.path);
      updateWorkbench({ expandedPaths: [...nextExpanded] });
      await loadDirectory(node.path);
    },
    [expandedPaths, loadDirectory, projectId, updateWorkbench],
  );

  const openNode = useCallback(
    (node: FileNode) => {
      if (node.type === "directory") {
        void toggleDirectory(node);
        return;
      }
      updateWorkbench({
        openFiles: openFiles.includes(node.path) ? [...openFiles] : [...openFiles, node.path],
        activeFile: node.path,
      });
    },
    [openFiles, toggleDirectory, updateWorkbench],
  );

  const closeFile = useCallback(
    (path: string) => {
      const next = closeWorkbenchFile(openFiles, activeFile, path);
      if (next) updateWorkbench(next);
    },
    [activeFile, openFiles, updateWorkbench],
  );

  const openBreadcrumbNode = useCallback(
    (node: FileNode) => {
      if (node.type === "directory") {
        void toggleDirectory(node);
        return;
      }
      updateWorkbench(replaceActiveWorkbenchFile(openFiles, activeFile, node.path));
    },
    [activeFile, openFiles, toggleDirectory, updateWorkbench],
  );

  if (!workbench) return null;

  return (
    <div ref={workspace} className="file-workspace">
      <Tabs.Root
        className="file-preview"
        value={activeFile ?? ""}
        orientation="horizontal"
        aria-label="打开的文件"
        onValueChange={(path) => updateWorkbench({ activeFile: path })}
      >
        {openFiles.length > 0 ? (
          <Tabs.List className="file-tabs" aria-label="打开的文件">
            {openFiles.map((path) => {
              const label = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
              return (
                <div key={path} className="file-tab-item" data-active={activeFile === path || undefined}>
                  <Tabs.Trigger className="file-tab-trigger" value={path} title={path}>
                    <FileCode2 size={14} aria-hidden="true" />
                    <span>{label}</span>
                  </Tabs.Trigger>
                  <button
                    type="button"
                    className="file-tab-close"
                    aria-label={`关闭 ${label}`}
                    onClick={() => closeFile(path)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <div className="file-tabs-actions">
              {isMarkdown ? (
                <TooltipIconButton
                  className="file-markdown-preview-toggle"
                  tooltip={fileMarkdownPreview ? "查看源码" : "预览 Markdown"}
                  aria-label={fileMarkdownPreview ? "查看源码" : "预览 Markdown"}
                  aria-pressed={fileMarkdownPreview}
                  data-active={fileMarkdownPreview || undefined}
                  onClick={() => updateWorkbench({ fileMarkdownPreview: !fileMarkdownPreview })}
                >
                  <Eye size={14} aria-hidden="true" />
                </TooltipIconButton>
              ) : null}
              {isMarkdown && fileMarkdownPreview ? null : (
                <TooltipIconButton
                  className="file-wrap-toggle"
                  tooltip={fileWrap ? "关闭换行" : "开启换行"}
                  aria-label={fileWrap ? "关闭换行" : "开启换行"}
                  aria-pressed={fileWrap}
                  data-active={fileWrap || undefined}
                  onClick={() => updateWorkbench({ fileWrapMode: !fileWrap })}
                >
                  <WrapText size={14} aria-hidden="true" />
                </TooltipIconButton>
              )}
            </div>
          </Tabs.List>
        ) : null}
        {activeFile ? (
          <FilePathBreadcrumb
            path={activeFile}
            children={children}
            expanded={expanded}
            onDirectoryOpen={(path) => void loadDirectory(path)}
            onOpen={openBreadcrumbNode}
          />
        ) : null}
        {openFiles.map((path) => (
          <Tabs.Content key={path} className="file-preview-content" value={path}>
            {fileError ? (
              <p className="panel-error" role="alert">
                {fileError}
              </p>
            ) : file?.path === path ? (
              preview
            ) : (
              <div className="file-preview-loading" aria-busy="true">
                正在读取文件
              </div>
            )}
          </Tabs.Content>
        ))}
        {openFiles.length === 0 ? (
          <div className="file-empty">
            <FolderOpen size={28} aria-hidden="true" />
            <strong>打开文件</strong>
            <span>从工作区目录树中选择文件</span>
          </div>
        ) : null}
      </Tabs.Root>
      <aside
        ref={resize.regionRef}
        className="file-tree-panel"
        data-collapsed={fileTreeCollapsed || undefined}
        style={{ "--resizable-region-size": `${resize.initialSize}px` } as CSSProperties}
        aria-label="项目文件"
      >
        <div
          ref={resize.separatorRef}
          className="resize-handle resize-handle-file-tree"
          role="separator"
          tabIndex={fileTreeCollapsed ? -1 : 0}
          aria-hidden={fileTreeCollapsed}
          aria-label="调整文件树宽度"
          aria-controls={fileTreeContentId}
          aria-orientation="vertical"
          aria-valuemin={FILE_TREE_MIN_WIDTH}
          aria-valuemax={resize.initialMax}
          aria-valuenow={resize.initialSize}
          aria-valuetext={`${resize.initialSize} 像素`}
          onPointerDown={resize.onPointerDown}
          onKeyDown={resize.onKeyDown}
        />
        <button
          type="button"
          className="file-tree-edge-trigger"
          tabIndex={fileTreeCollapsed ? 0 : -1}
          aria-hidden={!fileTreeCollapsed}
          aria-label="展开文件树"
          onClick={() => updateWorkbench({ fileTreeCollapsed: false })}
        />
        <div id={fileTreeContentId} className="file-tree-surface">
          <div className="file-tree-toolbar">
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
            <button
              type="button"
              className="file-tree-toggle"
              aria-label={fileTreeCollapsed ? "固定展开文件树" : "收起文件树"}
              aria-controls={fileTreeContentId}
              aria-expanded={!fileTreeCollapsed}
              onClick={() => updateWorkbench({ fileTreeCollapsed: !fileTreeCollapsed })}
            >
              {fileTreeCollapsed ? (
                <PanelRightOpen size={15} aria-hidden="true" />
              ) : (
                <PanelRightClose size={15} aria-hidden="true" />
              )}
            </button>
          </div>
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
        </div>
      </aside>
    </div>
  );
}
