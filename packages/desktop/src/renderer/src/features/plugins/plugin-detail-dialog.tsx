import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogHeader } from "@renderer/shared/ui/dialog-header";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import BadgeCheck from "lucide-react/dist/esm/icons/badge-check.mjs";
import Blocks from "lucide-react/dist/esm/icons/blocks.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useState } from "react";
import type {
  InstalledMarketplacePluginSummary,
  MarketplacePluginSummary,
} from "../../../../shared/plugin-marketplace-contracts.ts";
import { PluginConfigurationForm } from "./plugin-configuration-form.tsx";
import { cardState, formatDate, statusLabel, statusTone, updateAvailable } from "./plugin-marketplace-utils.ts";
import { canInstallMarketplacePlugin } from "./use-plugin-marketplace.ts";

interface PluginDetailDialogProps {
  plugin?: MarketplacePluginSummary;
  installed?: InstalledMarketplacePluginSummary;
  marketplaceId?: string;
  open: boolean;
  mutationPending: boolean;
  installing: boolean;
  updating: boolean;
  uninstalling: boolean;
  onClose(): void;
  onInstall(plugin: MarketplacePluginSummary): void;
  onUpdate(plugin: MarketplacePluginSummary): void;
  onUninstall(id: string): void;
}

type PendingAction = "install" | "update" | "uninstall";

