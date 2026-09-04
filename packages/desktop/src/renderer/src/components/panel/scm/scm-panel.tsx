import { Button } from "@renderer/shared/ui/button";
import type { HighlightResult } from "@streamdown/code";
import { useVirtualizer } from "@tanstack/react-virtual";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import {
  type CSSProperties,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FileNode,
  ScmDiffViewState,
  ScmResourceState,
  ScmWorkbenchState,
  TextFile,
} from "../../../../../shared/contracts.ts";
import type { ScmChange, ScmDiff, ScmSnapshot } from "../../../../../shared/scm-contracts.ts";
import { resolveTokenStyle } from "../../assistant-ui/streamdown/streamdown-code-line.tsx";
import { SHIKI_THEMES } from "../../assistant-ui/streamdown/streamdown-config.ts";
import { useSessionScope, useSessionWorkbenchSelector } from "../../session-context.tsx";
import { highlightFileCode } from "../files/file-highlight-client.ts";
import { FilePathBreadcrumb } from "../files/file-path-breadcrumb.tsx";
import { FilePreview } from "../files/file-preview.tsx";
import { FileTree } from "../files/file-tree.tsx";
import { FileWorkspaceLayout, type FileWorkspacePortalTargets } from "../files/file-workspace-layout.tsx";
import { openProjectDocumentTab } from "../panel-model.ts";

import { type AlignedDiffRow, prepareAlignedDiff } from "./scm-diff-model.ts";

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

const DIFF_LINE_HEIGHT = 20;
const DIFF_OVERSCAN = 20;

