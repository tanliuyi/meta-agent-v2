import { Button } from "@renderer/shared/ui/button";
import { Switch } from "@renderer/shared/ui/switch";
import { useNavigate } from "@tanstack/react-router";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { CodexPluginSummary } from "../../../../shared/codex-plugin-contracts.ts";
import { PluginIcon } from "../../components/chat/plugin-icon.tsx";

export function CodexPluginsView({
  plugins,
  pendingId,
  onMutate,
}: {
  plugins: CodexPluginSummary[];
  pendingId?: string;
  onMutate(plugin: CodexPluginSummary, action: "install" | "update" | "uninstall" | "toggle"): void;
}) {
  const navigate = useNavigate();
  return (
    <section className="plugin-marketplace-section" aria-labelledby="codex-plugin-heading">
      <div className="plugin-marketplace-section-heading">
        <h3 id="codex-plugin-heading">个人 Marketplace</h3>
        <span>{plugins.length} 个本地来源插件</span>
      </div>
      <div className="plugin-marketplace-grid">
        {plugins.map((plugin) => (
          <div className="plugin-marketplace-card" key={plugin.id}>
            <button
              className="plugin-marketplace-card-main"
              type="button"
              onClick={() =>
                void navigate({
                  to: "/plugins/$pluginId",
                  params: { pluginId: plugin.id },
                  search: (previous) => ({ ...previous, view: "marketplace" }),
                })
              }
            >
              <span className="plugin-marketplace-card-header">
                <span className="plugin-marketplace-card-icon">
                  <PluginIcon name={plugin.displayName} />
                </span>
                <span className="plugin-marketplace-card-title">
                  <strong>{plugin.displayName}</strong>
                  <span>{plugin.developerName}</span>
                </span>
                <span className="plugin-marketplace-badge" data-tone={plugin.installed ? "success" : "neutral"}>
                  {plugin.installed ? "已安装" : "可安装"}
                </span>
              </span>
              <span className="plugin-marketplace-card-description">{plugin.description}</span>
              <span className="plugin-marketplace-card-footer">
                <span>{plugin.version}</span>
                <span>{plugin.category ?? "Codex 插件"}</span>
              </span>
            </button>
            <span className="plugin-marketplace-card-footer">
              {plugin.installed ? (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="更新"
                    aria-label={`更新 ${plugin.displayName}`}
                    disabled={pendingId !== undefined}
                    onClick={() => onMutate(plugin, "update")}
                  >
                    <RefreshCw />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="卸载"
                    aria-label={`卸载 ${plugin.displayName}`}
                    disabled={pendingId !== undefined}
                    onClick={() => onMutate(plugin, "uninstall")}
                  >
                    <Trash2 />
                  </Button>
                  <Switch
                    checked={plugin.enabled}
                    disabled={pendingId !== undefined}
                    aria-label={`${plugin.displayName} 启用状态`}
                    onCheckedChange={() => onMutate(plugin, "toggle")}
                  />
                </>
              ) : (
                <Button
                  size="icon"
                  title="安装"
                  aria-label={`安装 ${plugin.displayName}`}
                  disabled={pendingId !== undefined}
                  onClick={() => onMutate(plugin, "install")}
                >
                  <Download />
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
