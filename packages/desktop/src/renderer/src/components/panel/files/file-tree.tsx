import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileNode } from "../../../../../shared/contracts.ts";
import {
  buildFileTreeStickyModel,
  type FileTreeRow,
  fileTreeKeyNavigation,
  fileTreeRenderRange,
  fileTreeStickyRows,
} from "./file-tree-navigation.ts";
import { FileTreeNodeRow } from "./file-tree-node-row.tsx";

const FILE_ROW_HEIGHT = 28;
const FILE_TREE_OVERSCAN = 8;
const FILE_TREE_STICKY_MAX_ITEMS = 7;

interface FileTreeProps {
  nodes: readonly FileNode[];
  children: Readonly<Record<string, readonly FileNode[]>>;
  expanded: ReadonlySet<string>;
  active?: string;
  onOpen(node: FileNode): void;
  /** 双击节点（固定预览 tab）；目录不触发。 */
  onPinOpen?(node: FileNode): void;
  /** 节点右键菜单。 */
  renderContextMenu?(node: FileNode): ReactNode;
  /** 节点行尾附加内容，例如 SCM 状态。 */
  renderTrailingContent?(node: FileNode): ReactNode;
  /** 键盘复制/剪切当前聚焦节点。 */
  onCopy?(node: FileNode): void;
  onCut?(node: FileNode): void;
  /** 键盘粘贴到当前聚焦节点对应的目录。 */
  onPaste?(node: FileNode): void;
  initialScrollTop?: number;
  onScrollTopChange?(scrollTop: number): void;
  depth?: number;
}

function hasVisiblePath(
  nodes: readonly FileNode[],
  children: Readonly<Record<string, readonly FileNode[]>>,
  expanded: ReadonlySet<string>,
  path: string,
): boolean {
  for (const node of nodes) {
    if (node.path === path) return true;
    if (node.type === "directory" && expanded.has(node.path) && children[node.path]) {
      if (hasVisiblePath(children[node.path], children, expanded, path)) return true;
    }
  }
  return false;
}

/** 把递归树展开成虚拟滚动用的扁平行（目录懒加载时插入 loading 占位行）。 */
function buildRows(
  nodes: readonly FileNode[],
  children: Readonly<Record<string, readonly FileNode[]>>,
  expanded: ReadonlySet<string>,
  depth = 0,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  for (const node of nodes) {
    const open = node.type === "directory" && expanded.has(node.path);
    rows.push({ kind: "node", path: node.path, depth, open, node });
    if (node.type === "directory" && open) {
      const kids = children[node.path];
      if (kids) {
        rows.push(...buildRows(kids, children, expanded, depth + 1));
      } else if (node.hasChildren) {
        rows.push({ kind: "loading", path: `${node.path}:loading`, depth: depth + 1, open: false });
      }
    }
  }
  return rows;
}

