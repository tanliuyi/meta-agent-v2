import { Button } from "@renderer/shared/ui/button";
import { Toast } from "@renderer/shared/ui/toast";
import { useDesktopSelector } from "@renderer/state/desktop-context";
import { selectProjects } from "@renderer/state/desktop-selectors";
import { useNavigate } from "@tanstack/react-router";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { useEffect, useState } from "react";
import { SidebarToggle } from "../../components/layout/sidebar-toggle.tsx";
import { LocalPluginDetailContent } from "./local-plugin-detail-content.tsx";
import { PluginDetailBackLink } from "./plugin-detail-back-link.tsx";
import { PluginMarketplaceBreadcrumb } from "./plugin-marketplace-breadcrumb.tsx";
import { useLocalPlugins } from "./use-local-plugins.ts";

export function LocalPluginDetailPage({
  pluginId,
  returnSession,
}: {
  pluginId: string;
  returnSession?: { projectId: string; threadId: string };
}) {
  const controller = useLocalPlugins(returnSession?.projectId, returnSession?.threadId);
  const projects = useDesktopSelector(selectProjects);
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);
  const plugin = controller.snapshot?.entries.find((entry) => entry.source === "development" && entry.id === pluginId);
  const diagnostics = controller.snapshot?.diagnostics.filter((entry) => entry.extensionId === pluginId) ?? [];
  const name = plugin?.displayName ?? pluginId;

  useEffect(() => {
    if (!removing || controller.loading || plugin || controller.error) return;
    void navigate({
      to: "/plugins",
      search: (previous) => ({ ...previous, query: undefined, view: "local" }),
      replace: true,
    });
  }, [controller.error, controller.loading, navigate, plugin, removing]);

  return (
    <>
      <header className="topbar plugin-marketplace-topbar plugin-marketplace-detail-topbar">
        <SidebarToggle location="topbar" />
        <PluginMarketplaceBreadcrumb source="local" currentLabel={name} />
        <div className="topbar-actions">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={controller.loading || controller.mutating}
            aria-label="刷新本地插件"
            title="刷新"
            onClick={() => void controller.reload()}
          >
            <RefreshCw />
          </Button>
        </div>
      </header>
      <div className="plugin-marketplace-scroll">
        <main className="plugin-marketplace-content plugin-marketplace-detail-page-content">
          <PluginDetailBackLink source="local" />
          {controller.error ? (
            <Toast
              open
              message={controller.error}
              tone="error"
              title="本地插件操作失败"
              onDismiss={controller.clearError}
            />
          ) : null}
          {plugin ? (
            <div className="plugin-marketplace-detail-page">
              <LocalPluginDetailContent
                plugin={plugin}
                diagnostics={diagnostics}
                projects={projects}
                mutating={controller.mutating}
                onToggleEnabled={(enabled) =>
                  void controller.mutate({ type: "set-development-enabled", extensionId: plugin.id, enabled })
                }
                onScopeChange={(scope, projectIds) =>
                  void controller.mutate({
                    type: "set-development-scope",
                    extensionId: plugin.id,
                    scope,
                    projectIds,
                  })
                }
                onRemove={() => {
                  setRemoving(true);
                  void controller.mutate({ type: "remove-development-entry", extensionId: plugin.id });
                }}
              />
            </div>
          ) : controller.error ? (
            <div className="plugin-marketplace-empty" role="alert">
              无法载入本地插件详情
            </div>
          ) : controller.loading ? (
            <div className="plugin-marketplace-empty" role="status">
              正在载入本地插件详情
            </div>
          ) : (
            <div className="plugin-marketplace-empty" role="status">
              找不到本地插件“{pluginId}”
            </div>
          )}
        </main>
      </div>
    </>
  );
}