function ScmDiffOverview({
  rows,
  scrollElement,
  syncRef,
}: {
  rows: readonly AlignedDiffRow[];
  scrollElement: RefObject<HTMLPreElement | null>;
  syncRef: RefObject<(() => void) | null>;
}) {
  const overview = useRef<HTMLDivElement>(null);
  const markerCanvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLSpanElement>(null);
  const dragOffset = useRef<number | null>(null);

  const scrollFromPointer = useCallback(
    (clientY: number) => {
      const scroller = scrollElement.current;
      const track = overview.current;
      const indicator = viewport.current;
      if (!scroller || !track || !indicator || dragOffset.current === null) return;
      const bounds = track.getBoundingClientRect();
      const thumbHeight = indicator.offsetHeight;
      const availableTrack = Math.max(0, bounds.height - thumbHeight);
      const thumbTop = Math.max(0, Math.min(availableTrack, clientY - bounds.top - dragOffset.current));
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = availableTrack > 0 ? (thumbTop / availableTrack) * maxScroll : 0;
      syncRef.current?.();
    },
    [scrollElement, syncRef],
  );

  useEffect(() => {
    const scroller = scrollElement.current;
    const track = overview.current;
    const indicator = viewport.current;
    if (!scroller || !track || !indicator) return;
    const update = () => {
      const trackHeight = track.clientHeight;
      const scrollHeight = Math.max(scroller.scrollHeight, 1);
      const thumbHeight = Math.min(trackHeight, Math.max(8, (scroller.clientHeight / scrollHeight) * trackHeight));
      const availableTrack = Math.max(0, trackHeight - thumbHeight);
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const thumbTop = maxScroll > 0 ? (scroller.scrollTop / maxScroll) * availableTrack : 0;
      indicator.style.top = `${thumbTop}px`;
      indicator.style.height = `${thumbHeight}px`;
      track.setAttribute("aria-valuemax", String(Math.round(maxScroll)));
      track.setAttribute("aria-valuenow", String(Math.round(scroller.scrollTop)));
    };
    update();
    syncRef.current = update;
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    observer.observe(track);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
      if (syncRef.current === update) syncRef.current = null;
    };
  }, [rows, scrollElement, syncRef]);

  useEffect(() => {
    const canvas = markerCanvas.current;
    const track = overview.current;
    if (!canvas || !track) return;
    const draw = () => {
      const width = track.clientWidth;
      const height = track.clientHeight;
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(scale, scale);
      const styles = getComputedStyle(canvas);
      const lineCount = Math.max(rows.length, 1);
      const markerHeight = Math.max(2, height / lineCount);
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const top = (index / lineCount) * height;
        if (row.originalKind) {
          context.fillStyle = `hsl(${styles.getPropertyValue("--destructive")} / 0.8)`;
          context.fillRect(0, top, width / 2, markerHeight);
        }
        if (row.modifiedKind) {
          context.fillStyle = `hsl(${styles.getPropertyValue("--success")} / 0.8)`;
          context.fillRect(width / 2, top, width / 2, markerHeight);
        }
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(track);
    return () => observer.disconnect();
  }, [rows]);

  const stopDragging = useCallback((target: HTMLDivElement, pointerId: number) => {
    dragOffset.current = null;
    target.removeAttribute("data-dragging");
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }, []);
  return (
    <div
      ref={overview}
      className="scm-diff-overview"
      role="scrollbar"
      tabIndex={0}
      aria-label="差异概览滚动条"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={0}
      aria-valuenow={0}
      onWheel={(event) => {
        const scroller = scrollElement.current;
        if (!scroller) return;
        event.preventDefault();
        scroller.scrollTop += event.deltaY * (event.deltaMode === 1 ? DIFF_LINE_HEIGHT : 1);
        syncRef.current?.();
      }}
      onPointerDown={(event) => {
        const indicator = viewport.current;
        if (!indicator) return;
        event.preventDefault();
        event.currentTarget.focus();
        const thumbBounds = indicator.getBoundingClientRect();
        dragOffset.current =
          event.clientY >= thumbBounds.top && event.clientY <= thumbBounds.bottom
            ? event.clientY - thumbBounds.top
            : thumbBounds.height / 2;
        event.currentTarget.dataset.dragging = "true";
        event.currentTarget.setPointerCapture(event.pointerId);
        scrollFromPointer(event.clientY);
      }}
      onPointerMove={(event) => {
        if (dragOffset.current !== null) scrollFromPointer(event.clientY);
      }}
      onPointerUp={(event) => stopDragging(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => stopDragging(event.currentTarget, event.pointerId)}
      onKeyDown={(event) => {
        const scroller = scrollElement.current;
        if (!scroller) return;
        const amount = event.key === "PageUp" || event.key === "PageDown" ? scroller.clientHeight : DIFF_LINE_HEIGHT;
        if (event.key === "Home") scroller.scrollTop = 0;
        else if (event.key === "End") scroller.scrollTop = scroller.scrollHeight;
        else if (event.key === "ArrowUp" || event.key === "PageUp") scroller.scrollTop -= amount;
        else if (event.key === "ArrowDown" || event.key === "PageDown") scroller.scrollTop += amount;
        else return;
        syncRef.current?.();
        event.preventDefault();
      }}
    >
      <canvas ref={markerCanvas} className="scm-diff-overview-markers" aria-hidden="true" />
      <span ref={viewport} className="scm-diff-overview-viewport" />
    </div>
  );
}

function ScmBreadcrumb({ path }: { path: string }) {
  return (
    <FilePathBreadcrumb
      path={path}
      children={{}}
      expanded={new Set()}
      onDirectoryOpen={() => {}}
      onOpen={() => {}}
      interactive={false}
    />
  );
}

function ScmCodePreview({
  file,
  initialViewState,
  onViewStateChange,
}: {
  file: TextFile;
  initialViewState?: ScmDiffViewState;
  onViewStateChange(viewState: ScmDiffViewState): void;
}) {
  const scrollTop = useRef(initialViewState?.scrollTop ?? 0);
  const initialViewStateRef = useRef(initialViewState);
  const onViewStateChangeRef = useRef(onViewStateChange);
  onViewStateChangeRef.current = onViewStateChange;
  const [tokens, setTokens] = useState<HighlightResult | null>(null);
  useEffect(
    () => () => {
      const viewState = initialViewStateRef.current;
      onViewStateChangeRef.current({
        scrollTop: scrollTop.current,
        horizontalScroll: viewState?.horizontalScroll ?? 0,
        splitPercentage: viewState?.splitPercentage ?? 50,
      });
    },
    [],
  );
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
      <ScmBreadcrumb path={file.path} />
      <FilePreview
        file={file}
        highlight={tokens ? { file, tokens } : null}
        wrap={false}
        initialScrollTop={initialViewState?.scrollTop}
        onScrollChange={(top) => {
          scrollTop.current = top;
        }}
      />
    </section>
  );
}

