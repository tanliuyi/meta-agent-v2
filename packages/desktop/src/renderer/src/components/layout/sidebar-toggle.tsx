import PanelLeft from "lucide-react/dist/esm/icons/panel-left.mjs";
import { useEffect, useRef } from "react";
import { useLayout } from "../../state/layout.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";

let transferSidebarToggleFocus = false;

export function SidebarToggle({
  location,
  floating = false,
}: {
  location: "sidebar" | "topbar" | "window-header";
  /** 浮出预览内始终可见,用于将侧边栏固定为展开。 */
  floating?: boolean;
}) {
  const { sidebarOpen, toggleSidebar } = useLayout();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const visible = floating ? true : location === "sidebar" ? sidebarOpen : location === "topbar" ? !sidebarOpen : true;

  useEffect(() => {
    if (!visible || !transferSidebarToggleFocus) return;
    transferSidebarToggleFocus = false;
    buttonRef.current?.focus();
  }, [visible]);

  if (window.desktop.platform === "win32" && location === "topbar") return null;
  if (!visible) return null;

  return (
    <TooltipIconButton
      ref={buttonRef}
      variant="ghost"
      size="icon"
      className="sidebar-toggle size-6 fixed z-999"
      aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
      aria-controls="sidebar-content"
      aria-expanded={sidebarOpen}
      tooltip={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
      side="bottom"
      onClick={() => {
        transferSidebarToggleFocus = document.activeElement === buttonRef.current;
        toggleSidebar();
      }}
    >
      <PanelLeft className="panel-toggle-icon panel-toggle-icon-left size-4!" data-collapsed={!sidebarOpen} />
    </TooltipIconButton>
  );
}
