import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Tabs from "@radix-ui/react-tabs";
import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import type { HighlightResult } from "@streamdown/code";
import Eye from "lucide-react/dist/esm/icons/eye.mjs";
import FileCode2 from "lucide-react/dist/esm/icons/file-code-corner.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import GitCompare from "lucide-react/dist/esm/icons/git-compare.mjs";
import Pin from "lucide-react/dist/esm/icons/pin.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import WrapText from "lucide-react/dist/esm/icons/wrap-text.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FileImage, FileNode, TextFile } from "../../../../../shared/contracts.ts";
import type { GitDiffHunk, GitHunkAction, GitResourceGroup } from "../../../../../shared/git-contracts.ts";
import { errorMessage } from "../../../shared/lib/error-message.ts";
import { ContextMenuContent } from "../../../shared/ui/context-menu-content.tsx";
import { ContextMenuItem } from "../../../shared/ui/context-menu-item.tsx";
import { SHIKI_THEMES } from "../../assistant-ui/streamdown/streamdown-config.ts";
import { StreamdownMarkdown } from "../../assistant-ui/streamdown/streamdown-markdown.tsx";
import { useSessionScope, useSessionWorkbench } from "../../session-context.tsx";
import { ExplorerModeSwitch, type ExplorerPanelMode } from "../explorer-mode-switch.tsx";
import {
  closeWorkbenchFile,
  isImagePath,
  missingExpandedDirectories,
  openWorkbenchFilePatch,
  parentPath,
  pinWorkbenchFile,
  replaceActiveWorkbenchFile,
} from "../panel-model.ts";
import { DiffView } from "../source-control/diff-view.tsx";
import { scmTreeExpansionKey } from "../source-control/scm-tree.ts";
import { SourceControlTree } from "../source-control/source-control-panel.tsx";
import { highlightFileCode } from "./file-highlight-client.ts";
import { FilePathBreadcrumb } from "./file-path-breadcrumb.tsx";
import { FilePreview } from "./file-preview.tsx";
import { FileTree } from "./file-tree.tsx";

const FILE_SEARCH_DELAY = 180;
/** 超过该字符数的文件跳过语法高亮（对齐 VS Code largeFileOptimizations）。 */
const LARGE_FILE_HIGHLIGHT_CHARS = 128 * 1024;
const FILE_TREE_DEFAULT_WIDTH = 240;
const FILE_TREE_MIN_WIDTH = 180;
const FILE_TREE_MAX_WIDTH = 360;
const FILE_PREVIEW_MIN_WIDTH = 260;

type DiffTabStatus = "loading" | "ready" | "error";

interface DiffTab {
  key: string;
  path: string;
  group: GitResourceGroup["kind"];
  status: DiffTabStatus;
  patch: string;
  hunks: GitDiffHunk[];
  errorMessage: string | null;
}

function fileTabKey(path: string): string {
  return `file:${path}`;
}

function diffTabKey(path: string, group: GitResourceGroup["kind"]): string {
  return `diff:${group}:${path}`;
}