function ScmDiffLine({
  lines,
  lineIndex,
  highlight,
  kind,
  side,
}: {
  lines: readonly string[];
  lineIndex?: number;
  highlight: HighlightResult | null;
  kind?: "removed" | "added";
  side: "original" | "modified";
}) {
  const tokens = lineIndex === undefined ? undefined : highlight?.tokens[lineIndex];
  return (
    <span
      className="scm-aligned-diff-cell"
      data-diff={kind}
      data-diff-side={side}
      data-spacer={lineIndex === undefined || undefined}
    >
      <span className="file-preview-line-number" aria-hidden="true">
        {lineIndex === undefined ? "" : lineIndex + 1}
      </span>
      <span className="file-preview-line-text">
        {lineIndex === undefined
          ? " "
          : tokens
            ? tokens.length === 0
              ? " "
              : tokens.map((token, index) => (
                  <span
                    className="file-preview-token"
                    key={`${index}:${token.offset}`}
                    style={resolveTokenStyle(token)}
                  >
                    {token.content}
                  </span>
                ))
            : lines[lineIndex] || " "}
      </span>
    </span>
  );
}

function ScmAlignedDiffPreview({
  diff,
  initialViewState,
  onViewStateChange,
}: {
  diff: ScmDiff & { original: TextFile; modified: TextFile };
  initialViewState?: ScmDiffViewState;
  onViewStateChange(viewState: ScmDiffViewState): void;
}) {
  const scrollElement = useRef<HTMLPreElement>(null);
  const overviewSync = useRef<(() => void) | null>(null);
  const rootElement = useRef<HTMLDivElement>(null);
  const originalHorizontal = useRef<HTMLDivElement>(null);
  const modifiedHorizontal = useRef<HTMLDivElement>(null);
  const horizontalSyncing = useRef(false);
  const sashDragging = useRef(false);
  const horizontalPosition = useRef(initialViewState?.horizontalScroll ?? 0);
  const verticalPosition = useRef(initialViewState?.scrollTop ?? 0);
  const initialViewStateRef = useRef(initialViewState);
  const onViewStateChangeRef = useRef(onViewStateChange);
  onViewStateChangeRef.current = onViewStateChange;
  const splitPercentageRef = useRef(initialViewState?.splitPercentage ?? 50);
  const [splitPercentage, setSplitPercentage] = useState(initialViewState?.splitPercentage ?? 50);
  const [highlights, setHighlights] = useState<{ original: HighlightResult | null; modified: HighlightResult | null }>({
    original: null,
    modified: null,
  });
  const prepared = useMemo(() => prepareAlignedDiff(diff), [diff]);
  const { rows, originalLines, modifiedLines } = prepared;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => DIFF_LINE_HEIGHT,
    overscan: DIFF_OVERSCAN,
    initialRect: { height: 600, width: 1200 },
  });
  const contentWidths = { original: prepared.originalWidth, modified: prepared.modifiedWidth };
  const updateHorizontalOffsets = useCallback(() => {
    const root = rootElement.current;
    if (!root) return;
    root.style.setProperty("--scm-original-scroll-left", `${originalHorizontal.current?.scrollLeft ?? 0}px`);
    root.style.setProperty("--scm-modified-scroll-left", `${modifiedHorizontal.current?.scrollLeft ?? 0}px`);
  }, []);
  const restoreHorizontalPosition = useCallback(() => {
    const original = originalHorizontal.current;
    const modified = modifiedHorizontal.current;
    if (!original || !modified) return;
    horizontalSyncing.current = true;
    original.scrollLeft = Math.min(
      horizontalPosition.current,
      Math.max(0, original.scrollWidth - original.clientWidth),
    );
    modified.scrollLeft = Math.min(
      horizontalPosition.current,
      Math.max(0, modified.scrollWidth - modified.clientWidth),
    );
    updateHorizontalOffsets();
    requestAnimationFrame(() => {
      horizontalSyncing.current = false;
    });
  }, [updateHorizontalOffsets]);
  const restoreScrollPositions = useCallback(() => {
    if (scrollElement.current) scrollElement.current.scrollTop = verticalPosition.current;
    restoreHorizontalPosition();
  }, [restoreHorizontalPosition]);
  const syncHorizontal = useCallback(
    (side: "original" | "modified") => {
      const source = side === "original" ? originalHorizontal.current : modifiedHorizontal.current;
      const target = side === "original" ? modifiedHorizontal.current : originalHorizontal.current;
      if (!source || !target || horizontalSyncing.current || sashDragging.current) return;
      horizontalPosition.current = source.scrollLeft;
      horizontalSyncing.current = true;
      target.scrollLeft = source.scrollLeft;
      updateHorizontalOffsets();
      requestAnimationFrame(() => {
        horizontalSyncing.current = false;
      });
    },
    [updateHorizontalOffsets],
  );
  const handleCodeWheel = useCallback(
    (event: ReactWheelEvent<HTMLPreElement>) => {
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontal && event.deltaY !== 0) {
        const scroller = scrollElement.current;
        if (!scroller) return;
        event.preventDefault();
        const multiplier = event.deltaMode === 1 ? DIFF_LINE_HEIGHT : event.deltaMode === 2 ? scroller.clientHeight : 1;
        scroller.scrollTop += event.deltaY * multiplier;
        overviewSync.current?.();
        return;
      }
      const delta = event.shiftKey ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-diff-side]") : null;
      const side = target?.dataset.diffSide;
      if (side !== "original" && side !== "modified") return;
      event.preventDefault();
      const scroller = side === "original" ? originalHorizontal.current : modifiedHorizontal.current;
      if (!scroller) return;
      scroller.scrollLeft += delta;
      syncHorizontal(side);
    },
    [syncHorizontal],
  );
  const updateSplit = useCallback(
    (clientX: number) => {
      const root = rootElement.current;
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      const percentage = Math.max(20, Math.min(80, ((clientX - bounds.left) / bounds.width) * 100));
      splitPercentageRef.current = percentage;
      root.style.setProperty("--scm-diff-split", `${percentage}%`);
      restoreScrollPositions();
    },
    [restoreScrollPositions],
  );
  const handleSashPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      verticalPosition.current = scrollElement.current?.scrollTop ?? 0;
      horizontalPosition.current = Math.max(
        originalHorizontal.current?.scrollLeft ?? 0,
        modifiedHorizontal.current?.scrollLeft ?? 0,
      );
      sashDragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      updateSplit(event.clientX);
    },
    [updateSplit],
  );
  const handleSashPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSplit(event.clientX);
    },
    [updateSplit],
  );
  const handleSashPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      setSplitPercentage(splitPercentageRef.current);
      requestAnimationFrame(() => {
        restoreScrollPositions();
        sashDragging.current = false;
      });
    },
    [restoreScrollPositions],
  );
  const handleSashKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = Math.max(20, Math.min(80, splitPercentageRef.current + (event.key === "ArrowLeft" ? -2 : 2)));
      verticalPosition.current = scrollElement.current?.scrollTop ?? 0;
      horizontalPosition.current = Math.max(
        originalHorizontal.current?.scrollLeft ?? 0,
        modifiedHorizontal.current?.scrollLeft ?? 0,
      );
      sashDragging.current = true;
      splitPercentageRef.current = next;
      setSplitPercentage(next);
      rootElement.current?.style.setProperty("--scm-diff-split", `${next}%`);
      requestAnimationFrame(() => {
        restoreScrollPositions();
        sashDragging.current = false;
      });
    },
    [restoreScrollPositions],
  );

  useEffect(() => {
    let cancelled = false;
    setHighlights({ original: null, modified: null });
    void Promise.all([
      highlightFileCode(diff.original.content, diff.original.language, SHIKI_THEMES),
      highlightFileCode(diff.modified.content, diff.modified.language, SHIKI_THEMES),
    ]).then(([original, modified]) => {
      if (!cancelled) setHighlights({ original, modified });
    });
    return () => {
      cancelled = true;
    };
  }, [diff]);
  useEffect(() => {
    const viewState = initialViewStateRef.current ?? { scrollTop: 0, horizontalScroll: 0, splitPercentage: 50 };
    verticalPosition.current = viewState.scrollTop;
    horizontalPosition.current = viewState.horizontalScroll;
    splitPercentageRef.current = viewState.splitPercentage;
    setSplitPercentage(viewState.splitPercentage);
    if (scrollElement.current) scrollElement.current.scrollTop = viewState.scrollTop;
    if (originalHorizontal.current) originalHorizontal.current.scrollLeft = viewState.horizontalScroll;
    if (modifiedHorizontal.current) modifiedHorizontal.current.scrollLeft = viewState.horizontalScroll;
    rootElement.current?.style.setProperty("--scm-diff-split", `${viewState.splitPercentage}%`);
    updateHorizontalOffsets();
    return () => {
      onViewStateChangeRef.current({
        scrollTop: scrollElement.current?.scrollTop ?? verticalPosition.current,
        horizontalScroll: Math.max(
          originalHorizontal.current?.scrollLeft ?? horizontalPosition.current,
          modifiedHorizontal.current?.scrollLeft ?? horizontalPosition.current,
        ),
        splitPercentage: splitPercentageRef.current,
      });
    };
  }, [diff, updateHorizontalOffsets]);

  return (
    <div className="scm-diff-editors">
      <div
        ref={rootElement}
        className="scm-diff-main"
        style={{ "--scm-diff-split": `${splitPercentage}%` } as CSSProperties}
      >
        <pre
          ref={scrollElement}
          className="scm-aligned-diff-scroll"
          tabIndex={0}
          aria-label={`${diff.path} 差异`}
          onScroll={(event) => {
            verticalPosition.current = event.currentTarget.scrollTop;
          }}
          onWheel={handleCodeWheel}
          style={
            {
              "--file-preview-line-number-width": `${prepared.lineNumberCharacters}ch`,
            } as CSSProperties
          }
        >
          <div
            className="scm-aligned-diff-canvas"
            style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%" }}
            onPointerDownCapture={(event) => {
              const target =
                event.target instanceof Element ? event.target.closest<HTMLElement>("[data-diff-side]") : null;
              const side = target?.dataset.diffSide;
              if (side === "original" || side === "modified") event.currentTarget.dataset.selectionSide = side;
            }}
          >
            <div className="scm-aligned-diff-column" data-diff-column="original">
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                return (
                  <div
                    className="scm-aligned-diff-line"
                    key={virtualRow.index}
                    style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <ScmDiffLine
                      lines={originalLines}
                      lineIndex={row.originalLine}
                      highlight={highlights.original}
                      kind={row.originalKind}
                      side="original"
                    />
                  </div>
                );
              })}
            </div>
            <div className="scm-aligned-diff-column" data-diff-column="modified">
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                return (
                  <div
                    className="scm-aligned-diff-line"
                    key={virtualRow.index}
                    style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <ScmDiffLine
                      lines={modifiedLines}
                      lineIndex={row.modifiedLine}
                      highlight={highlights.modified}
                      kind={row.modifiedKind}
                      side="modified"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </pre>
        <div className="scm-horizontal-scrollbars">
          <div
            ref={originalHorizontal}
            className="scm-horizontal-scroll"
            tabIndex={0}
            aria-label="原始文件横向滚动"
            onScroll={() => syncHorizontal("original")}
          >
            <div style={{ width: `${contentWidths.original}px` }} />
          </div>
          <div
            ref={modifiedHorizontal}
            className="scm-horizontal-scroll"
            tabIndex={0}
            aria-label="修改后文件横向滚动"
            onScroll={() => syncHorizontal("modified")}
          >
            <div style={{ width: `${contentWidths.modified}px` }} />
          </div>
        </div>
        <div
          className="scm-diff-sash"
          role="separator"
          aria-label="调整差异编辑器宽度"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(splitPercentage)}
          tabIndex={0}
          onKeyDown={handleSashKeyDown}
          onPointerDown={handleSashPointerDown}
          onPointerMove={handleSashPointerMove}
          onPointerUp={handleSashPointerUp}
          onPointerCancel={handleSashPointerUp}
        />
      </div>
      <ScmDiffOverview rows={rows} scrollElement={scrollElement} syncRef={overviewSync} />
    </div>
  );
}

