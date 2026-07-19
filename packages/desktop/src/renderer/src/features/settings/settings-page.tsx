import { WindowsHeader } from "@renderer/components/layout/windows-header";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import Palette from "lucide-react/dist/esm/icons/palette.mjs";
import { useEffect } from "react";
import { Link, NavLink, Outlet } from "react-router";

const SETTINGS_TITLE = "设置 - Meta Agent";

/** 提供不依赖 Desktop session runtime 的设置页布局。 */
export function SettingsPage() {
  const platform = window.desktop.platform;

  useEffect(() => {
    document.title = SETTINGS_TITLE;
  }, []);

  return (
    <div className="app-frame" data-platform={platform}>
      {platform === "win32" ? <WindowsHeader title={SETTINGS_TITLE} /> : null}
      <div className="settings-shell">
        <aside className="settings-menu">
          {platform === "darwin" ? <div className="settings-menu-titlebar" aria-hidden="true" /> : null}
          <nav className="settings-menu-items" aria-label="设置菜单">
            <Link to="/" className="settings-menu-item settings-back-link">
              <ArrowLeft />
              <span>返回聊天</span>
            </Link>
            <div className="settings-menu-divider" aria-hidden="true" />
            <NavLink to="personalization" className="settings-menu-item">
              <Palette />
              <span>个性化</span>
            </NavLink>
          </nav>
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
