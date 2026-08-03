import { Button } from "@renderer/shared/ui/button";
import { Switch } from "@renderer/shared/ui/switch";
import { Tabs } from "@renderer/shared/ui/tabs";
import { TabsContent } from "@renderer/shared/ui/tabs-content";
import { TabsList } from "@renderer/shared/ui/tabs-list";
import { TabsTrigger } from "@renderer/shared/ui/tabs-trigger";
import Blocks from "lucide-react/dist/esm/icons/blocks.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useState } from "react";
import type { Project } from "../../../../shared/contracts.ts";
import type {
  DesktopExtensionDiagnostic,
  DesktopExtensionListEntry,
  ExtensionScope,
} from "../../../../shared/desktop-extension-contracts.ts";
import { PluginConfigurationForm } from "./plugin-configuration-form.tsx";
import { PluginScopeSettings } from "./plugin-scope-settings.tsx";

interface LocalPluginDetailContentProps {
  plugin: DesktopExtensionListEntry;
  diagnostics: DesktopExtensionDiagnostic[];
  projects: readonly Project[];
  mutating: boolean;
  onToggleEnabled(enabled: boolean): void;
  onScopeChange(scope: ExtensionScope, projectIds?: string[]): void;
  onRemove(): void;
}

export function LocalPluginDetailContent({
  plugin,
  diagnostics,
  projects,
  mutating,
  onToggleEnabled,
  onScopeChange,
  onRemove,
}: LocalPluginDetailContentProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const confirmRemove = () => {
    setConfirmingRemove(false);
    onRemove();
  };

  return (
    <>
      <div className="plugin-marketplace-detail-header">
        <div className="plugin-marketplace-detail-header-main">
          <div className="plugin-marketplace-detail-identity">
            <div className="plugin-marketplace-detail-icon" aria-hidden="true">
              <Blocks />
            </div>
            <div>
              <h1 className="plugin-local-detail-name">{plugin.displayName}</h1>
              <div className="plugin-marketplace-detail-publisher">
                <span>本地开发</span>
                <span className="plugin-local-detail-badge">Development</span>
                <span className="plugin-marketplace-badge" data-tone={plugin.configuredEnabled ? "success" : "neutral"}>
                  {plugin.configuredEnabled ? "已启用" : "已停用"}
                </span>
              </div>
            </div>
          </div>
          <div
            className="plugin-marketplace-detail-actions plugin-marketplace-detail-header-actions"
            data-confirming={confirmingRemove ? "true" : undefined}
            role="group"
            aria-label="本地插件操作"
          >
            {confirmingRemove ? (
              <div className="plugin-marketplace-detail-confirmation" role="group" aria-label="移除本地插件">
                <p>插件将不再用于新会话。当前运行中的会话会继续使用原版本，直到运行 /reload。</p>
                <div className="plugin-marketplace-detail-confirmation-actions">
                  <Button variant="ghost" disabled={mutating} onClick={() => setConfirmingRemove(false)}>
                    取消
                  </Button>
                  <Button variant="destructive" disabled={mutating} onClick={confirmRemove}>
                    确认移除
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="outline" disabled={mutating} onClick={() => setConfirmingRemove(true)}>
                <Trash2 />
                移除
              </Button>
            )}
          </div>
        </div>
        <span className="plugin-marketplace-detail-muted">{plugin.displayPath ?? "本地扩展入口"}</span>
      </div>
      <Tabs defaultValue="overview" className="plugin-marketplace-detail-tabs">
        <TabsList className="plugin-marketplace-detail-tab-list" aria-label="插件详情">
          <TabsTrigger value="overview">基本信息</TabsTrigger>
          <TabsTrigger value="configuration">配置</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="plugin-marketplace-detail-tab-content">
          <div className="plugin-marketplace-detail-body">
            <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-local-detail-metadata">
              <h3 id="plugin-local-detail-metadata">来源</h3>
              <dl className="plugin-marketplace-detail-metadata">
                <div>
                  <dt>插件 ID</dt>
                  <dd>{plugin.id}</dd>
                </div>
                <div>
                  <dt>入口路径</dt>
                  <dd>{plugin.displayPath ?? "本地扩展入口"}</dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>Developer Mode 本地插件</dd>
                </div>
                <div>
                  <dt>已启用</dt>
                  <dd>{plugin.configuredEnabled ? "是" : "否"}</dd>
                </div>
              </dl>
              <div className="plugin-local-detail-toggle">
                <div>
                  <strong>启用此插件</strong>
                  <span>停用后新会话不再加载此插件。</span>
                </div>
                <Switch
                  checked={plugin.configuredEnabled}
                  disabled={mutating}
                  aria-label={`${plugin.displayName} 启用状态`}
                  onCheckedChange={onToggleEnabled}
                />
              </div>
            </section>

            <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-local-detail-risks">
              <h3 id="plugin-local-detail-risks">能力与风险</h3>
              <p>本地插件以当前账户权限运行，可读写文件、访问网络、读取环境变量并执行子进程，是受信任代码而非沙箱。</p>
              <span className="plugin-marketplace-detail-muted">未提供能力声明（本地插件不声明 Marketplace 能力）</span>
            </section>

            <PluginScopeSettings
              pluginId={plugin.id}
              scope={plugin.scope}
              projectIds={plugin.projectIds ?? []}
              projects={projects}
              mutationPending={mutating}
              onSetScope={onScopeChange}
            />

            {diagnostics.length ? (
              <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-local-detail-diagnostics">
                <h3 id="plugin-local-detail-diagnostics">诊断</h3>
                <ul className="plugin-local-detail-diagnostics">
                  {diagnostics.map((diagnostic) => (
                    <li key={`${diagnostic.phase}:${diagnostic.code}`} data-tone="error">
                      <strong>{diagnostic.phase}</strong>
                      <span>{diagnostic.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="configuration" className="plugin-marketplace-detail-tab-content">
          <div className="plugin-marketplace-detail-body">
            {plugin.configurationSchema ? (
              <PluginConfigurationForm pluginId={plugin.id} source="development" />
            ) : (
              <section
                className="plugin-marketplace-detail-section"
                aria-labelledby="plugin-local-detail-configuration-empty"
              >
                <h3 id="plugin-local-detail-configuration-empty">配置</h3>
                <span className="plugin-marketplace-detail-muted">
                  本地插件没有声明配置 Schema；需要密钥或选项时通过环境变量或插件代码配置。
                </span>
              </section>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
