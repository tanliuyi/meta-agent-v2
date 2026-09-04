import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import Eye from "lucide-react/dist/esm/icons/eye.mjs";
import FileCode2 from "lucide-react/dist/esm/icons/file-code-2.mjs";
import Files from "lucide-react/dist/esm/icons/files.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import WrapText from "lucide-react/dist/esm/icons/wrap-text.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { WorkbenchState } from "../../../shared/contracts.ts";

import { useSessionScope, useSessionWorkbenchSelector } from "../session-context.tsx";
import { FilePanel } from "./files/file-panel.tsx";
import { FileWorkspaceLayout } from "./files/file-workspace-layout.tsx";

import {
  activateProjectDocumentTab,
  closeProjectDocumentTab,
  closeWorkbenchFile,
  isOfficeDocumentPath,
  isPdfPath,
  moveProjectDocumentTab,
  openPinnedWorkbenchFile,
  openProjectDocumentTab,
  PROJECT_EDITOR_TAB_DRAG_MIME,
  PROJECT_FILE_DRAG_MIME,
  reconcileProjectDocumentTabs,
} from "./panel-model.ts";
import { ScmPanel, type ScmPanelHandle } from "./scm/scm-panel.tsx";

type ProjectDocumentTab =
  | { kind: "file"; key: string; path: string; label: string }
  | { kind: "diff"; key: string; path: string; staged: boolean; label: string };

const EMPTY_KEYS: string[] = [];
const EMPTY_SCM_RESOURCES: NonNullable<WorkbenchState["scm"]>["openResources"] = [];

function diffKey(staged: boolean, path: string): string {
  return `diff:${staged}:${path}`;
}

interface ProjectViewContainerProps {
  view: "files" | "scm";
  sidebarOpen: boolean;
  onChange(view: "files" | "scm"): void;
  children: ReactNode;
}

function ProjectViewContainer({ view, sidebarOpen, onChange, children }: ProjectViewContainerProps) {
  return (
    <section className="project-view-container" aria-label="项目视图" data-sidebar-open={sidebarOpen || undefined}>
      <div className="project-panel-switcher" role="tablist" aria-label="项目视图">
        <button
          type="button"
          className="project-panel-switcher-button"
          role="tab"
          aria-label="资源管理"
          title={view === "files" && sidebarOpen ? "隐藏资源管理" : "资源管理"}
          aria-selected={view === "files" && sidebarOpen}
          aria-expanded={view === "files" && sidebarOpen}
          data-active={(view === "files" && sidebarOpen) || undefined}
          onClick={() => onChange("files")}
        >
          <Files size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="project-panel-switcher-button"
          role="tab"
          aria-label="审查"
          title={view === "scm" && sidebarOpen ? "隐藏审查" : "审查"}
          aria-selected={view === "scm" && sidebarOpen}
          aria-expanded={view === "scm" && sidebarOpen}
          data-active={(view === "scm" && sidebarOpen) || undefined}
          onClick={() => onChange("scm")}
        >
          <GitBranch size={16} aria-hidden="true" />
        </button>
      </div>
      {children}
    </section>
  );
}

interface ProjectEditorGroupProps {
  tabs: readonly ProjectDocumentTab[];
  activeKey: string | undefined;
  previewFile: string | undefined;
  onSelect(tab: ProjectDocumentTab): void;
  onClose(tab: ProjectDocumentTab): void;
  onPin(tab: ProjectDocumentTab): void;
  onMove(sourceKey: string, targetKey: string): void;
  onOpenFile(path: string, targetKey?: string): void;
  actions?: ReactNode;
  children: ReactNode;
}

