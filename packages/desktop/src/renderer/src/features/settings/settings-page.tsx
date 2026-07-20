import { WindowsHeader } from "@renderer/components/layout/windows-header";
import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { useLayout } from "@renderer/state/layout";
import { getSidebarMaxWidth, SIDEBAR_MIN_WIDTH } from "@renderer/state/layout-preference";
import { Link, Outlet } from "@tanstack/react-router";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import Boxes from "lucide-react/dist/esm/icons/boxes.mjs";
import Palette from "lucide-react/dist/esm/icons/palette.mjs";
import { type CSSProperties, useEffect } from "react";

const SETTINGS_TITLE = "设置 - Meta Agent";

/** 提供不依赖 Desktop session runtime 的设置页布局。 */
export function SettingsPage() {
  const platform = window.desktop.platform;
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

  useEffect(() => {
    document.title = SETTINGS_TITLE;
  }, []);

  return (
    <div className="app-frame" data-platform={platform}>
      {platform === "win32" ? <WindowsHeader title={SETTINGS_TITLE} /> : null}
      <div className="settings-shell">
        <aside
          ref={resize.regionRef}
          className="settings-menu"
          style={{ "--resizable-region-size": `${resize.initialSize}px` } as CSSProperties}
        >
          <div
            ref={resize.separatorRef}
            className="resize-handle resize-handle-sidebar"
            role="separator"
            tabIndex={0}
            aria-label="调整侧边栏宽度"
            aria-controls="settings-menu-content"
            aria-orientation="vertical"
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={resize.initialMax}
            aria-valuenow={resize.initialSize}
            aria-valuetext={`${resize.initialSize} 像素`}
            onPointerDown={resize.onPointerDown}
            onKeyDown={resize.onKeyDown}
          />
          <div id="settings-menu-content" className="settings-menu-content">
            {platform === "darwin" ? <div className="settings-menu-titlebar" aria-hidden="true" /> : null}
            <nav className="settings-menu-items" aria-label="设置菜单">
              <Link to="/" className="settings-menu-item settings-back-link ">
                <ArrowLeft />
                <span>返回聊天</span>
              </Link>
              <div className="settings-menu-divider" aria-hidden="true" />
              <p className="settings-menu-section-label">偏好设置</p>
              <Link to="/settings/personalization" className="settings-menu-item" activeOptions={{ exact: true }}>
                <Palette />
                <span>个性化</span>
              </Link>
              <Link to="/settings/models" className="settings-menu-item" activeOptions={{ exact: true }}>
                <Boxes />
                <span>模型</span>
              </Link>
            </nav>
          </div>
        </aside>
        <section className="settings-main">
          <header className="settings-header">
            <h1>设置</h1>
          </header>
          <div className="settings-outlet">
            <Outlet />
          </div>
        </section>
      </div>
    </div>
  );
}
