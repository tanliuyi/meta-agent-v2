import { DesktopSectionShell } from "@renderer/components/layout/desktop-section-shell";
import { settingsReturnSession } from "@renderer/state/settings-navigation";
import { Link, Outlet, useSearch } from "@tanstack/react-router";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import Bot from "lucide-react/dist/esm/icons/bot.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
import Palette from "lucide-react/dist/esm/icons/palette.mjs";
import Puzzle from "lucide-react/dist/esm/icons/puzzle.mjs";
import Server from "lucide-react/dist/esm/icons/server.mjs";

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
        <Palette aria-hidden="true" />
        <span>个性化</span>
      </Link>
      <Link to="/settings/models" search={search} className="settings-menu-item" activeOptions={{ exact: true }}>
        <Server aria-hidden="true" />
        <span>模型服务商</span>
      </Link>
      <Link to="/settings/extensions" search={search} className="settings-menu-item" activeOptions={{ exact: true }}>
        <Puzzle aria-hidden="true" />
        <span>扩展</span>
      </Link>
      <Link to="/settings/subagents" search={search} className="settings-menu-item" activeOptions={{ exact: true }}>
        <Bot aria-hidden="true" />
        <span>子智能体</span>
      </Link>
      <Link to="/settings/about" search={search} className="settings-menu-item" activeOptions={{ exact: true }}>
        <Info aria-hidden="true" />
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