function ProjectEditorGroup({
  tabs,
  activeKey,
  previewFile,
  onSelect,
  onClose,
  onPin,
  onMove,
  onOpenFile,
  actions,
  children,
}: ProjectEditorGroupProps) {
  const tabElements = useRef(new Map<string, HTMLButtonElement>());
  const contentElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tabElements.current.get(activeKey ?? "")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  const navigate = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let targetIndex: number | undefined;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        targetIndex = index - 1;
        break;
      case "ArrowRight":
      case "ArrowDown":
        targetIndex = index + 1;
        break;
      case "Home":
        targetIndex = 0;
        break;
      case "End":
        targetIndex = tabs.length - 1;
        break;
    }
    const target = targetIndex === undefined ? undefined : tabs[targetIndex];
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(target);
    tabElements.current.get(target.key)?.focus();
  };

  const dropTab = (event: ReactDragEvent, targetKey: string) => {
    const path = event.dataTransfer.getData(PROJECT_FILE_DRAG_MIME);
    if (path) {
      event.preventDefault();
      event.stopPropagation();
      onOpenFile(path, targetKey);
      return;
    }
    const sourceKey = event.dataTransfer.getData(PROJECT_EDITOR_TAB_DRAG_MIME);
    if (!sourceKey) return;
    event.preventDefault();
    event.stopPropagation();
    onMove(sourceKey, targetKey);
  };

  const acceptsFile = (types: readonly string[]) => Array.from(types).includes(PROJECT_FILE_DRAG_MIME);

  useEffect(() => {
    const element = contentElement.current;
    if (!element) return;
    const dragOver = (event: DragEvent) => {
      if (!acceptsFile(event.dataTransfer?.types ?? [])) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      const path = event.dataTransfer?.getData(PROJECT_FILE_DRAG_MIME);
      if (!path) return;
      event.preventDefault();
      onOpenFile(path);
    };
    element.addEventListener("dragover", dragOver);
    element.addEventListener("drop", drop);
    return () => {
      element.removeEventListener("dragover", dragOver);
      element.removeEventListener("drop", drop);
    };
  }, [onOpenFile]);

  const scrollTabs = (event: ReactWheelEvent<HTMLDivElement>) => {
    const tabs = event.currentTarget;
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    const maxScroll = tabs.scrollWidth - tabs.clientWidth;
    if (delta === 0 || maxScroll <= 0) return;
    const next = Math.max(0, Math.min(maxScroll, tabs.scrollLeft + delta));
    if (next === tabs.scrollLeft) return;
    tabs.scrollLeft = next;
    event.preventDefault();
  };

  return (
    <section className="project-editor-group" aria-label="编辑器组">
      <div
        className="project-document-tabs"
        role="tablist"
        aria-label="打开的文件和差异"
        onWheel={scrollTabs}
        onDragOver={(event) => {
          if (!acceptsFile(event.dataTransfer.types)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          const path = event.dataTransfer.getData(PROJECT_FILE_DRAG_MIME);
          if (!path) return;
          event.preventDefault();
          onOpenFile(path);
        }}
      >
        {tabs.map((tab, index) => {
          const active = activeKey === tab.key;
          const preview = tab.kind === "file" && previewFile === tab.path;
          return (
            <div
              key={tab.key}
              className="file-tab-item"
              data-active={active || undefined}
              data-preview={preview || undefined}
              draggable
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                onClose(tab);
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PROJECT_EDITOR_TAB_DRAG_MIME, tab.key);
              }}
              onDragOver={(event) => {
                const file = acceptsFile(event.dataTransfer.types);
                if (!file && !Array.from(event.dataTransfer.types).includes(PROJECT_EDITOR_TAB_DRAG_MIME)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = file ? "copy" : "move";
              }}
              onDrop={(event) => dropTab(event, tab.key)}
            >
              <button
                ref={(element) => {
                  if (element) tabElements.current.set(tab.key, element);
                  else tabElements.current.delete(tab.key);
                }}
                type="button"
                className="file-tab-trigger"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(tab)}
                onDoubleClick={() => onPin(tab)}
                onKeyUp={(event) => navigate(event, index)}
                title={tab.path}
              >
                {tab.kind === "diff" ? (
                  <GitBranch size={14} aria-hidden="true" />
                ) : (
                  <FileCode2 size={14} aria-hidden="true" />
                )}
                <span>{tab.label}</span>
              </button>
              <button
                type="button"
                className="file-tab-close"
                aria-label={`关闭 ${tab.label}`}
                draggable={false}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab);
                }}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {actions ? <div className="file-tabs-actions">{actions}</div> : null}
      </div>
      <div ref={contentElement} className="project-panel-content" role="tabpanel">
        {children}
      </div>
    </section>
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** VS Code-style shared editor group for files and source-control diffs. */
export function ProjectPanel() {
  const { record, updateWorkbench } = useSessionScope();
  const view = useSessionWorkbenchSelector((workbench) => workbench?.projectPanelView ?? "files");
  const sidebarOpen = useSessionWorkbenchSelector((workbench) => workbench?.projectPanelSidebarOpen ?? true);
  const openFiles = useSessionWorkbenchSelector((workbench) => workbench?.openFiles ?? []);
  const activeFile = useSessionWorkbenchSelector((workbench) => workbench?.activeFile);
  const previewFile = useSessionWorkbenchSelector((workbench) => workbench?.previewFile);
  const fileWrap = useSessionWorkbenchSelector((workbench) => workbench?.fileWrapMode ?? false);
  const fileMarkdownPreview = useSessionWorkbenchSelector((workbench) => workbench?.fileMarkdownPreview ?? false);
  const activeDocumentTab = useSessionWorkbenchSelector((workbench) => workbench?.projectPanelActiveTab);
  const storedTabOrder = useSessionWorkbenchSelector((workbench) => workbench?.projectPanelTabs ?? EMPTY_KEYS);
  const storedMru = useSessionWorkbenchSelector((workbench) => workbench?.projectPanelMru ?? EMPTY_KEYS);
  const scmOpenResources = useSessionWorkbenchSelector(
    (workbench) => workbench?.scm?.openResources ?? EMPTY_SCM_RESOURCES,
  );
  const activeDiffKey = useSessionWorkbenchSelector((workbench) => {
    const resource = workbench?.scm?.activeResource;
    return resource ? diffKey(resource.staged, resource.path) : undefined;
  });
  const treeContentId = useId();
  const [treeHost, setTreeHost] = useState<HTMLDivElement | null>(null);
  const [editorHost, setEditorHost] = useState<HTMLDivElement | null>(null);
  const scmPanelRef = useRef<ScmPanelHandle>(null);
  const availableTabs = useMemo<ProjectDocumentTab[]>(
    () => [
      ...openFiles.map((path) => ({
        kind: "file" as const,
        key: `file:${path}`,
        path,
        label: path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path,
      })),
      ...scmOpenResources.map((resource) => ({
        kind: "diff" as const,
        key: diffKey(resource.staged, resource.path),
        path: resource.path,
        staged: resource.staged,
        label: resource.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? resource.path,
      })),
    ],
    [openFiles, scmOpenResources],
  );
  const availableKeys = useMemo(() => availableTabs.map((tab) => tab.key), [availableTabs]);
  const orderedKeys = useMemo(
    () => reconcileProjectDocumentTabs(availableKeys, storedTabOrder),
    [availableKeys, storedTabOrder],
  );
  const tabsByKey = useMemo(() => new Map(availableTabs.map((tab) => [tab.key, tab])), [availableTabs]);
  const tabs = useMemo(
    () => orderedKeys.map((key) => tabsByKey.get(key)).filter((tab): tab is ProjectDocumentTab => tab !== undefined),
    [orderedKeys, tabsByKey],
  );
  const requestedActiveKey = activeDocumentTab ?? activeDiffKey ?? (activeFile ? `file:${activeFile}` : undefined);
  const activeKey = requestedActiveKey && tabsByKey.has(requestedActiveKey) ? requestedActiveKey : orderedKeys[0];
  const mru = useMemo(
    () => (activeKey ? activateProjectDocumentTab(storedMru, orderedKeys, activeKey) : []),
    [activeKey, orderedKeys, storedMru],
  );
  const activeContentKind = activeKey?.startsWith("diff:") ? "scm" : "files";
  const activeTab = activeKey ? tabsByKey.get(activeKey) : undefined;
  const activePath = activeTab?.kind === "file" ? activeTab.path : undefined;
  const markdownActive = activePath ? /\.(md|markdown)$/iu.test(activePath) : false;
  const richPreviewActive = activePath ? isOfficeDocumentPath(activePath) || isPdfPath(activePath) : false;

  useEffect(() => {
    if (arraysEqual(storedTabOrder, orderedKeys) && arraysEqual(storedMru, mru)) return;
    updateWorkbench({ projectPanelTabs: orderedKeys, projectPanelMru: mru });
  }, [mru, orderedKeys, storedMru, storedTabOrder, updateWorkbench]);

  const selectTab = useCallback(
    (tab: ProjectDocumentTab) => {
      const nextMru = activateProjectDocumentTab(mru, orderedKeys, tab.key);
      if (tab.kind === "file") {
        updateWorkbench({ projectPanelActiveTab: tab.key, projectPanelMru: nextMru, activeFile: tab.path });
        return;
      }
      const current = record.stores.workbench.getSnapshot()?.scm ?? {
        openResources: [],
        expandedPaths: [],
        treeScrollTop: 0,
        viewStates: {},
      };
      updateWorkbench({
        projectPanelActiveTab: tab.key,
        projectPanelMru: nextMru,
        scm: { ...current, activeResource: { path: tab.path, staged: tab.staged } },
      });
    },
    [mru, orderedKeys, record, updateWorkbench],
  );

  const closeTab = useCallback(
    (tab: ProjectDocumentTab) => {
      const closed = closeProjectDocumentTab(orderedKeys, mru, activeKey, tab.key);
      if (!closed) return;
      const scm = record.stores.workbench.getSnapshot()?.scm;
      const nextActiveTab = closed.activeTab ? tabsByKey.get(closed.activeTab) : undefined;
      const patch: Partial<WorkbenchState> = {
        projectPanelTabs: closed.tabs,
        projectPanelMru: closed.mru,
        projectPanelActiveTab: closed.activeTab,
      };

      if (tab.kind === "file") {
        const nextFiles = closeWorkbenchFile(openFiles, activeFile, tab.path);
        if (!nextFiles) return;
        Object.assign(patch, nextFiles);
        if (previewFile === tab.path) patch.previewFile = undefined;
      } else if (scm) {
        scmPanelRef.current?.closeResource(tab.staged, tab.path);
        const openResources = scm.openResources.filter(
          (resource) => diffKey(resource.staged, resource.path) !== tab.key,
        );
        patch.scm = { ...scm, openResources, activeResource: openResources.at(-1), viewStates: { ...scm.viewStates } };
      }

      if (nextActiveTab?.kind === "file") {
        patch.activeFile = nextActiveTab.path;
      } else if (nextActiveTab?.kind === "diff") {
        const current = patch.scm ?? scm ?? { openResources: [], expandedPaths: [], treeScrollTop: 0, viewStates: {} };
        patch.scm = {
          ...current,
          activeResource: { path: nextActiveTab.path, staged: nextActiveTab.staged },
        };
      }
      updateWorkbench(patch);
    },
    [activeFile, activeKey, mru, openFiles, orderedKeys, previewFile, record, tabsByKey, updateWorkbench],
  );

  const pinTab = useCallback(
    (tab: ProjectDocumentTab) => {
      if (tab.kind === "file" && previewFile === tab.path) updateWorkbench({ previewFile: undefined });
    },
    [previewFile, updateWorkbench],
  );

  const moveTab = useCallback(
    (sourceKey: string, targetKey: string) => {
      const next = moveProjectDocumentTab(orderedKeys, sourceKey, targetKey);
      if (!arraysEqual(next, orderedKeys)) updateWorkbench({ projectPanelTabs: next });
    },
    [orderedKeys, updateWorkbench],
  );

  const openDroppedFile = useCallback(
    (path: string, targetKey?: string) => {
      const workbench = record.stores.workbench.getSnapshot();
      if (!workbench) return;
      const key = `file:${path}`;
      const opened = openPinnedWorkbenchFile(workbench.openFiles, workbench.previewFile, path);
      let nextTabs = openProjectDocumentTab(orderedKeys, key);
      if (targetKey) nextTabs = moveProjectDocumentTab(nextTabs, key, targetKey);
      updateWorkbench({
        ...opened,
        projectPanelActiveTab: key,
        projectPanelTabs: nextTabs,
        projectPanelMru: activateProjectDocumentTab(mru, nextTabs, key),
      });
    },
    [mru, orderedKeys, record, updateWorkbench],
  );

  return (
    <div className="project-panel">
      <FileWorkspaceLayout
        treeContentId={treeContentId}
        treeAriaLabel={view === "scm" ? "源代码管理资源" : "项目文件"}
        resizeAriaLabel="调整项目视图宽度"
        treeVisible={sidebarOpen}
        tree={
          <ProjectViewContainer
            view={view}
            sidebarOpen={sidebarOpen}
            onChange={(next) =>
              updateWorkbench({
                projectPanelView: next,
                projectPanelSidebarOpen: next === view ? !sidebarOpen : true,
              })
            }
          >
            <div ref={setTreeHost} className="project-view-content" />
          </ProjectViewContainer>
        }
        preview={
          <ProjectEditorGroup
            tabs={tabs}
            activeKey={activeKey}
            previewFile={previewFile}
            onSelect={selectTab}
            onClose={closeTab}
            onPin={pinTab}
            onMove={moveTab}
            onOpenFile={openDroppedFile}
            actions={
              activePath ? (
                <>
                  {markdownActive ? (
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
                  {richPreviewActive || (markdownActive && fileMarkdownPreview) ? null : (
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
                </>
              ) : null
            }
          >
            <div ref={setEditorHost} className="project-editor-content" />
          </ProjectEditorGroup>
        }
      />
      <FilePanel
        portalTargets={{
          tree: view === "files" ? treeHost : null,
          preview: activeContentKind === "files" ? editorHost : null,
        }}
      />
      <ScmPanel
        ref={scmPanelRef}
        activeResourceKey={activeKey?.startsWith("diff:") ? activeKey.slice("diff:".length) : undefined}
        portalTargets={{
          tree: view === "scm" ? treeHost : null,
          preview: activeContentKind === "scm" ? editorHost : null,
        }}
      />
    </div>
  );
}
