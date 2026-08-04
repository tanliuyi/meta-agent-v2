import { DesktopSectionShell } from "@renderer/components/layout/desktop-section-shell";
import { settingsMenuItemVariants } from "@renderer/shared/ui/settings-menu-item-variants";
import { settingsReturnSession } from "@renderer/state/settings-navigation";
import { Link, Outlet, useSearch } from "@tanstack/react-router";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import Bot from "lucide-react/dist/esm/icons/bot.mjs";
import Boxes from "lucide-react/dist/esm/icons/boxes.mjs";
import Brain from "lucide-react/dist/esm/icons/brain.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
import Palette from "lucide-react/dist/esm/icons/palette.mjs";
import Server from "lucide-react/dist/esm/icons/server.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/terminal-square.mjs";

const SETTINGS_LINKS = [
  { to: "/settings/personalization", label: "个性化", icon: Palette },
  { to: "/settings/models", label: "模型服务商", icon: Server },
  { to: "/settings/memory", label: "记忆", icon: Brain },
  { to: "/settings/subagents", label: "子智能体", icon: Bot },
  { to: "/settings/terminal", label: "终端", icon: TerminalSquare },
  { to: "/settings/dependencies", label: "依赖项", icon: Boxes },
  { to: "/settings/about", label: "关于", icon: Info },
] as const;

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
          className={settingsMenuItemVariants({ variant: "back" })}
        >
          <ArrowLeft />
          <span>返回聊天</span>
        </Link>
      ) : (
        <Link to="/" className={settingsMenuItemVariants({ variant: "back" })}>
          <ArrowLeft />
          <span>返回聊天</span>
        </Link>
      )}
      {SETTINGS_LINKS.map(({ icon: Icon, label, to }) => (
        <Link key={to} to={to} search={search} className={settingsMenuItemVariants()} activeOptions={{ exact: true }}>
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </Link>
      ))}
    </>
  );

  return (
    <DesktopSectionShell title="设置" menuAriaLabel="设置菜单" menu={menu}>
      <Outlet />
    </DesktopSectionShell>
  );
}