export function PluginDetailDialog({
  plugin,
  installed,
  marketplaceId,
  open,
  mutationPending,
  installing,
  updating,
  uninstalling,
  onClose,
  onInstall,
  onUpdate,
  onUninstall,
}: PluginDetailDialogProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  if (!plugin && !installed) return null;
  const name = plugin?.name ?? installed!.displayName;
  const publisher = plugin?.publisher.displayName ?? installed!.marketplaceId;
  const description = plugin?.description ?? "该插件已安装，但当前市场目录中没有对应条目。";
  const capabilities = plugin?.capabilities ?? installed?.capabilities ?? [];
  const hasUpdate = plugin ? updateAvailable(plugin, installed ? [installed] : undefined) : false;
  const state = cardState(plugin, installed);
  const close = () => {
    setPendingAction(undefined);
    onClose();
  };
  const confirmation = pendingAction ? pluginActionConfirmation(pendingAction, name, plugin) : undefined;
  const confirmAction = () => {
    const action = pendingAction;
    setPendingAction(undefined);
    if ((action === "install" || action === "update") && plugin) {
      if (action === "install") onInstall(plugin);
      else onUpdate(plugin);
    } else if (action === "uninstall" && installed) {
      onUninstall(installed.id);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent className="plugin-marketplace-detail-dialog w-[min(60rem,calc(100vw-48px))] max-w-none gap-0 p-0 sm:max-w-none max-[480px]:w-[calc(100vw-16px)] max-[480px]:max-h-[calc(100dvh-16px)]">
        <DialogHeader className="plugin-marketplace-detail-header">
          <div className="plugin-marketplace-detail-identity">
            <div className="plugin-marketplace-detail-icon" aria-hidden="true">
              <Blocks />
            </div>
            <div>
              <DialogTitle>{name}</DialogTitle>
              <div className="plugin-marketplace-detail-publisher">
                <span>{publisher}</span>
                {plugin?.publisher.verified ? (
                  <span className="plugin-marketplace-verified">
                    <BadgeCheck aria-hidden="true" />
                    已验证
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="plugin-marketplace-detail-body">
          <div className="plugin-marketplace-detail-badges" aria-label="插件状态">
            <span className="plugin-marketplace-badge" data-tone={state.tone}>
              {state.label}
            </span>
            {plugin?.status && plugin.status !== "available" ? (
              <span className="plugin-marketplace-badge" data-tone={statusTone(plugin.status)}>
                {statusLabel(plugin.status)}
              </span>
            ) : null}
            {plugin?.containsNativeCode || installed?.containsNativeCode ? (
              <span className="plugin-marketplace-native-badge">包含 Native 内容</span>
            ) : null}
          </div>

          <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-versions">
            <h3 id="plugin-detail-versions">版本与来源</h3>
            <dl className="plugin-marketplace-detail-metadata">
              {installed ? (
                <div>
                  <dt>已安装版本</dt>
                  <dd>{installed.version}</dd>
                </div>
              ) : null}
              {plugin?.compatibleVersion ? (
                <div>
                  <dt>兼容版本</dt>
                  <dd>{plugin.compatibleVersion}</dd>
                </div>
              ) : null}
              {plugin?.latestVersion ? (
                <div>
                  <dt>最新版本</dt>
                  <dd>{plugin.latestVersion}</dd>
                </div>
              ) : null}
              <div>
                <dt>插件 ID</dt>
                <dd>{plugin?.id ?? installed!.id}</dd>
              </div>
              {plugin ? (
                <div>
                  <dt>发布者 ID</dt>
                  <dd>{plugin.publisher.id}</dd>
                </div>
              ) : null}
              <div>
                <dt>市场</dt>
                <dd>{installed?.marketplaceId ?? marketplaceId ?? "当前市场"}</dd>
              </div>
              {plugin ? (
                <div>
                  <dt>更新时间</dt>
                  <dd>{formatDate(plugin.updatedAt)}</dd>
                </div>
              ) : installed ? (
                <div>
                  <dt>安装时间</dt>
                  <dd>{formatDate(installed.installedAt)}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          {plugin?.categories.length ? (
            <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-categories">
              <h3 id="plugin-detail-categories">分类</h3>
              <div className="plugin-marketplace-detail-tags">
                {plugin.categories.map((category) => (
                  <span key={category}>{category}</span>
                ))}
              </div>
            </section>
          ) : null}

          <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-capabilities">
            <h3 id="plugin-detail-capabilities">能力与风险</h3>
            <p>市场插件是全信任 Pi Extension，可在你的账户权限下读写文件、访问网络、读取环境变量并执行程序。</p>
            {plugin?.containsNativeCode || installed?.containsNativeCode ? (
              <p className="plugin-marketplace-native-warning">此版本包含原生代码或平台二进制。</p>
            ) : null}
            {capabilities.length ? (
              <div className="plugin-marketplace-detail-tags">
                {capabilities.map((capability) => (
                  <span key={capability}>{capability}</span>
                ))}
              </div>
            ) : (
              <span className="plugin-marketplace-detail-muted">未提供能力声明</span>
            )}
          </section>

          {installed?.configurable ? <PluginConfigurationForm pluginId={installed.id} /> : null}

          {installed ? (
            <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-local-state">
              <h3 id="plugin-detail-local-state">本地状态</h3>
              <dl className="plugin-marketplace-detail-metadata">
                <div>
                  <dt>安装状态</dt>
                  <dd>{installed.state === "broken" ? "已损坏" : "正常"}</dd>
                </div>
                <div>
                  <dt>Desktop 中启用</dt>
                  <dd>{installed.enabled ? "是" : "否"}</dd>
                </div>
              </dl>
            </section>
          ) : null}
        </div>

        <DialogFooter className="plugin-marketplace-detail-footer">
          {confirmation ? (
            <div className="plugin-marketplace-detail-confirmation" role="group" aria-label={confirmation.title}>
              <div>
                <strong>{confirmation.title}</strong>
                <p>{confirmation.description}</p>
              </div>
              <div className="plugin-marketplace-detail-confirmation-actions">
                <Button variant="ghost" onClick={() => setPendingAction(undefined)}>
                  取消
                </Button>
                <Button
                  variant={pendingAction === "uninstall" ? "destructive" : "default"}
                  disabled={mutationPending}
                  onClick={confirmAction}
                >
                  {confirmation.confirmLabel}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {installed ? (
                <Button variant="outline" disabled={mutationPending} onClick={() => setPendingAction("uninstall")}>
                  <Trash2 />
                  {uninstalling ? "卸载中" : "卸载"}
                </Button>
              ) : null}
              {hasUpdate && plugin ? (
                <Button disabled={mutationPending} onClick={() => setPendingAction("update")}>
                  <RefreshCw />
                  {updating ? "更新中" : "更新"}
                </Button>
              ) : !installed && plugin ? (
                <Button
                  disabled={mutationPending || !canInstallMarketplacePlugin(plugin)}
                  onClick={() => setPendingAction("install")}
                >
                  {installing ? "安装中" : canInstallMarketplacePlugin(plugin) ? "安装" : "当前不可安装"}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function pluginActionConfirmation(
  action: PendingAction,
  name: string,
  plugin: MarketplacePluginSummary | undefined,
): { title: string; description: string; confirmLabel: string } {
  if (action === "uninstall") {
    return {
      title: `卸载 ${name}？`,
      description:
        "插件将不再用于新会话。当前运行中的会话会继续使用原版本，直到运行 /reload；本地版本会暂时保留，以保护仍在运行或已修改的文件。",
      confirmLabel: "确认卸载",
    };
  }

  const nativeWarning = plugin?.containsNativeCode ? "该版本包含原生模块或平台二进制。" : "";
  const capabilities = plugin?.capabilities?.length ? `声明能力：${plugin.capabilities.join("、")}。` : "";
  return {
    title: `${action === "install" ? "安装" : "更新"} ${name}？`,
    description: `市场插件是全信任 Pi Extension，可读写本机文件、访问网络并执行进程，不受能力声明限制。${nativeWarning}${capabilities}`,
    confirmLabel: action === "install" ? "确认安装" : "确认更新",
  };
}