/** 虚拟滚动 + 平铺 ARIA tree 的文件树；行高固定，与 VS Code VirtualizedTree 思路一致。 */
export function FileTree({
  nodes,
  children,
  expanded,
  active,
  onOpen,
  onPinOpen,
  renderContextMenu,
  renderTrailingContent,
  onCopy,
  onCut,
  onPaste,
  initialScrollTop = 0,
  onScrollTopChange,
  depth = 0,
}: FileTreeProps) {
  const rows = useMemo(() => buildRows(nodes, children, expanded, depth), [children, depth, expanded, nodes]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredScroll = useRef(false);
  const initialRange = fileTreeRenderRange(rows.length, 0, 600, FILE_ROW_HEIGHT, FILE_TREE_OVERSCAN);
  const [renderWindow, setRenderWindow] = useState({ ...initialRange, itemCount: rows.length });
  const renderWindowRef = useRef(renderWindow);
  const syncRenderWindow = useCallback(
    (element: HTMLDivElement) => {
      const range = fileTreeRenderRange(
        rows.length,
        element.scrollTop,
        element.clientHeight,
        FILE_ROW_HEIGHT,
        FILE_TREE_OVERSCAN,
      );
      const previous = renderWindowRef.current;
      if (previous.itemCount === rows.length && previous.start === range.start && previous.end === range.end) return;
      const next = { ...range, itemCount: rows.length };
      renderWindowRef.current = next;
      setRenderWindow(next);
    },
    [rows.length],
  );
  const scrollToIndex = useCallback(
    (index: number) => {
      const element = scrollRef.current;
      if (!element) return;
      const itemTop = index * FILE_ROW_HEIGHT;
      const itemBottom = itemTop + FILE_ROW_HEIGHT;
      if (itemTop < element.scrollTop) element.scrollTop = itemTop;
      else if (itemBottom > element.scrollTop + element.clientHeight) {
        element.scrollTop = Math.max(0, itemBottom - element.clientHeight);
      }
      syncRenderWindow(element);
    },
    [syncRenderWindow],
  );
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const rovingPath = useMemo(() => {
    if (focusIndex !== null && rows[focusIndex]) return rows[focusIndex].path;
    if (active && hasVisiblePath(nodes, children, expanded, active)) return active;
    return rows.find((row) => row.kind === "node")?.path;
  }, [active, children, expanded, focusIndex, nodes, rows]);

  const moveFocus = useCallback(
    (index: number) => {
      setFocusIndex(index);
      scrollToIndex(index);
    },
    [scrollToIndex],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      const action = fileTreeKeyNavigation(rows, index, event.key);
      if (!action) return;
      event.preventDefault();
      if (action.kind === "toggle") {
        const row = rows[index];
        if (row?.node) onOpen(row.node);
        return;
      }
      moveFocus(action.index);
    },
    [moveFocus, onOpen, rows],
  );

  // 输入即定位（type-ahead）：聚焦树时连续输入字符，跳到名称匹配的行。
  const [typeAhead, setTypeAhead] = useState("");
  const typeAheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typeAheadStartIndex = useRef(0);
  const handleContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const isModifier = event.ctrlKey || event.metaKey;
      if (isModifier && !event.altKey && !event.shiftKey) {
        const row = rows[focusIndex ?? rows.findIndex((item) => item.path === rovingPath)];
        if (row?.kind === "node" && row.node) {
          if (event.key.toLowerCase() === "c") {
            event.preventDefault();
            onCopy?.(row.node);
            return;
          }
          if (event.key.toLowerCase() === "x") {
            event.preventDefault();
            onCut?.(row.node);
            return;
          }
          if (event.key.toLowerCase() === "v") {
            event.preventDefault();
            onPaste?.(row.node);
            return;
          }
        }
      }
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      const startIndex = typeAheadStartIndex.current;
      const prefix = (typeAhead + event.key).toLowerCase();
      let target = -1;
      for (let offset = 1; offset <= rows.length; offset++) {
        const index = (startIndex + offset) % rows.length;
        const row = rows[index];
        if (row?.kind === "node" && row.node?.name.toLowerCase().startsWith(prefix)) {
          target = index;
          break;
        }
      }
      setTypeAhead(prefix);
      if (typeAheadTimer.current !== null) clearTimeout(typeAheadTimer.current);
      typeAheadTimer.current = setTimeout(() => setTypeAhead(""), 1200);
      if (target === -1) return;
      typeAheadStartIndex.current = target;
      moveFocus(target);
    },
    [focusIndex, moveFocus, onCopy, onCut, onPaste, rovingPath, rows, typeAhead],
  );

  // autoReveal：活动文件切换或所在行从不可见变为可见时滚动到该行（对齐 VS Code explorer.autoReveal）。
  const lastRevealedActive = useRef<string | null>(null);
  const lastActiveRowVisible = useRef(false);
  useEffect(() => {
    const index = active ? rows.findIndex((row) => row.kind === "node" && row.path === active) : -1;
    const visible = index !== -1;
    if (active && index !== -1 && (active !== lastRevealedActive.current || !lastActiveRowVisible.current)) {
      scrollToIndex(index);
    }
    lastRevealedActive.current = active ?? null;
    lastActiveRowVisible.current = visible;
  }, [active, rows, scrollToIndex]);

  useEffect(() => {
    if (focusIndex === null) return;
    const element = scrollRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${focusIndex}"]`);
    element?.focus();
  }, [focusIndex]);

  const scrollTop = scrollRef.current?.scrollTop ?? 0;
  const viewportHeight = scrollRef.current?.clientHeight || 600;
  const currentRange =
    renderWindow.itemCount === rows.length
      ? renderWindow
      : {
          ...fileTreeRenderRange(rows.length, scrollTop, viewportHeight, FILE_ROW_HEIGHT, FILE_TREE_OVERSCAN),
          itemCount: rows.length,
        };
  const renderedIndices = Array.from(
    { length: currentRange.end - currentRange.start },
    (_, offset) => currentRange.start + offset,
  );
  const stickyModel = useMemo(() => buildFileTreeStickyModel(rows), [rows]);
  const stickyRows = fileTreeStickyRows(
    rows,
    stickyModel,
    scrollTop,
    viewportHeight,
    FILE_ROW_HEIGHT,
    FILE_TREE_STICKY_MAX_ITEMS,
  );
  const stickyHeight = stickyRows.reduce(
    (height, stickyRow) => Math.max(height, stickyRow.position + FILE_ROW_HEIGHT),
    0,
  );
  const stickyContainerRef = useRef<HTMLDivElement | null>(null);
  const stickyRowElements = useRef(new Map<number, HTMLDivElement>());
  const syncStickyPositions = useCallback(
    (element: HTMLDivElement) => {
      const currentRows = fileTreeStickyRows(
        rows,
        stickyModel,
        element.scrollTop,
        element.clientHeight,
        FILE_ROW_HEIGHT,
        FILE_TREE_STICKY_MAX_ITEMS,
      );
      let currentHeight = 0;
      for (const stickyRow of currentRows) {
        stickyRowElements.current
          .get(stickyRow.index)
          ?.style.setProperty("transform", `translate3d(0, ${stickyRow.position}px, 0)`);
        currentHeight = Math.max(currentHeight, stickyRow.position + FILE_ROW_HEIGHT);
      }
      const stickyContainer = stickyContainerRef.current;
      if (stickyContainer) {
        stickyContainer.style.height = `${currentHeight}px`;
        stickyContainer.style.right = `${Math.max(0, element.offsetWidth - element.clientWidth)}px`;
      }
    },
    [rows, stickyModel],
  );
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      syncRenderWindow(element);
      syncStickyPositions(element);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [syncRenderWindow, syncStickyPositions]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (!restoredScroll.current) {
      restoredScroll.current = true;
      element.scrollTop = initialScrollTop;
      syncRenderWindow(element);
      syncStickyPositions(element);
    }
    return () => {
      if (scrollCommitTimer.current) clearTimeout(scrollCommitTimer.current);
      onScrollTopChange?.(element.scrollTop);
    };
  }, [initialScrollTop, onScrollTopChange, syncRenderWindow, syncStickyPositions]);

  const rovingVisible = renderedIndices.some(
    (index) => rows[index]?.kind === "node" && rows[index]?.path === rovingPath,
  );
  const fallbackIndex = renderedIndices.find((index) => rows[index]?.kind === "node");

  return (
    <div className="file-tree-viewport" role="tree" aria-label="项目文件" onKeyDown={handleContainerKeyDown}>
      {stickyRows.length > 0 ? (
        <div ref={stickyContainerRef} className="file-tree-sticky" style={{ height: `${stickyHeight}px` }}>
          {stickyRows.map((stickyRow, stickyOrder) => {
            const row = rows[stickyRow.index];
            if (!row || row.kind !== "node") return null;
            const stickyStyle = {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: `${FILE_ROW_HEIGHT}px`,
              transform: `translate3d(0, ${stickyRow.position}px, 0)`,
              zIndex: stickyRows.length - stickyOrder,
              "--file-tree-depth": row.depth,
            } as CSSProperties;
            return (
              <div
                ref={(element) => {
                  if (element) stickyRowElements.current.set(stickyRow.index, element);
                  else stickyRowElements.current.delete(stickyRow.index);
                }}
                key={row.path}
                className="file-tree-sticky-row"
                style={stickyStyle}
              >
                <FileTreeNodeRow
                  row={row}
                  index={stickyRow.index}
                  active={active}
                  tabIndex={-1}
                  sticky
                  onOpen={onOpen}
                  onPinOpen={onPinOpen}
                  renderContextMenu={renderContextMenu}
                  renderTrailingContent={renderTrailingContent}
                  onKeyDown={handleKeyDown}
                />
              </div>
            );
          })}
          <div className="file-tree-sticky-shadow" aria-hidden="true" />
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="file-tree-virtual"
        onScroll={(event) => {
          syncRenderWindow(event.currentTarget);
          syncStickyPositions(event.currentTarget);
          if (onScrollTopChange) {
            if (scrollCommitTimer.current) clearTimeout(scrollCommitTimer.current);
            const element = event.currentTarget;
            scrollCommitTimer.current = setTimeout(() => onScrollTopChange(element.scrollTop), 120);
          }
        }}
      >
        <div style={{ height: `${rows.length * FILE_ROW_HEIGHT}px`, position: "relative", minHeight: "100%" }}>
          {renderedIndices.map((index) => {
            const row = rows[index];
            if (!row) return null;
            const rowStyle = {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: `${FILE_ROW_HEIGHT}px`,
              transform: `translateY(${index * FILE_ROW_HEIGHT}px)`,
              "--file-tree-depth": row.depth,
            } as CSSProperties;
            if (row.kind === "loading") {
              return (
                <div key={row.path} style={rowStyle} className="file-tree-branch-status" role="status">
                  正在加载
                </div>
              );
            }
            const tabIndex = row.path === rovingPath || (!rovingVisible && index === fallbackIndex) ? 0 : -1;
            return (
              <div key={row.path} style={rowStyle}>
                <FileTreeNodeRow
                  row={row}
                  index={index}
                  active={active}
                  tabIndex={tabIndex}
                  onOpen={onOpen}
                  onPinOpen={onPinOpen}
                  renderContextMenu={renderContextMenu}
                  renderTrailingContent={renderTrailingContent}
                  onKeyDown={handleKeyDown}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
