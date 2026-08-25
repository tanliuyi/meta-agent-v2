import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { useLayout } from "@renderer/state/layout";
import { getSidebarMaxWidth, SIDEBAR_MIN_WIDTH } from "@renderer/state/layout-preference";
import type { CSSProperties, ReactNode } from "react";

export function DesktopSectionShell({
  title,
  menuAriaLabel,
  menu,
  children,
}: {
  title: string;
  menuAriaLabel: string;
  menu: ReactNode;
  children: ReactNode;
}) {
  const { sidebarWidth, setSidebarWidth } = useLayout();
  const resize = useResizableRegion<HTMLElement>({
    value: sidebarWidth,
    min: SIDEBAR_MIN_WIDTH,
    getMaxSize: getSidebarMaxWidth,
    direction: 1,
    orientation: "vertical",
    commitViewportClamp: false,
    onCommit: setSidebarWidth,
  });

  return (
    <div className="settings-shell">
      <aside
        ref={resize.regionRef}
        className="settings-menu"
        style={
          {
            "--resizable-region-size": `${resize.initialSize}px`,
          } as CSSProperties
        }
      >
        <div
          ref={resize.separatorRef}
          className="resize-handle resize-handle-sidebar"
          role="separator"
          tabIndex={0}
          aria-label="调整侧边栏宽度"
          aria-controls="section-menu-content"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={resize.initialMax}
          aria-valuenow={resize.initialSize}
          aria-valuetext={`${resize.initialSize} 像素`}
          onPointerDown={resize.onPointerDown}
          onKeyDown={resize.onKeyDown}
        />
        <div id="section-menu-content" className="settings-menu-content">
          <nav className="settings-menu-items" aria-label={menuAriaLabel}>
            {menu}
          </nav>
        </div>
      </aside>
      <section className="settings-main">
        <header className="settings-header">
          <h1>{title}</h1>
        </header>
        <div className="settings-outlet">{children}</div>
      </section>
    </div>
  );
}
