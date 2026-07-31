import PanelLeft from "lucide-react/dist/esm/icons/panel-left.mjs";
import { useEffect, useRef } from "react";
import { useLayout } from "../../state/layout.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";

let transferSidebarToggleFocus = false;

export function SidebarToggle({ location }: { location: "sidebar" | "topbar" }) {
  const { sidebarOpen, toggleSidebar } = useLayout();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const visible = location === "sidebar" ? sidebarOpen : !sidebarOpen;

  useEffect(() => {
    if (!visible || !transferSidebarToggleFocus) return;
    transferSidebarToggleFocus = false;
    buttonRef.current?.focus();
  }, [visible]);

  if (window.desktop.platform !== "darwin" || !visible) return null;

  return (
    <TooltipIconButton
      ref={buttonRef}
      variant="ghost"
      size="icon"
      className="sidebar-toggle size-6"
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
