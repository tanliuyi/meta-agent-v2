import DownloadIcon from "lucide-react/dist/esm/icons/download.mjs";
import HistoryIcon from "lucide-react/dist/esm/icons/history.mjs";
import KeyRoundIcon from "lucide-react/dist/esm/icons/key-round.mjs";
import ShieldIcon from "lucide-react/dist/esm/icons/shield.mjs";
import UsersIcon from "lucide-react/dist/esm/icons/users.mjs";
import type { ComponentType, ReactNode, SVGProps } from "react";

/** lucide 图标的本地类型（避免 barrel 类型导入）。 */
type InternalPageIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

/**
 * 内置浏览器内部页（参考 chrome://history 等内部页布局）：
 * 左侧导航 + 右侧内容区，覆盖在 webview 视口之上。
 * 仅用户 UI 入口，Agent 侧（browser_* 工具）不可见。
 */

export type BrowserInternalPageId = "history" | "downloads" | "passwords" | "contacts" | "site-settings";

export const BROWSER_INTERNAL_PAGES: ReadonlyArray<{
  id: BrowserInternalPageId;
  label: string;
  icon: InternalPageIcon;
}> = [
  { id: "history", label: "浏览历史", icon: HistoryIcon },
  { id: "downloads", label: "下载", icon: DownloadIcon },
  { id: "passwords", label: "密码管理器", icon: KeyRoundIcon },
  { id: "contacts", label: "联系信息", icon: UsersIcon },
  { id: "site-settings", label: "网站设置", icon: ShieldIcon },
];

export function BrowserInternalPages({
  page,
  onNavigate,
  children,
}: {
  page: BrowserInternalPageId;
  onNavigate: (page: BrowserInternalPageId) => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="browser-internal-pages">
      <nav className="browser-internal-nav" aria-label="内部页导航">
        {BROWSER_INTERNAL_PAGES.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className="browser-internal-nav-item"
              data-active={page === item.id || undefined}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="browser-internal-content">{children}</div>
    </div>
  );
}