function hasComparisonFiles(diff: ScmDiff): diff is ScmDiff & { original: TextFile; modified: TextFile } {
  return diff.original !== null && diff.modified !== null;
}

function ScmDiffPreview({
  diff,
  initialViewState,
  onViewStateChange,
}: {
  diff: ScmDiff;
  initialViewState?: ScmDiffViewState;
  onViewStateChange(viewState: ScmDiffViewState): void;
}) {
  if (diff.binary) return <div className="scm-empty">二进制文件，无法显示差异。</div>;
  if (hasComparisonFiles(diff)) {
    return (
      <div className="scm-diff-comparison">
        <ScmBreadcrumb path={diff.modified.path} />
        <ScmAlignedDiffPreview diff={diff} initialViewState={initialViewState} onViewStateChange={onViewStateChange} />
      </div>
    );
  }
  const file = diff.modified ?? diff.original;
  return file ? (
    <ScmCodePreview file={file} initialViewState={initialViewState} onViewStateChange={onViewStateChange} />
  ) : (
    <div className="scm-empty">没有可预览的文件内容。</div>
  );
}

function resourceKey(resource: ScmResourceState): string {
  return `${resource.staged}:${resource.path}`;
}

function resourceState(change: ScmChange): ScmResourceState {
  return { path: change.path, staged: change.staged };
}

