import * as Tabs from "@radix-ui/react-tabs";
import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { Button } from "@renderer/shared/ui/button";
import type { HighlightResult } from "@streamdown/code";
import FileCode2 from "lucide-react/dist/esm/icons/file-code-corner.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type CSSProperties, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FileNode, TextFile } from "../../../../../shared/contracts.ts";
import type { ScmChange, ScmDiff, ScmSnapshot } from "../../../../../shared/scm-contracts.ts";
import { SHIKI_THEMES } from "../../assistant-ui/streamdown/streamdown-config.ts";
import { useSessionScope, useSessionWorkbench } from "../../session-context.tsx";
import { highlightFileCode } from "../files/file-highlight-client.ts";
import { FilePathBreadcrumb } from "../files/file-path-breadcrumb.tsx";
import { FilePreview } from "../files/file-preview.tsx";
import { FileTree } from "../files/file-tree.tsx";

const FILE_TREE_DEFAULT_WIDTH = 240;
const FILE_TREE_MIN_WIDTH = 180;
const FILE_PREVIEW_MIN_WIDTH = 260;
const GROUPS: Array<{ key: ScmChange["kind"] | "staged"; label: string }> = [
  { key: "staged", label: "暂存的更改" },
  { key: "modified", label: "更改" },
  { key: "untracked", label: "未跟踪" },
  { key: "conflicted", label: "合并冲突" },
  { key: "deleted", label: "已删除" },
  { key: "renamed", label: "已重命名" },
];

interface ScmTreeData {
  roots: FileNode[];
  children: Record<string, FileNode[]>;
  changes: Map<string, ScmChange>;
  trailing: Map<string, string>;
  expanded: Set<string>;
}

function groupChanges(snapshot: ScmSnapshot | null, key: ScmChange["kind"] | "staged"): ScmChange[] {
  return (snapshot?.changes ?? []).filter((change) =>
    key === "staged" ? change.staged : !change.staged && change.kind === key,
  );
}

function sortNodes(nodes: FileNode[]): void {
  nodes.sort(
    (left, right) =>
      Number(right.type === "directory") - Number(left.type === "directory") || left.name.localeCompare(right.name),
  );
}

function buildScmTree(snapshot: ScmSnapshot | null): ScmTreeData {
  const roots: FileNode[] = [];
  const children: Record<string, FileNode[]> = {};
  const changes = new Map<string, ScmChange>();
  const trailing = new Map<string, string>();
  const expanded = new Set<string>();

  for (const group of GROUPS) {
    const resources = groupChanges(snapshot, group.key);
    if (resources.length === 0) continue;
    const groupPath = `scm:${group.key}`;
    roots.push({ name: group.label, path: groupPath, type: "directory", hasChildren: true });
    children[groupPath] = [];
    trailing.set(groupPath, String(resources.length));
    expanded.add(groupPath);

    for (const change of resources) {
      const parts = change.path.split(/[\\/]/u).filter(Boolean);
      let parent = groupPath;
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index];
        if (!name) continue;
        const path = `${parent}/${name}`;
        const leaf = index === parts.length - 1;
        children[parent] ??= [];
        if (!children[parent].some((node) => node.path === path)) {
          children[parent].push({ name, path, type: leaf ? "file" : "directory", hasChildren: !leaf });
        }
        if (leaf) {
          changes.set(path, change);
          trailing.set(path, status(change));
        } else {
          children[path] ??= [];
          expanded.add(path);
        }
        parent = path;
      }
    }
  }

  for (const nodes of Object.values(children)) sortNodes(nodes);
  return { roots, children, changes, trailing, expanded };
}

function lineDecorations(
  file: TextFile,
  hunks: ScmDiff["hunks"],
  side: "original" | "modified",
): Array<"removed" | "added" | undefined> {
  const result = new Array<"removed" | "added" | undefined>(file.content.split("\n").length);
  for (const hunk of hunks) {
    const start = side === "original" ? hunk.originalStart : hunk.modifiedStart;
    const count = side === "original" ? hunk.originalLines : hunk.modifiedLines;
    for (let index = Math.max(0, start - 1); index < start - 1 + count; index += 1) {
      result[index] = side === "original" ? "removed" : "added";
    }
  }
  return result;
}

const DIFF_LINE_HEIGHT = 20;

type DiffSide = "original" | "modified";