/** session 独立的文件预览和 Project cwd 文件树。 */
export function FilePanel() {
  const { record, updateWorkbench } = useSessionScope();
  const workbench = useSessionWorkbench();
  const projectId = record.identity.projectId;
  const activeFile = workbench?.activeFile ?? null;
  const openFiles = workbench?.openFiles ?? [];
  const previewFile = workbench?.previewFile;
  const expandedPaths = workbench?.expandedPaths ?? [];
  const fileTreeWidth = workbench?.fileTreeWidth ?? FILE_TREE_DEFAULT_WIDTH;
  const fileWrap = workbench?.fileWrapMode ?? false;
  const fileMarkdownPreview = workbench?.fileMarkdownPreview ?? false;
  const isMarkdown = /\.(md|markdown)$/iu.test(activeFile ?? "");
  const fileTreeContentId = useId();
  const [panelMode, setPanelMode] = useState<ExplorerPanelMode>("files");
  const [diffTabs, setDiffTabs] = useState<DiffTab[]>([]);
  const [activeContentKey, setActiveContentKey] = useState("");
  const [query, setQuery] = useState("");
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [children, setChildren] = useState<Record<string, FileNode[]>>({});
  const [file, setFile] = useState<TextFile | FileImage | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [highlight, setHighlight] = useState<{
    file: TextFile;
    tokens: HighlightResult;
  } | null>(null);
  const [fileRevision, setFileRevision] = useState(0);
  const treeGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const diffRequestSequence = useRef(0);
  const diffRequests = useRef(new Map<string, number>());
  const diffTabsRef = useRef<DiffTab[]>([]);
  const showDiffRef = useRef<(path: string, group: GitResourceGroup["kind"], activate?: boolean) => Promise<void>>(
    async () => undefined,
  );
  const closeDiffTabRef = useRef<(key: string) => void>(() => undefined);
  const observedActiveFile = useRef<string | null>(null);
  const highlightGeneration = useRef(0);
  const workspace = useRef<HTMLDivElement>(null);
  const tabsListRef = useRef<HTMLDivElement>(null);
  const activeProjectId = useRef(projectId);
  const directoryRequests = useRef(new Map<string, Promise<FileNode[]>>());
  const childrenRef = useRef<Record<string, FileNode[]>>({});
  const activeFileRef = useRef<string | null>(null);
  const resize = useResizableRegion<HTMLElement>({
    value: fileTreeWidth,
    min: FILE_TREE_MIN_WIDTH,
    getMaxSize: () =>
      Math.min(
        FILE_TREE_MAX_WIDTH,
        (workspace.current?.clientWidth ?? FILE_TREE_MAX_WIDTH + FILE_PREVIEW_MIN_WIDTH) - FILE_PREVIEW_MIN_WIDTH,
      ),
    direction: 1,
    orientation: "vertical",
    constraintRef: workspace,
    onCommit: (nextFileTreeWidth) => {
      if (nextFileTreeWidth !== fileTreeWidth) updateWorkbench({ fileTreeWidth: nextFileTreeWidth });
    },
  });
  activeProjectId.current = projectId;
  diffTabsRef.current = diffTabs;

  useEffect(() => {
    const tabs = tabsListRef.current;
    if (!tabs) return;
    const onWheel = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      const maxScroll = tabs.scrollWidth - tabs.clientWidth;
      if (maxScroll <= 0) return;
      const canScroll = delta > 0 ? tabs.scrollLeft < maxScroll : tabs.scrollLeft > 0;
      if (!canScroll) return;
      tabs.scrollLeft = Math.max(0, Math.min(maxScroll, tabs.scrollLeft + delta));
      event.preventDefault();
    };
    tabs.addEventListener("wheel", onWheel, { passive: false });
    return () => tabs.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    setRoots([]);
    setChildren({});
    setFile(null);
    setTreeError(null);
    setFileError(null);
    setDiffTabs([]);
    diffRequests.current.clear();
    setActiveContentKey(activeFile ? fileTabKey(activeFile) : "");
    observedActiveFile.current = activeFile;
    directoryRequests.current.clear();
  }, [projectId]);

  useEffect(() => {
    const previous = observedActiveFile.current;
    observedActiveFile.current = activeFile;
    if (activeFile && activeFile !== previous) {
      setActiveContentKey(fileTabKey(activeFile));
    } else if (!activeFile && previous) {
      setActiveContentKey((current) => (current === fileTabKey(previous) ? (diffTabs.at(-1)?.key ?? "") : current));
    }
  }, [activeFile, diffTabs]);

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
    const request = isImagePath(activeFile)
      ? window.desktop.files.readImage(projectId, activeFile)
      : window.desktop.files.read(projectId, activeFile);
    void request
      .then((value) => {
        if (generation === fileGeneration.current) setFile(value);
      })
      .catch((value: unknown) => {
        if (generation === fileGeneration.current) setFileError(errorMessage(value));
      });
  }, [activeFile, fileRevision, projectId]);

  useEffect(() => {
    const generation = ++highlightGeneration.current;
    setHighlight(null);
    if (!file || "dataUrl" in file) return;
    // 大文件降级：跳过 Shiki 全量 tokenize（对齐 VS Code largeFileOptimizations）。
    if (file.content.length > LARGE_FILE_HIGHLIGHT_CHARS) return;
    void highlightFileCode(file.content, file.language, SHIKI_THEMES).then((tokens) => {
      if (generation === highlightGeneration.current && tokens) {
        setHighlight({ file, tokens });
      }
    });
  }, [file]);

  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths]);

  // 切换 tab 后恢复每个文件各自的滚动位置。
  // 必须在 preview memo 之前声明：useMemo 工厂同步执行，引用未初始化的块级变量会抛 TDZ 错误。
  const scrollPositions = useRef(new Map<string, number>());

  const preview = useMemo(() => {
    if (!file) return null;
    if ("dataUrl" in file) {
      return (
        <div className="file-preview-image-wrap">
          <img className="file-preview-image" src={file.dataUrl} alt={file.path} />
        </div>
      );
    }
    if (fileMarkdownPreview && isMarkdown) {
      return (
        <div className="file-preview-markdown">
          <StreamdownMarkdown>{file.content}</StreamdownMarkdown>
        </div>
      );
    }
    return (
      <FilePreview
        key={file.path}
        file={file}
        highlight={highlight}
        wrap={fileWrap}
        degraded={file.content.length > LARGE_FILE_HIGHLIGHT_CHARS}
        initialScrollTop={scrollPositions.current.get(file.path) ?? 0}
        onScrollChange={(top) => scrollPositions.current.set(file.path, top)}
      />
    );
  }, [file, fileWrap, fileMarkdownPreview, isMarkdown, highlight]);

  useEffect(() => {
    childrenRef.current = children;
    activeFileRef.current = activeFile;
  }, [activeFile, children]);

  // 目录加载：依赖仅 projectId（children 经 ref 读取），保持身份稳定，
  // 避免每次目录加载导致下方 onChanged/focus 监听重建。
  const loadDirectory = useCallback(
    async (path: string, force = false) => {
      if (!projectId) return;
      const existing = directoryRequests.current.get(path);
      if (!force && (existing || childrenRef.current[path] !== undefined)) return;
      const created = window.desktop.files.list(projectId, path, "", `file-panel-directory:${path}`);
      directoryRequests.current.set(path, created);
      try {
        const items = await created;
        if (activeProjectId.current !== projectId) return;
        if (directoryRequests.current.get(path) !== created) return;
        setChildren((current) => ({ ...current, [path]: items }));
      } catch (value) {
        if (activeProjectId.current === projectId && directoryRequests.current.get(path) === created) {
          setTreeError(errorMessage(value));
        }
      } finally {
        if (directoryRequests.current.get(path) === created) directoryRequests.current.delete(path);
      }
    },
    [projectId],
  );

  useEffect(() => {
    for (const path of expandedPaths) void loadDirectory(path);
  }, [expandedPaths, loadDirectory]);

  // 文件监听：已加载目录受新增/删除影响时增量刷新；活动文件被更新时自动重读。
  // 回调读取 ref，effect 仅在 projectId/loadDirectory 变化时重建。
  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = window.desktop.files.onChanged(projectId, (change) => {
      if (activeFileRef.current && change.updated.includes(activeFileRef.current)) {
        setFileRevision((revision) => revision + 1);
      }
      const loaded = new Set<string>(["", ...Object.keys(childrenRef.current)]);
      const affected = new Set<string>();
      for (const path of change.added) {
        const dir = parentPath(path);
        if (loaded.has(dir)) affected.add(dir);
      }
      for (const path of change.deleted) {
        const dir = parentPath(path);
        if (loaded.has(dir)) affected.add(dir);
        if (loaded.has(path)) {
          // 已展开目录本身被删除：清理其缓存并刷新父目录。
          setChildren((current) => {
            const next = { ...current };
            delete next[path];
            return next;
          });
          const parent = parentPath(path);
          if (loaded.has(parent)) affected.add(parent);
        }
      }
      for (const dir of affected) void loadDirectory(dir, true);
    });
    return unsubscribe;
  }, [loadDirectory, projectId]);

  // 窗口重新聚焦时刷新根目录，补偿失焦期间可能丢失的文件事件。
  useEffect(() => {
    const onFocus = () => void loadDirectory("", true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadDirectory]);

  // 面板可见期间保持主进程 watcher 引用。
  useEffect(() => {
    if (!projectId) return;
    void window.desktop.files.watch(projectId);
    return () => {
      void window.desktop.files.unwatch(projectId);
    };
  }, [projectId]);

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

  // 打开文件时展开其父目录链（对齐 VS Code explorer.autoReveal）。
  const openNode = useCallback(
    (node: FileNode) => {
      if (node.type === "directory") {
        void toggleDirectory(node);
        return;
      }
      if (!workbench) return;
      // 预览打开 + 父目录链展开合并为一次写入。
      updateWorkbench(openWorkbenchFilePatch(workbench, node.path));
      setActiveContentKey(fileTabKey(node.path));
    },
    [toggleDirectory, updateWorkbench, workbench],
  );

  const pinNode = useCallback(
    (node: FileNode) => {
      if (node.type === "directory") return;
      const patch = pinWorkbenchFile(previewFile, node.path);
      if (patch) updateWorkbench(patch);
    },
    [previewFile, updateWorkbench],
  );

  const closeFile = useCallback(
    (path: string) => {
      const next = closeWorkbenchFile(openFiles, activeFile, path);
      if (!next) return;
      scrollPositions.current.delete(path);
      updateWorkbench({
        ...next,
        ...(path === previewFile ? { previewFile: undefined } : {}),
      });
    },
    [activeFile, openFiles, previewFile, updateWorkbench],
  );

  const openBreadcrumbNode = useCallback(
    (node: FileNode) => {
      if (node.type === "directory") {
        void toggleDirectory(node);
        return;
      }
      const missing = missingExpandedDirectories(expandedPaths, node.path);
      const next = replaceActiveWorkbenchFile(openFiles, activeFile, node.path);
      // 活动 tab 替换 + 父目录链展开合并为一次写入。
      updateWorkbench({
        ...next,
        ...(activeFile === previewFile ? { previewFile: node.path } : {}),
        ...(missing ? { expandedPaths: [...expandedPaths, ...missing] } : {}),
      });
    },
    [activeFile, expandedPaths, openFiles, previewFile, toggleDirectory, updateWorkbench],
  );

  // 文件树右键菜单（对齐 VS Code explorer 上下文操作）。
  const renderFileContextMenu = useCallback(
    (node: FileNode) => {
      const isDirectory = node.type === "directory";
      return (
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem
            onSelect={() => {
              void window.desktop.files.resolvePath(projectId, node.path).then((absolute) => {
                void navigator.clipboard.writeText(absolute);
              });
            }}
          >
            复制路径
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void window.desktop.files.open(projectId, node.path)}>
            在系统文件管理器中显示
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void loadDirectory(isDirectory ? node.path : parentPath(node.path), true)}>
            刷新
          </ContextMenuItem>
        </ContextMenuContent>
      );
    },
    [loadDirectory, projectId],
  );

  const closeDiffTab = useCallback(
    (key: string) => {
      const nextActiveDiff = diffTabs.filter((tab) => tab.key !== key).at(-1)?.key ?? "";
      diffRequests.current.delete(key);
      setDiffTabs((current) => current.filter((tab) => tab.key !== key));
      setActiveContentKey((current) => {
        if (current !== key) return current;
        return activeFile ? fileTabKey(activeFile) : nextActiveDiff;
      });
    },
    [activeFile, diffTabs],
  );

  const showDiff = useCallback(
    async (path: string, group: GitResourceGroup["kind"], activate = true) => {
      const key = diffTabKey(path, group);
      const requestId = ++diffRequestSequence.current;
      diffRequests.current.set(key, requestId);
      if (activate) setActiveContentKey(key);
      setDiffTabs((current) => {
        const loading: DiffTab = {
          key,
          path,
          group,
          status: "loading",
          patch: "",
          hunks: [],
          errorMessage: null,
        };
        const index = current.findIndex((tab) => tab.key === key);
        return index < 0 ? [...current, loading] : current.map((tab) => (tab.key === key ? loading : tab));
      });

      try {
        const input = { projectId, path, staged: group === "staged" };
        const result =
          group === "untracked" ? await window.desktop.git.diffUntracked(input) : await window.desktop.git.diff(input);
        if (diffRequests.current.get(key) !== requestId) return;
        if (!result.ok) {
          if (result.reason === "no-diff") {
            closeDiffTab(key);
            return;
          }
          setDiffTabs((current) =>
            current.map((tab) => (tab.key === key ? { ...tab, status: "error", errorMessage: result.message } : tab)),
          );
          return;
        }
        setDiffTabs((current) =>
          current.map((tab) =>
            tab.key === key
              ? {
                  ...tab,
                  status: "ready",
                  patch: result.patch,
                  hunks: result.hunks,
                  errorMessage: null,
                }
              : tab,
          ),
        );
      } catch (error) {
        if (diffRequests.current.get(key) !== requestId) return;
        setDiffTabs((current) =>
          current.map((tab) =>
            tab.key === key ? { ...tab, status: "error", errorMessage: errorMessage(error) } : tab,
          ),
        );
      }
    },
    [closeDiffTab, projectId],
  );

  showDiffRef.current = showDiff;
  closeDiffTabRef.current = closeDiffTab;

  useEffect(() => {
    let active = true;
    void window.desktop.git.watch(projectId);
    const unsubscribe = window.desktop.git.onStatusChanged(projectId, () => {
      void window.desktop.git.getStatus(projectId).then((result) => {
        if (!active || !result.ok) return;
        const available = new Set(
          result.state.groups.flatMap((group) => group.changes.map((change) => diffTabKey(change.path, group.kind))),
        );
        for (const tab of diffTabsRef.current) {
          if (available.has(tab.key)) void showDiffRef.current(tab.path, tab.group, false);
          else closeDiffTabRef.current(tab.key);
        }
      });
    });
    return () => {
      active = false;
      unsubscribe();
      void window.desktop.git.unwatch(projectId);
    };
  }, [projectId]);

  const applyDiffHunk = useCallback(
    async (tab: DiffTab, action: GitHunkAction, hunkId: string) => {
      const result = await window.desktop.git.applyHunk({
        projectId,
        path: tab.path,
        hunkId,
        action,
        untracked: tab.group === "untracked",
      });
      if (!result.ok) throw new Error(result.message);
      if (tab.group === "untracked" && action === "stage") {
        closeDiffTab(tab.key);
        return;
      }
      await showDiff(tab.path, tab.group);
    },
    [closeDiffTab, projectId, showDiff],
  );

  const openScmFile = useCallback(
    (path: string) => {
      if (!workbench) return;
      updateWorkbench(openWorkbenchFilePatch(workbench, path));
      setActiveContentKey(fileTabKey(path));
    },
    [updateWorkbench, workbench],
  );

  const activeDiffTab = diffTabs.find((tab) => tab.key === activeContentKey) ?? null;
  const selectedScmKey = activeDiffTab ? scmTreeExpansionKey(activeDiffTab.group, activeDiffTab.path) : null;
  const activeContentIsFile = activeFile !== null && activeContentKey === fileTabKey(activeFile);
  const hasPreviewTabs = openFiles.length > 0 || diffTabs.length > 0;

  if (!workbench) return null;

  return (
    <div ref={workspace} className="file-workspace">
      <aside
        ref={resize.regionRef}
        className="file-tree-panel"
        style={
          {
            "--resizable-region-size": `${resize.initialSize}px`,
          } as CSSProperties
        }
        aria-label="项目文件"
      >
        <div
          ref={resize.separatorRef}
          className="resize-handle resize-handle-file-tree"
          role="separator"
          tabIndex={0}
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
        {panelMode === "files" ? (
          <div id={fileTreeContentId} className="file-tree-surface">
            <div className="file-tree-toolbar">
              <ExplorerModeSwitch value="files" onValueChange={setPanelMode} />
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
                  onPinOpen={pinNode}
                  renderContextMenu={renderFileContextMenu}
                />
              )}
            </div>
          </div>
        ) : (
          <SourceControlTree
            contentId={fileTreeContentId}
            projectId={projectId}
            selectedKey={selectedScmKey}
            onModeChange={setPanelMode}
            onSelect={(path, group) => void showDiff(path, group)}
            onOpenFile={openScmFile}
          />
        )}
      </aside>
      <Tabs.Root
        className="file-preview"
        value={activeContentKey}
        orientation="horizontal"
        aria-label="文件与差异预览"
        onValueChange={(key) => {
          setActiveContentKey(key);
          const path = openFiles.find((candidate) => fileTabKey(candidate) === key);
          if (path) updateWorkbench({ activeFile: path });
        }}
      >
        {hasPreviewTabs ? (
          <Tabs.List ref={tabsListRef} className="file-tabs" aria-label="文件与差异预览">
            {openFiles.map((path) => {
              const label = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
              const isPreview = path === previewFile;
              return (
                <div
                  key={path}
                  className="file-tab-item"
                  data-active={activeContentKey === fileTabKey(path) || undefined}
                  data-preview={isPreview || undefined}
                >
                  <Tabs.Trigger
                    className="file-tab-trigger"
                    value={fileTabKey(path)}
                    title={path}
                    onDoubleClick={() => {
                      const patch = pinWorkbenchFile(previewFile, path);
                      if (patch) updateWorkbench(patch);
                    }}
                  >
                    <FileCode2 size={14} aria-hidden="true" />
                    <span>{label}</span>
                  </Tabs.Trigger>
                  {isPreview ? (
                    <button
                      type="button"
                      className="file-tab-pin"
                      aria-label={`固定 ${label}`}
                      title="固定标签页"
                      onClick={() => updateWorkbench({ previewFile: undefined })}
                    >
                      <Pin size={12} aria-hidden="true" />
                    </button>
                  ) : null}
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
            {diffTabs.map((tab) => {
              const label = tab.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? tab.path;
              const scopeLabel = tab.group === "staged" ? "已暂存" : tab.group === "untracked" ? "未跟踪" : "工作区";
              return (
                <div
                  key={tab.key}
                  className="file-tab-item"
                  data-active={activeContentKey === tab.key || undefined}
                  data-diff="true"
                >
                  <Tabs.Trigger className="file-tab-trigger" value={tab.key} title={`${tab.path} · ${scopeLabel}`}>
                    <GitCompare size={14} aria-hidden="true" />
                    <span>{label}</span>
                    <span className="file-tab-diff-scope">{scopeLabel}</span>
                  </Tabs.Trigger>
                  <button
                    type="button"
                    className="file-tab-close"
                    aria-label={`关闭 ${label} 差异`}
                    onClick={() => closeDiffTab(tab.key)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <div className="file-tabs-actions">
              {activeContentIsFile && isMarkdown ? (
                <TooltipIconButton
                  className="file-markdown-preview-toggle"
                  tooltip={fileMarkdownPreview ? "查看源码" : "预览 Markdown"}
                  aria-label={fileMarkdownPreview ? "查看源码" : "预览 Markdown"}
                  aria-pressed={fileMarkdownPreview}
                  data-active={fileMarkdownPreview || undefined}
                  onClick={() =>
                    updateWorkbench({
                      fileMarkdownPreview: !fileMarkdownPreview,
                    })
                  }
                >
                  <Eye size={14} aria-hidden="true" />
                </TooltipIconButton>
              ) : null}
              {activeContentIsFile && isMarkdown && fileMarkdownPreview ? null : activeContentIsFile ? (
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
              ) : null}
            </div>
          </Tabs.List>
        ) : null}
        {activeContentIsFile && activeFile ? (
          <FilePathBreadcrumb
            path={activeFile}
            children={children}
            expanded={expanded}
            onDirectoryOpen={(path) => void loadDirectory(path)}
            onOpen={openBreadcrumbNode}
            onPinOpen={pinNode}
          />
        ) : null}
        {openFiles.map((path) => (
          <Tabs.Content key={path} className="file-preview-content" value={fileTabKey(path)}>
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
        {diffTabs.map((tab) => (
          <Tabs.Content key={tab.key} className="file-preview-content" value={tab.key}>
            {tab.status === "loading" ? (
              <div className="file-preview-loading" aria-busy="true">
                正在读取差异
              </div>
            ) : tab.status === "error" ? (
              <p className="panel-error" role="alert">
                {tab.errorMessage ?? "无法读取差异"}
              </p>
            ) : (
              <DiffView
                path={tab.path}
                group={tab.group}
                patch={tab.patch}
                hunks={tab.hunks}
                onClose={() => closeDiffTab(tab.key)}
                onHunkAction={(action, hunkId) => applyDiffHunk(tab, action, hunkId)}
              />
            )}
          </Tabs.Content>
        ))}
        {!hasPreviewTabs ? (
          <div className="file-empty">
            <FolderOpen size={28} aria-hidden="true" />
            <strong>打开文件</strong>
            <span>从左侧文件或源代码管理树中选择内容</span>
          </div>
        ) : null}
      </Tabs.Root>
    </div>
  );
}
