import { Button } from "@renderer/shared/ui/button";
import { Switch } from "@renderer/shared/ui/switch";
import { Toast } from "@renderer/shared/ui/toast";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { LocalPluginsController } from "./use-local-plugins.ts";

interface LocalPluginsViewProps {
  controller: LocalPluginsController;
}

export function LocalPluginsView({ controller }: LocalPluginsViewProps) {
  const snapshot = controller.snapshot;
  const plugins = snapshot?.entries.filter((entry) => entry.source === "development") ?? [];

  return (
    <>
      <header className="plugin-marketplace-page-heading plugin-local-heading">
        <div>
          <h2>本地插件</h2>
          <span>开发和管理当前设备上的 Pi Extension。</span>
        </div>
      </header>

      {snapshot?.diagnostics.length ? (
        <div className="plugin-marketplace-notice" data-tone="warning" role="status">
          {snapshot.diagnostics.map((diagnostic) => `${diagnostic.extensionId}: ${diagnostic.message}`).join("\n")}
        </div>
      ) : null}
      {controller.error ? (
        <Toast
          open
          message={controller.error}
          tone="error"
          title="本地插件操作失败"
          onDismiss={controller.clearError}
        />
      ) : null}
      {snapshot?.reloadRequired ? (
        <div className="plugin-marketplace-notice" data-tone="info" role="status">
          本地插件配置已更新，请在当前会话运行 <code>/reload</code>。
        </div>
      ) : null}

      <section className="plugin-local-mode" aria-labelledby="plugin-local-mode-heading">
        <div>
          <h3 id="plugin-local-mode-heading">Developer Mode</h3>
          <span>本地插件以当前账户权限运行，可访问文件、网络、环境变量和子进程。</span>
        </div>
        <Switch
          checked={snapshot?.developerMode ?? false}
          disabled={!snapshot || controller.mutating}
          aria-label="本地插件 Developer Mode"
          onCheckedChange={(enabled) => void controller.mutate({ type: "set-developer-mode", enabled })}
        />
      </section>

      <section className="plugin-marketplace-section" aria-labelledby="plugin-local-list-heading">
        <div className="plugin-marketplace-section-heading plugin-local-list-heading">
          <div>
            <h3 id="plugin-local-list-heading">本地</h3>
            <span>{plugins.length} 个插件</span>
          </div>
          <Button
            variant="outline"
            disabled={!snapshot?.developerMode || controller.mutating}
            title="选择扩展入口文件或包含 market-manifest.json 的插件目录"
            onClick={() => void controller.chooseDevelopmentEntry()}
          >
            <FolderPlus />
            添加本地插件
          </Button>
        </div>

        {plugins.length ? (
          <div className="plugin-local-list">
            {plugins.map((plugin) => (
              <div className="plugin-local-row" key={plugin.id}>
                <div className="plugin-local-row-main">
                  <div className="plugin-local-row-title">
                    <strong>{plugin.displayName}</strong>
                    <span>Development</span>
                  </div>
                  <span>{plugin.displayPath ?? "本地扩展入口"}</span>
                </div>
                <div className="plugin-local-row-actions">
                  <Switch
                    checked={plugin.configuredEnabled}
                    disabled={!snapshot?.developerMode || controller.mutating}
                    aria-label={`${plugin.displayName} 启用状态`}
                    onCheckedChange={(enabled) =>
                      void controller.mutate({ type: "set-development-enabled", extensionId: plugin.id, enabled })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={controller.mutating}
                    aria-label={`移除 ${plugin.displayName}`}
                    title="移除本地插件"
                    onClick={() => void controller.mutate({ type: "remove-development-entry", extensionId: plugin.id })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : !controller.loading ? (
          <div className="plugin-marketplace-empty">还没有本地插件</div>
        ) : (
          <div className="plugin-marketplace-empty" role="status">
            正在载入本地插件
          </div>
        )}
      </section>
    </>
  );
}
