import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Tabs } from "@renderer/shared/ui/tabs";
import { TabsContent } from "@renderer/shared/ui/tabs-content";
import { TabsList } from "@renderer/shared/ui/tabs-list";
import { TabsTrigger } from "@renderer/shared/ui/tabs-trigger";
import { useToast } from "@renderer/shared/ui/use-toast";
import { useNavigate } from "@tanstack/react-router";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { useEffect, useState } from "react";
import { SidebarToggle } from "../../components/layout/sidebar-toggle.tsx";
import { CodexPluginsView } from "./codex-plugins-view.tsx";
import { LocalPluginsView } from "./local-plugins-view.tsx";
import { useCodexPlugins } from "./use-codex-plugins.ts";
import { useLocalPlugins } from "./use-local-plugins.ts";

export function PluginMarketplacePage({
  returnSession,
  initialQuery = "",
  initialView = "marketplace",
}: {
  returnSession?: { projectId: string; threadId: string };
  initialQuery?: string;
  initialView?: "marketplace" | "local";
}) {
  const navigate = useNavigate();
  const [activeView, setActiveView] = useState<"marketplace" | "local">(initialView);
  useEffect(() => {
    setActiveView(initialView);
  }, [initialView]);
  const [query, setQuery] = useState(initialQuery);
  const controller = useCodexPlugins(query);
  const localController = useLocalPlugins(returnSession?.projectId, returnSession?.threadId);
  const toast = useToast();
  useEffect(() => {
    if (controller.notice) {
      toast.notify({ title: "插件状态已更新", message: controller.notice, tone: "success" });
      controller.clearNotice();
    }
  }, [controller.notice, controller.clearNotice, toast]);
  useEffect(() => {
    if (controller.error) {
      toast.notify({
        title: "插件操作失败",
        message: controller.error,
        tone: "error",
      });
      controller.clearError();
    }
  }, [controller.error, controller.clearError, toast]);

  return (
    <>
      <header className="topbar plugin-marketplace-topbar">
        <SidebarToggle location="topbar" />
        <h1>插件中心</h1>
        <div className="topbar-actions">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={
              activeView === "marketplace" ? controller.loading : localController.loading || localController.mutating
            }
            aria-label={activeView === "marketplace" ? "刷新插件目录" : "刷新本地插件"}
            title="刷新"
            onClick={() => void (activeView === "marketplace" ? controller.refresh() : localController.reload())}
          >
            <RefreshCw />
          </Button>
        </div>
      </header>
      <div className="plugin-marketplace-scroll">
        <main className="plugin-marketplace-content">
          <Tabs
            value={activeView}
            onValueChange={(value) => {
              if (value !== "marketplace" && value !== "local") return;
              setActiveView(value);
              void navigate({
                to: "/plugins",
                search: (previous) => ({
                  ...previous,
                  query: value === "marketplace" ? previous.query : undefined,
                  view: value,
                }),
              });
            }}
          >
            <TabsList className="plugin-center-tabs" aria-label="插件来源">
              <TabsTrigger value="marketplace">市场</TabsTrigger>
              <TabsTrigger value="local">本地</TabsTrigger>
            </TabsList>
            <TabsContent value="marketplace" className="plugin-center-tab-content">
              <header className="plugin-marketplace-page-heading">
                <h2>插件</h2>
                <span>安装、更新和管理个人 Marketplace 中的 Codex 插件。</span>
              </header>
              <div className="plugin-marketplace-toolbar" data-has-options={returnSession ? "true" : undefined}>
                <div className="plugin-marketplace-search-field">
                  <Search aria-hidden="true" />
                  <Input
                    type="search"
                    value={query}
                    aria-label="搜索插件"
                    placeholder="搜索插件"
                    style={{ paddingLeft: "2.25rem" }}
                    onChange={(event) => {
                      const query = event.currentTarget.value;
                      setQuery(query);
                      void navigate({
                        to: "/plugins",
                        search: (previous) => ({
                          ...previous,
                          query: query || undefined,
                          view: "marketplace",
                        }),
                      });
                    }}
                  />
                </div>
              </div>
              <CodexPluginsView
                plugins={controller.plugins}
                pendingId={controller.pendingId}
                onMutate={(plugin, action) => void controller.mutate(plugin, action)}
              />
              {!controller.loading && !controller.error && controller.plugins.length === 0 ? (
                <div className="plugin-marketplace-empty">没有匹配的插件</div>
              ) : null}
              {controller.loading && !controller.snapshot ? (
                <div className="plugin-marketplace-empty" role="status">
                  正在载入插件目录
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="local" className="plugin-center-tab-content">
              <LocalPluginsView
                controller={localController}
                onOpen={(pluginId) =>
                  void navigate({
                    to: "/plugins/local/$pluginId",
                    params: { pluginId },
                    search: (previous) => ({ ...previous, query: undefined, view: "local" }),
                  })
                }
              />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </>
  );
}
