import { useLayout } from "@renderer/state/layout";
import { useState } from "react";
import { Sidebar } from "./sidebar.tsx";

/**
 * 侧边栏收起后,悬停窗口左缘浮出的侧边栏预览。
 * 指针离开触发区与浮出面板后自动收回;面板内的展开按钮可将侧边栏固定。
 */
export function FloatingSidebar() {
  const { sidebarOpen, sidebarWidth } = useLayout();
  const [hovered, setHovered] = useState(false);

  if (sidebarOpen) return null;

  return (
    <div className="floating-sidebar" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      <div className="floating-sidebar-trigger" aria-hidden="true" />
      <div className="floating-sidebar-panel" data-open={hovered} style={{ width: sidebarWidth }}>
        <Sidebar floating />
      </div>
    </div>
  );
}
