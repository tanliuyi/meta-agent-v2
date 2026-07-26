import { DesktopSectionShell } from "@renderer/components/layout/desktop-section-shell";
import { settingsReturnSession } from "@renderer/state/settings-navigation";
import { Link, Outlet, useSearch } from "@tanstack/react-router";
import Antenna from "lucide-react/dist/esm/icons/antenna.mjs";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import GitFork from "lucide-react/dist/esm/icons/git-fork.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
import Palette from "lucide-react/dist/esm/icons/palette.mjs";
import Puzzle from "lucide-react/dist/esm/icons/puzzle.mjs";

/** 提供不依赖 Desktop session runtime 的设置页布局。 */
export function SettingsPage() {
  const search = useSearch({ from: "/settings" });
  const returnSession = settingsReturnSession(search);

  const menu = (
    <>
      {returnSession ? (
        <Link
          to="/projects/$projectId/session/$threadId"
          params={{
            projectId: returnSession.projectId,
            threadId: returnSession.threadId,
          }}
          className="settings-menu-item settings-back-link"
        >
          <ArrowLeft />
          <span>返回聊天</span>
        </Link>
      ) : (
        <Link to="/" className="settings-menu-item settings-back-link">
          <ArrowLeft />
          <span>返回聊天</span>
        </Link>
      )}
      <Link
        to="/settings/personalization"
        search={search}
        className="settings-menu-item"
        activeOptions={{ exact: true }}
      >
        <Palette />
        <span>个性化</span>
      </Link>
      <Link to="/settings/models" search={search} className="settings-menu-item" activeOptions={{ exact: true }}>
        <Antenna />
        <span>Provider</span>
      </Link>
      <Link to="/settings/extensions" search={search} className="settings-menu-item" activeOptions={{ exact: true }}>
        <Puzzle />
        <span>扩展</span>
      </Link>
      <Link to="/settings/subagents" search={search} className="settings-menu-item" activeOptions={{ exact: true }}>
        <GitFork />
        <span>子智能体</span>
      </Link>
      <Link to="/settings/about" search={search} className="settings-menu-item" activeOptions={{ exact: true }}>
        <Info />
        <span>关于</span>
      </Link>
    </>
  );

  return (
    <DesktopSectionShell title="设置" menuAriaLabel="设置菜单" menu={menu}>
      <Outlet />
    </DesktopSectionShell>
  );
}
