import { LayoutDashboard, type LucideIcon, Package, Store } from "lucide-react";

export type ConsoleRoute = "/" | "/manage" | "/catalog";

export interface ConsoleNavigationItem {
  to: ConsoleRoute;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const consoleNavigation: ConsoleNavigationItem[] = [
  { to: "/", label: "概览", description: "发布者工作区运行状态", icon: LayoutDashboard },
  { to: "/manage", label: "我的插件", description: "管理插件资料、制品和发布版本", icon: Package },
  { to: "/catalog", label: "市场目录", description: "核对公开插件、版本和市场数据", icon: Store },
];

export function consolePageMetadata(pathname: string): Pick<ConsoleNavigationItem, "label" | "description"> {
  if (pathname.startsWith("/plugin/")) {
    return { label: "插件详情", description: "查看公开版本、制品与社区数据" };
  }
  return consoleNavigation.find((item) => item.to === pathname) ?? consoleNavigation[0]!;
}
