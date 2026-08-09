import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { useLayout } from "@renderer/state/layout";
import { getSidebarMaxWidth, SIDEBAR_MIN_WIDTH } from "@renderer/state/layout-preference";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Sidebar } from "./sidebar.tsx";

/** Radix ContextMenu 内容根节点(Portal 到 body)。 */
const MENU_CONTENT = "[data-radix-menu-content]";
/** 已打开的菜单(打开动画结束、关闭动画开始前)。 */
const OPEN_MENU = '[data-radix-menu-content][data-state="open"]';

/**
 * 侧边栏收起后,悬停窗口左缘浮出的侧边栏预览。
 * 指针离开触发区与浮出面板后自动收回;面板内的展开按钮可将侧边栏固定。
 * 面板内呼出的右键菜单属于面板交互:菜单打开期间冻结面板显隐(禁止缩回),
 * 菜单完全移除(含关闭动画)后按鼠标实际位置恢复显隐。
 * 面板右缘提供与主侧边栏一致的拖拽调宽(共享 sidebarWidth 偏好)。
 */
export function FloatingSidebar() {
  const { sidebarOpen, sidebarWidth, setSidebarWidth } = useLayout();
  const [hovered, setHovered] = useState(false);
  // 面板呼出的右键菜单打开期间冻结面板显隐。
  const [menuFrozen, setMenuFrozen] = useState(false);
  // 最近一次右键是否发生在面板内容内,用于区分面板菜单与其他区域的菜单。
  const contextMenuFromSidebar = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const resize = useResizableRegion<HTMLDivElement>({
    value: sidebarWidth,
    min: SIDEBAR_MIN_WIDTH,
    getMaxSize: getSidebarMaxWidth,
    direction: 1,
    orientation: "vertical",
    commitViewportClamp: false,
    onCommit: setSidebarWidth,
  });

  // 记录右键归属与鼠标位置(菜单关闭后按鼠标位置恢复显隐)。
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target === null || target.closest(MENU_CONTENT) !== null) return;
      contextMenuFromSidebar.current =
        target.closest(".floating-sidebar") !== null || target.closest(".sidebar") !== null;
    };
    const onPointerMove = (event: PointerEvent) => {
      lastPointer.current = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("pointermove", onPointerMove, true);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("pointermove", onPointerMove, true);
    };
  }, []);

  // 跟踪右键菜单开合:源于面板的菜单打开时冻结缩回,完全移除后恢复。
  useEffect(() => {
    let frozen = false;
    const observer = new MutationObserver((records) => {
      // 只处理涉及菜单内容的 DOM 变化,避免高频更新。
      const menuAffected = records.some((record) => {
        if (record.type === "attributes") {
          return record.target instanceof Element && record.target.matches(MENU_CONTENT);
        }
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node instanceof Element && (node.matches(MENU_CONTENT) || node.querySelector(MENU_CONTENT) !== null)) {
            return true;
          }
        }
        return false;
      });
      if (!menuAffected) return;
      if (document.querySelector(OPEN_MENU) !== null) {
        frozen = true;
        setMenuFrozen(contextMenuFromSidebar.current);
      } else if (frozen && document.querySelector(MENU_CONTENT) === null) {
        // 菜单完全移除(含关闭动画结束):解冻,并按鼠标实际位置恢复 hover 显隐。
        frozen = false;
        setMenuFrozen(false);
        const element = document.elementFromPoint(lastPointer.current.x, lastPointer.current.y);
        setHovered(element !== null && resize.regionRef.current?.contains(element) === true);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    return () => observer.disconnect();
  }, [resize.regionRef]);

  if (sidebarOpen) return null;

  return (
    <div
      ref={resize.regionRef}
      className="floating-sidebar"
      style={
        {
          "--resizable-region-size": `${resize.initialSize}px`,
        } as CSSProperties
      }
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        // 面板呼出的菜单打开或关闭动画期间不缩回(直接查 DOM,不依赖事件时序)。
        if (contextMenuFromSidebar.current && document.querySelector(MENU_CONTENT) !== null) return;
        setHovered(false);
      }}
    >
      <div className="floating-sidebar-trigger" aria-hidden="true" />
      <div
        ref={resize.separatorRef}
        className="resize-handle resize-handle-sidebar"
        role="separator"
        tabIndex={hovered || menuFrozen ? 0 : -1}
        aria-label="调整侧边栏宽度"
        aria-controls="floating-sidebar-content"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={resize.initialMax}
        aria-valuenow={resize.initialSize}
        aria-valuetext={`${resize.initialSize} 像素`}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
      />
      <div className="floating-sidebar-panel" data-open={hovered || menuFrozen}>
        <Sidebar floating />
      </div>
    </div>
  );
}