function mapDiffScroll(top: number, hunks: ScmDiff["hunks"], from: DiffSide): number {
  const line = top / DIFF_LINE_HEIGHT;
  let offset = 0;
  for (const hunk of hunks) {
    const sourceStart = (from === "original" ? hunk.originalStart : hunk.modifiedStart) - 1;
    const sourceLines = from === "original" ? hunk.originalLines : hunk.modifiedLines;
    const targetLines = from === "original" ? hunk.modifiedLines : hunk.originalLines;
    if (line < sourceStart) break;
    if (line < sourceStart + sourceLines) {
      const progress = sourceLines === 0 ? 0 : (line - sourceStart) / sourceLines;
      return Math.max(0, (sourceStart + offset + progress * targetLines) * DIFF_LINE_HEIGHT);
    }
    offset += targetLines - sourceLines;
  }
  return Math.max(0, (line + offset) * DIFF_LINE_HEIGHT);
}

function ScmDiffOverview({ diff, onNavigate }: { diff: ScmDiff; onNavigate(top: number): void }) {
  const lines = Math.max(
    1,
    diff.original?.content.split("\n").length ?? 0,
    diff.modified?.content.split("\n").length ?? 0,
  );
  return (
    <button
      type="button"
      className="scm-diff-overview"
      aria-label="差异概览"
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        onNavigate(((event.clientY - bounds.top) / bounds.height) * lines * DIFF_LINE_HEIGHT);
      }}
    >
      {diff.hunks.flatMap((hunk, index) => [
        hunk.originalLines > 0 ? (
          <span
            className="scm-diff-overview-marker"
            data-kind="removed"
            key={`removed:${index}`}
            style={{
              top: `${((hunk.originalStart - 1) / lines) * 100}%`,
              height: `${Math.max(0.35, (hunk.originalLines / lines) * 100)}%`,
            }}
          />
        ) : null,
        hunk.modifiedLines > 0 ? (
          <span
            className="scm-diff-overview-marker"
            data-kind="added"
            key={`added:${index}`}
            style={{
              top: `${((hunk.modifiedStart - 1) / lines) * 100}%`,
              height: `${Math.max(0.35, (hunk.modifiedLines / lines) * 100)}%`,
            }}
          />
        ) : null,
      ])}
    </button>
  );
}

function ScmBreadcrumb({ path }: { path: string }) {
  return (
    <div className="scm-code-breadcrumb">
      <FilePathBreadcrumb
        path={path}
        children={{}}
        expanded={new Set()}
        onDirectoryOpen={() => {}}
        onOpen={() => {}}
        interactive={false}
      />
    </div>
  );
}

