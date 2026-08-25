import { useVirtualizer } from "@tanstack/react-virtual";
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
  fileTreeStickyRows,
} from "./file-tree-navigation.ts";
import { FileTreeNodeRow } from "./file-tree-node-row.tsx";

const FILE_ROW_HEIGHT = 28;
const FILE_TREE_OVERSCAN = 12;
const FILE_TREE_STICKY_MAX_ITEMS = 7;

interface FileTreeProps {
  nodes: readonly FileNode[];
  children: Readonly<Record<string, readonly FileNode[]>>;
  expanded: ReadonlySet<string>;
  active?: string;
  onOpen(node: FileNode): void;
  /** 双击节点（固定预览 tab）；目录不触发。 */
  onPinOpen?(node: FileNode): void;
  /** 节点右键菜单内容。 */
  renderContextMenu?(node: FileNode): ReactNode;
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
  depth = 0,
}: FileTreeProps) {
  const rows = useMemo(() => buildRows(nodes, children, expanded, depth), [children, depth, expanded, nodes]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: FILE_TREE_OVERSCAN,
    initialRect: { height: 600, width: 300 },
    getItemKey: (index) => rows[index]?.path ?? index,
  });

  const rovingPath = useMemo(() => {
    if (focusIndex !== null && rows[focusIndex]) return rows[focusIndex].path;
    if (active && hasVisiblePath(nodes, children, expanded, active)) return active;
    return rows.find((row) => row.kind === "node")?.path;
  }, [active, children, expanded, focusIndex, nodes, rows]);

  const moveFocus = useCallback(
    (index: number) => {
      setFocusIndex(index);
      virtualizer.scrollToIndex(index);
    },
    [virtualizer],
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
    [moveFocus, rows, typeAhead],
  );

  // autoReveal：活动文件切换或所在行从不可见变为可见时滚动到该行（对齐 VS Code explorer.autoReveal）。
  const lastRevealedActive = useRef<string | null>(null);
  const lastActiveRowVisible = useRef(false);
  useEffect(() => {
    const index = active ? rows.findIndex((row) => row.kind === "node" && row.path === active) : -1;
    const visible = index !== -1;
    if (active && index !== -1 && (active !== lastRevealedActive.current || !lastActiveRowVisible.current)) {
      virtualizer.scrollToIndex(index, { align: "auto" });
    }
    lastRevealedActive.current = active ?? null;
    lastActiveRowVisible.current = visible;
  }, [active, rows, virtualizer]);

  useEffect(() => {
    if (focusIndex === null) return;
    const element = scrollRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${focusIndex}"]`);
    element?.focus();
  }, [focusIndex]);

  const virtualItems = virtualizer.getVirtualItems();
  const scrollTop = scrollRef.current?.scrollTop ?? virtualizer.scrollOffset ?? 0;
  const viewportHeight = scrollRef.current?.clientHeight ?? virtualizer.scrollRect?.height ?? 600;
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
      if (stickyContainerRef.current) stickyContainerRef.current.style.height = `${currentHeight}px`;
    },
    [rows, stickyModel],
  );
  const rovingVisible = virtualItems.some(
    (virtualRow) => rows[virtualRow.index]?.kind === "node" && rows[virtualRow.index]?.path === rovingPath,
  );
  const fallbackIndex = virtualItems.find((virtualRow) => rows[virtualRow.index]?.kind === "node")?.index;

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
                  onKeyDown={handleKeyDown}
                />
              </div>
            );
          })}
          <div className="file-tree-sticky-shadow" aria-hidden="true" />
        </div>
      ) : null}
      <div ref={scrollRef} className="file-tree-virtual" onScroll={(event) => syncStickyPositions(event.currentTarget)}>
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", minHeight: "100%" }}>
          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const rowStyle = {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: `${FILE_ROW_HEIGHT}px`,
              transform: `translateY(${virtualRow.start}px)`,
              "--file-tree-depth": row.depth,
            } as CSSProperties;
            if (row.kind === "loading") {
              return (
                <div key={row.path} style={rowStyle} className="file-tree-branch-status" role="status">
                  正在加载
                </div>
              );
            }
            const tabIndex = row.path === rovingPath || (!rovingVisible && virtualRow.index === fallbackIndex) ? 0 : -1;
            return (
              <div key={row.path} style={rowStyle}>
                <FileTreeNodeRow
                  row={row}
                  index={virtualRow.index}
                  active={active}
                  tabIndex={tabIndex}
                  onOpen={onOpen}
                  onPinOpen={onPinOpen}
                  renderContextMenu={renderContextMenu}
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