function resolveResource(changes: readonly ScmChange[], resource?: ScmResourceState): ScmChange | null {
  return resource ? (changes.find((change) => resourceKey(change) === resourceKey(resource)) ?? null) : null;
}

function findTreePath(changes: ReadonlyMap<string, ScmChange>, change: ScmChange): string | undefined {
  for (const [path, candidate] of changes) if (resourceKey(candidate) === resourceKey(change)) return path;
  return undefined;
}

function status(change: ScmChange): string {
  if (change.kind === "added") return "A";
  if (change.kind === "untracked") return "U";
  if (change.kind === "deleted") return "D";
  if (change.kind === "renamed") return "R";
  return "M";
}

export interface ScmPanelHandle {
  closeResource(staged: boolean, path: string): void;
}

interface ScmPanelProps {
  activeResourceKey?: string;
  portalTargets?: FileWorkspacePortalTargets;
}

export const ScmPanel = forwardRef<ScmPanelHandle, ScmPanelProps>(function ScmPanel(
  { activeResourceKey, portalTargets },
  ref,
) {
  const { record, updateWorkbench } = useSessionScope();
  const initialScmState = useRef<ScmWorkbenchState | undefined>(record.stores.workbench.getSnapshot()?.scm).current;
  const workbenchAvailable = useSessionWorkbenchSelector((workbench) => workbench !== null);
  const projectId = record.identity.projectId;
  const treeContentId = useId();
  const [snapshot, setSnapshot] = useState<ScmSnapshot | null>(null);
  const [selected, setSelected] = useState<ScmChange | null>(null);
  const [activeTreePath, setActiveTreePath] = useState<string>();
  const [openDiffs, setOpenDiffs] = useState<ScmChange[]>([]);
  const [diff, setDiff] = useState<ScmDiff | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeScrollTop, setTreeScrollTop] = useState(initialScmState?.treeScrollTop ?? 0);
  const [viewStates, setViewStates] = useState<Record<string, ScmDiffViewState>>(initialScmState?.viewStates ?? {});
  const [hydrated, setHydrated] = useState(false);
  const refreshGeneration = useRef(0);
  const foregroundRefreshGeneration = useRef<number | null>(null);
  const diffGeneration = useRef(0);
  const diffResourceKey = useRef<string | null>(null);
  const selectedRef = useRef<ScmChange | null>(null);
  selectedRef.current = selected;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tree = useMemo(() => buildScmTree(snapshot), [snapshot]);
  const updatePersistedScm = useCallback(
    (patch: Partial<ScmWorkbenchState>) => {
      const current = record.stores.workbench.getSnapshot()?.scm;
      updateWorkbench({
        scm: {
          openResources: [],
          expandedPaths: [],
          treeScrollTop: 0,
          viewStates: {},
          ...current,
          ...patch,
        },
      });
    },
    [record, updateWorkbench],
  );
  const handleTreeScrollTopChange = useCallback(
    (scrollTop: number) => {
      setTreeScrollTop(scrollTop);
      updatePersistedScm({ treeScrollTop: scrollTop });
    },
    [updatePersistedScm],
  );
  const handleViewStateChange = useCallback(
    (viewState: ScmDiffViewState) => {
      if (!selected) return;
      const key = resourceKey(selected);
      setViewStates((current) => ({ ...current, [key]: viewState }));
      const current = record.stores.workbench.getSnapshot()?.scm?.viewStates ?? {};
      updatePersistedScm({ viewStates: { ...current, [key]: viewState } });
    },
    [record, selected, updatePersistedScm],
  );

  const selectChange = useCallback(
    (path: string, change: ScmChange) => {
      const key = `diff:${resourceKey(change)}`;
      const workbench = record.stores.workbench.getSnapshot();
      setActiveTreePath(path);
      setSelected(change);
      updateWorkbench({
        projectPanelActiveTab: key,
        projectPanelTabs: openProjectDocumentTab(workbench?.projectPanelTabs ?? [], key),
      });
      setOpenDiffs((current) =>
        current.some((item) => item.path === change.path && item.staged === change.staged)
          ? current
          : [...current, change],
      );
    },
    [record, updateWorkbench],
  );

  const closeDiff = useCallback(
    (change: ScmChange) => {
      const closingKey = `${change.staged}:${change.path}`;
      const index = openDiffs.findIndex((item) => `${item.staged}:${item.path}` === closingKey);
      const next = openDiffs.filter((item) => `${item.staged}:${item.path}` !== closingKey);
      setOpenDiffs(next);
      const replacement = next[index] ?? next[index - 1] ?? null;
      if (selected && resourceKey(selected) === closingKey) {
        setSelected(replacement);
        setActiveTreePath(replacement ? findTreePath(tree.changes, replacement) : undefined);
        setDiff(null);
      }
    },
    [openDiffs, selected, tree.changes],
  );

  useImperativeHandle(
    ref,
    () => ({
      closeResource(staged: boolean, path: string) {
        const change = openDiffs.find((item) => item.staged === staged && item.path === path);
        if (change) closeDiff(change);
      },
    }),
    [closeDiff, openDiffs],
  );

  const refresh = useCallback(
    async (foreground = true) => {
      if (!projectId) return;
      const generation = refreshGeneration.current + 1;
      refreshGeneration.current = generation;
      if (foreground) {
        foregroundRefreshGeneration.current = generation;
        setLoading(true);
        setError(null);
      }
      try {
        const next = await window.desktop.scm.getSnapshot(projectId);
        if (generation !== refreshGeneration.current) return;
        const nextTree = buildScmTree(next);
        const currentSelected = selectedRef.current;
        const nextSelected = resolveResource(
          next.changes,
          currentSelected ? resourceState(currentSelected) : undefined,
        );
        setSnapshot(next);
        setOpenDiffs((current) =>
          current
            .map((change) => resolveResource(next.changes, resourceState(change)))
            .filter((change): change is ScmChange => change !== null),
        );
        if (currentSelected) {
          setSelected(nextSelected);
          setActiveTreePath(nextSelected ? findTreePath(nextTree.changes, nextSelected) : undefined);
          if (!nextSelected) setDiff(null);
        }
      } catch (value: unknown) {
        if (generation === refreshGeneration.current)
          setError(value instanceof Error ? value.message : "无法读取源代码管理状态");
      } finally {
        if (foreground && foregroundRefreshGeneration.current === generation) {
          foregroundRefreshGeneration.current = null;
          setLoading(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    const unsubscribe = window.desktop.scm.onChanged((event) => {
      if (!disposed && event.projectId === projectId) void refresh(false);
    });
    void window.desktop.scm.watch(projectId).catch((value: unknown) => {
      if (!disposed) setError(value instanceof Error ? value.message : "无法监听源代码管理状态");
    });
    return () => {
      disposed = true;
      unsubscribe();
      void window.desktop.scm.unwatch(projectId);
    };
  }, [projectId, refresh]);
  useEffect(() => {
    if (!snapshot || hydrated) return;
    const restoredOpen = (initialScmState?.openResources ?? [])
      .map((resource) => resolveResource(snapshot.changes, resource))
      .filter((change): change is ScmChange => change !== null);
    const restoredActive =
      resolveResource(snapshot.changes, initialScmState?.activeResource) ?? restoredOpen.at(-1) ?? null;
    setOpenDiffs(restoredOpen);
    setSelected(restoredActive);
    setActiveTreePath(restoredActive ? findTreePath(tree.changes, restoredActive) : undefined);
    setExpanded(initialScmState ? new Set(initialScmState.expandedPaths) : tree.expanded);
    setHydrated(true);
  }, [hydrated, initialScmState, snapshot, tree]);
  useEffect(() => {
    if (!hydrated) return;
    updateWorkbench({
      scm: {
        openResources: openDiffs.map(resourceState),
        activeResource: selected ? resourceState(selected) : undefined,
        expandedPaths: [...expanded],
        treeScrollTop,
        viewStates,
      },
    });
  }, [expanded, hydrated, openDiffs, selected, treeScrollTop, updateWorkbench, viewStates]);
  useEffect(() => {
    if (!activeResourceKey || !snapshot) return;
    const next = snapshot.changes.find((change) => resourceKey(change) === activeResourceKey);
    if (next && (!selected || resourceKey(selected) !== activeResourceKey)) {
      setSelected(next);
      setActiveTreePath(findTreePath(tree.changes, next));
    }
  }, [activeResourceKey, selected, snapshot, tree.changes]);
  useEffect(() => {
    const generation = diffGeneration.current + 1;
    diffGeneration.current = generation;
    if (!projectId || !selected) {
      diffResourceKey.current = null;
      setDiff(null);
      return;
    }
    const selectedKey = resourceKey(selected);
    if (diffResourceKey.current !== selectedKey) setDiff(null);
    void window.desktop.scm
      .getDiff(projectId, selected.path, selected.staged)
      .then((next) => {
        if (generation !== diffGeneration.current) return;
        diffResourceKey.current = selectedKey;
        setDiff(next);
      })
      .catch(() => {
        if (generation === diffGeneration.current && diffResourceKey.current !== selectedKey) setDiff(null);
      });
  }, [projectId, selected]);

  if (!workbenchAvailable) return null;
  if (!projectId) return <div className="scm-empty">请选择一个项目以查看源代码管理。</div>;
  return (
    <FileWorkspaceLayout
      className="scm-workspace"
      treeClassName="scm-resource-panel"
      treeContentId={treeContentId}
      treeAriaLabel="源代码管理资源"
      resizeAriaLabel="调整源代码管理文件树宽度"
      portalTargets={portalTargets}
      tree={
        <>
          <div className="file-tree-toolbar">
            <div className="scm-title">
              <span className="scm-branch">{snapshot?.branch ?? "未检测到 Git 分支"}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              title="刷新源代码管理"
              onClick={() => void refresh(true)}
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
              compactRoot={false}
              expanded={expanded}
              active={activeTreePath}
              initialScrollTop={treeScrollTop}
              onScrollTopChange={handleTreeScrollTopChange}
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
        </>
      }
      preview={
        <main className="file-preview scm-diff">
          <div className="scm-diff-view">
            {selected ? (
              diff ? (
                <ScmDiffPreview
                  key={resourceKey(selected)}
                  diff={diff}
                  initialViewState={viewStates[resourceKey(selected)]}
                  onViewStateChange={handleViewStateChange}
                />
              ) : (
                <div className="file-preview-loading">正在加载差异</div>
              )
            ) : (
              <div className="scm-empty">从资源列表中选择文件以查看差异。</div>
            )}
          </div>
        </main>
      }
    />
  );
});