function ScmCodePreview({
  file,
  decorations,
  onScrollChange,
  showBreadcrumb = true,
  showMinimap = true,
  scrollElementRef,
}: {
  file: TextFile;
  decorations?: readonly ("removed" | "added" | undefined)[];
  onScrollChange?(top: number): void;
  showBreadcrumb?: boolean;
  showMinimap?: boolean;
  scrollElementRef?: RefObject<HTMLPreElement | null>;
}) {
  const [tokens, setTokens] = useState<HighlightResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTokens(null);
    void highlightFileCode(file.content, file.language, SHIKI_THEMES).then((result) => {
      if (!cancelled) setTokens(result);
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  return (
    <section className="scm-code-preview">
      {showBreadcrumb ? <ScmBreadcrumb path={file.path} /> : null}
      <FilePreview
        file={file}
        highlight={tokens ? { file, tokens } : null}
        wrap={false}
        onScrollChange={onScrollChange ?? (() => {})}
        lineDecorations={decorations}
        showMinimap={showMinimap}
        scrollElementRef={scrollElementRef}
      />
    </section>
  );
}

function ScmDiffPreview({ diff }: { diff: ScmDiff }) {
  const originalScrollRef = useRef<HTMLPreElement>(null);
  const modifiedScrollRef = useRef<HTMLPreElement>(null);
  const expectedScrollRef = useRef<Partial<Record<DiffSide, number>>>({});
  const originalDecorations = useMemo(
    () => (diff.original ? lineDecorations(diff.original, diff.hunks, "original") : undefined),
    [diff],
  );
  const modifiedDecorations = useMemo(
    () => (diff.modified ? lineDecorations(diff.modified, diff.hunks, "modified") : undefined),
    [diff],
  );
  const syncScroll = useCallback(
    (side: DiffSide, top: number) => {
      const expected = expectedScrollRef.current[side];
      if (expected !== undefined && Math.abs(expected - top) <= 1) {
        delete expectedScrollRef.current[side];
        return;
      }
      delete expectedScrollRef.current[side];
      const targetSide: DiffSide = side === "original" ? "modified" : "original";
      const target = targetSide === "original" ? originalScrollRef.current : modifiedScrollRef.current;
      if (!target) return;
      const mapped = mapDiffScroll(top, diff.hunks, side);
      if (Math.abs(target.scrollTop - mapped) <= 1) return;
      expectedScrollRef.current[targetSide] = mapped;
      target.scrollTop = mapped;
    },
    [diff.hunks],
  );
  const navigate = useCallback(
    (top: number) => {
      const originalTop = mapDiffScroll(top, diff.hunks, "modified");
      expectedScrollRef.current = { original: originalTop, modified: top };
      if (originalScrollRef.current) originalScrollRef.current.scrollTop = originalTop;
      if (modifiedScrollRef.current) modifiedScrollRef.current.scrollTop = top;
    },
    [diff.hunks],
  );
  useEffect(() => {
    expectedScrollRef.current = { original: 0, modified: 0 };
    if (originalScrollRef.current) originalScrollRef.current.scrollTop = 0;
    if (modifiedScrollRef.current) modifiedScrollRef.current.scrollTop = 0;
  }, [diff]);

  if (diff.binary) return <div className="scm-empty">二进制文件，无法显示差异。</div>;
  if (diff.original && diff.modified) {
    return (
      <div className="scm-diff-comparison">
        <ScmBreadcrumb path={diff.modified.path} />
        <div className="scm-diff-editors">
          <ScmCodePreview
            file={diff.original}
            decorations={originalDecorations}
            onScrollChange={(top) => syncScroll("original", top)}
            showBreadcrumb={false}
            showMinimap={false}
            scrollElementRef={originalScrollRef}
          />
          <ScmCodePreview
            file={diff.modified}
            decorations={modifiedDecorations}
            onScrollChange={(top) => syncScroll("modified", top)}
            showBreadcrumb={false}
            showMinimap={false}
            scrollElementRef={modifiedScrollRef}
          />
          <ScmDiffOverview diff={diff} onNavigate={navigate} />
        </div>
      </div>
    );
  }
  const file = diff.modified ?? diff.original;
  return file ? <ScmCodePreview file={file} /> : <div className="scm-empty">没有可预览的文件内容。</div>;
}

function status(change: ScmChange): string {
  if (change.kind === "added") return "A";
  if (change.kind === "untracked") return "U";
  if (change.kind === "deleted") return "D";
  if (change.kind === "renamed") return "R";
  return "M";
}

export function ScmPanel() {
  const { record, updateWorkbench } = useSessionScope();
  const workbench = useSessionWorkbench();
  const projectId = record.identity.projectId;
  const fileTreeWidth = workbench?.fileTreeWidth ?? FILE_TREE_DEFAULT_WIDTH;
  const treeContentId = useId();
  const workspace = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<ScmSnapshot | null>(null);
  const [selected, setSelected] = useState<ScmChange | null>(null);
  const [activeTreePath, setActiveTreePath] = useState<string>();
  const [openDiffs, setOpenDiffs] = useState<ScmChange[]>([]);
  const [diff, setDiff] = useState<ScmDiff | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tree = useMemo(() => buildScmTree(snapshot), [snapshot]);
  const resize = useResizableRegion<HTMLElement>({
    value: fileTreeWidth,
    min: FILE_TREE_MIN_WIDTH,
    getMaxSize: () => (workspace.current?.clientWidth ?? FILE_PREVIEW_MIN_WIDTH * 2) - FILE_PREVIEW_MIN_WIDTH,
    direction: 1,
    orientation: "vertical",
    constraintRef: workspace,
    onCommit: (nextWidth) => {
      if (nextWidth !== fileTreeWidth) updateWorkbench({ fileTreeWidth: nextWidth });
    },
  });

  const selectChange = useCallback((path: string, change: ScmChange) => {
    setActiveTreePath(path);
    setSelected(change);
    setOpenDiffs((current) =>
      current.some((item) => item.path === change.path && item.staged === change.staged)
        ? current
        : [...current, change],
    );
  }, []);

  const closeDiff = useCallback(
    (change: ScmChange) => {
      const closingKey = `${change.staged}:${change.path}`;
      const index = openDiffs.findIndex((item) => `${item.staged}:${item.path}` === closingKey);
      const next = openDiffs.filter((item) => `${item.staged}:${item.path}` !== closingKey);
      setOpenDiffs(next);
      if (selected && `${selected.staged}:${selected.path}` === closingKey) {
        setSelected(next[index] ?? next[index - 1] ?? null);
        setDiff(null);
      }
    },
    [openDiffs, selected],
  );

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await window.desktop.scm.getSnapshot(projectId);
      setSnapshot(next);
      setExpanded(buildScmTree(next).expanded);
    } catch (value: unknown) {
      setError(value instanceof Error ? value.message : "无法读取源代码管理状态");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    if (!projectId || !selected) {
      setDiff(null);
      return;
    }
    setDiff(null);
    void window.desktop.scm
      .getDiff(projectId, selected.path, selected.staged)
      .then(setDiff)
      .catch(() => setDiff(null));
  }, [projectId, selected]);

  if (!workbench) return null;
  if (!projectId) return <div className="scm-empty">请选择一个项目以查看源代码管理。</div>;
  return (
    <div ref={workspace} className="file-workspace scm-workspace">
      <aside
        ref={resize.regionRef}
        className="file-tree-panel scm-resource-panel"
        style={{ "--resizable-region-size": `${resize.initialSize}px` } as CSSProperties}
        aria-label="源代码管理资源"
      >
        <div
          ref={resize.separatorRef}
          className="resize-handle resize-handle-file-tree"
          role="separator"
          tabIndex={0}
          aria-label="调整源代码管理文件树宽度"
          aria-controls={treeContentId}
          aria-orientation="vertical"
          aria-valuemin={FILE_TREE_MIN_WIDTH}
          aria-valuemax={resize.initialMax}
          aria-valuenow={resize.initialSize}
          aria-valuetext={`${resize.initialSize} 像素`}
          onPointerDown={resize.onPointerDown}
          onKeyDown={resize.onKeyDown}
        />
        <div id={treeContentId} className="file-tree-surface">
          <div className="file-tree-toolbar">
            <div className="scm-title">
              <strong>源代码管理</strong>
              <span className="scm-branch">{snapshot?.branch ?? "未检测到 Git 分支"}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              title="刷新源代码管理"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw size={14} />
            </Button>
          </div>
          {error ? <div className="panel-error">{error}</div> : null}
          <div className="file-tree">
            <FileTree
              nodes={tree.roots}
              children={tree.children}
              expanded={expanded}
              active={activeTreePath}
              onOpen={(node) => {
                if (node.type === "directory") {
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(node.path)) next.delete(node.path);
                    else next.add(node.path);
                    return next;
                  });
                  return;
                }
                const change = tree.changes.get(node.path);
                if (change) selectChange(node.path, change);
              }}
              renderTrailingContent={(node) => {
                const value = tree.trailing.get(node.path);
                return value ? <span className="scm-resource-status">{value}</span> : null;
              }}
            />
          </div>
        </div>
      </aside>
      <main className="file-preview scm-diff">
        <Tabs.Root
          className="scm-diff-tabs"
          value={selected ? `${selected.staged}:${selected.path}` : ""}
          onValueChange={(value) => {
            const item = openDiffs.find((change) => `${change.staged}:${change.path}` === value);
            if (item) setSelected(item);
          }}
        >
          <Tabs.List className="file-tabs scm-diff-tab-list">
            {openDiffs.map((change) => {
              const value = `${change.staged}:${change.path}`;
              const label = change.path.split(/[\\/]/u).at(-1) ?? change.path;
              return (
                <div
                  className="file-tab-item"
                  data-active={selected ? `${selected.staged}:${selected.path}` === value : undefined}
                  key={value}
                >
                  <Tabs.Trigger className="file-tab-trigger" value={value} title={change.path}>
                    <FileCode2 size={14} aria-hidden="true" />
                    <span>{label}</span>
                  </Tabs.Trigger>
                  <button
                    type="button"
                    className="file-tab-close"
                    aria-label={`关闭 ${label}`}
                    onClick={() => closeDiff(change)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </Tabs.List>
          <div className="scm-diff-view">
            {selected ? (
              diff ? (
                <ScmDiffPreview diff={diff} />
              ) : (
                <div className="file-preview-loading">正在加载差异</div>
              )
            ) : (
              <div className="scm-empty">从资源列表中选择文件以查看差异。</div>
            )}
          </div>
        </Tabs.Root>
      </main>
    </div>
  );
}
