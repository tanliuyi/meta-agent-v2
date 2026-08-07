import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { Button } from "@renderer/shared/ui/button";
import { Combobox } from "@renderer/shared/ui/combobox";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import { Switch } from "@renderer/shared/ui/switch";
import { Textarea } from "@renderer/shared/ui/textarea";
import Eraser from "lucide-react/dist/esm/icons/eraser.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import { useState } from "react";
import { BROWSER_PARTITION } from "../../../../../shared/browser-contracts.ts";
import { type BrowserSettingsStatus, useBrowserSettingsController } from "./use-browser-settings-controller.ts";

function statusText(status: BrowserSettingsStatus, dirty: boolean): string {
  switch (status) {
    case "loading":
      return "加载中…";
    case "saving":
      return "保存中…";
    case "saved":
      return "已保存";
    case "conflict":
      return "冲突，请重新载入";
    case "error":
      return "加载失败";
    case "dirty":
      return dirty ? "有未保存的修改" : "已就绪";
    default:
      return "已就绪";
  }
}

export function BrowserSettingsPage() {
  const controller = useBrowserSettingsController();
  const draft = controller.draft;
  const busy = controller.status === "loading" || controller.status === "saving";
  const canSave = controller.dirty && controller.errors.length === 0 && !busy;
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  return (
    <>
      <div className="settings-content">
        <header className="settings-page-heading">
          <div>
            <h2>浏览器</h2>
            <span>{statusText(controller.status, controller.dirty)}</span>
          </div>
          <div className="settings-page-actions">
            <TooltipIconButton
              tooltip="重新载入"
              side="bottom"
              disabled={busy || (controller.dirty && controller.status !== "conflict")}
              onClick={() => void controller.reload()}
            >
              <RefreshCw />
            </TooltipIconButton>
            <Button size="sm" disabled={!canSave} onClick={() => void controller.save()}>
              <Save />
              保存
            </Button>
          </div>
        </header>

        {controller.error ? (
          <div className="settings-page-message" data-tone="error" role="alert">
            {controller.error}
          </div>
        ) : null}
        {controller.notice ? (
          <div className="settings-page-message" data-tone="success" role="status">
            {controller.notice}
          </div>
        ) : null}
        {controller.errors.length > 0 ? (
          <div className="settings-page-message" data-tone="error" role="alert">
            {controller.errors.join("；")}
          </div>
        ) : null}

        {controller.status === "loading" || !draft ? (
          <div className="settings-loading" aria-label="加载浏览器设置" />
        ) : (
          <>
            <section className="settings-section" aria-labelledby="browser-site-policy-heading">
              <div className="settings-section-heading">
                <h3 id="browser-site-policy-heading">站点访问策略</h3>
              </div>
              <div className="settings-textarea-row">
                <label htmlFor="browser-allow-sites">允许 Agent 直接操作的站点</label>
                <Textarea
                  id="browser-allow-sites"
                  rows={4}
                  value={draft.allowSites.join("\n")}
                  placeholder={"example.com\nlocalhost:5173"}
                  onChange={(event) => controller.setSiteList("allowSites", event.target.value)}
                />
                <p className="settings-row-description">
                  每行一个站点（host 或 host:port），支持子域匹配；留空时 Agent 每次操作前都会询问你
                </p>
              </div>
              <div className="settings-textarea-row">
                <label htmlFor="browser-block-sites">禁止访问的站点</label>
                <Textarea
                  id="browser-block-sites"
                  rows={4}
                  value={draft.blockSites.join("\n")}
                  placeholder={"evil.example.net"}
                  onChange={(event) => controller.setSiteList("blockSites", event.target.value)}
                />
                <p className="settings-row-description">命中禁止列表的站点直接拒绝导航与操作（优先于允许列表）</p>
              </div>
            </section>

            <section className="settings-section" aria-labelledby="browser-general-heading">
              <div className="settings-section-heading">
                <h3 id="browser-general-heading">通用</h3>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>启动时恢复标签页</span>
                  <p className="settings-row-description">应用启动后恢复上次的浏览器标签页列表与 URL</p>
                </div>
                <Switch
                  aria-label="启动时恢复标签页"
                  checked={draft.restoreTabsOnLaunch}
                  onCheckedChange={(restoreTabsOnLaunch) => controller.mutateSettings({ restoreTabsOnLaunch })}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>快照最大节点数</span>
                  <p className="settings-row-description">DOM 快照树的节点预算（10 到 10000），控制上下文规模</p>
                </div>
                <Input
                  className="w-30"
                  aria-label="快照最大节点数"
                  type="number"
                  min={10}
                  max={10000}
                  value={draft.maxSnapshotNodes}
                  onChange={(event) => controller.mutateSettings({ maxSnapshotNodes: Number(event.target.value) })}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>CDP 命令超时</span>
                  <p className="settings-row-description">
                    浏览器控制命令超时毫秒数（1000 到 120000），超时视为操作失败
                  </p>
                </div>
                <Input
                  className="w-30"
                  aria-label="CDP 命令超时"
                  type="number"
                  min={1000}
                  max={120000}
                  value={draft.cdpTimeoutMs}
                  onChange={(event) => controller.mutateSettings({ cdpTimeoutMs: Number(event.target.value) })}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>敏感操作确认</span>
                  <p className="settings-row-description">
                    表单提交前是否总是询问；选择「仅未允许站点」时，允许列表内的站点免确认
                  </p>
                </div>
                <Combobox
                  value={draft.confirmSensitiveActions}
                  options={[
                    { value: "all", label: "每次提交都确认" },
                    { value: "unlisted-sites", label: "仅未允许站点确认" },
                  ]}
                  placeholder="选择确认粒度"
                  emptyText="无匹配选项"
                  className="w-48"
                  onValueChange={(value) =>
                    controller.mutateSettings({
                      confirmSensitiveActions: value === "unlisted-sites" ? "unlisted-sites" : "all",
                    })
                  }
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>下载目录</span>
                  <p className="settings-row-description">浏览器下载保存位置；留空使用系统下载目录</p>
                </div>
                <Input
                  className="w-72"
                  aria-label="下载目录"
                  placeholder="（系统下载目录）"
                  value={draft.downloadDirectory ?? ""}
                  onChange={(event) =>
                    controller.mutateSettings({
                      downloadDirectory: event.target.value.trim().length > 0 ? event.target.value.trim() : null,
                    })
                  }
                />
              </div>
            </section>

            <section className="settings-section" aria-labelledby="browser-data-heading">
              <div className="settings-section-heading">
                <h3 id="browser-data-heading">数据</h3>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>清除浏览数据</span>
                  <p className="settings-row-description">
                    清除 {BROWSER_PARTITION} 分区中的 Cookie、缓存与登录态；不影响应用主会话与浏览器本身
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setClearConfirmOpen(true)}>
                  <Eraser />
                  清除
                </Button>
              </div>
            </section>
          </>
        )}
      </div>
      <ConfirmDialog
        open={clearConfirmOpen}
        title="清除浏览数据？"
        description="将清除内置浏览器分区中的 Cookie、缓存与所有站点的登录状态，正在打开的标签页会保持。"
        confirmLabel="清除"
        onCancel={() => setClearConfirmOpen(false)}
        onConfirm={() => controller.clearData()}
      />
      <ConfirmDialog
        open={controller.routeBlocked}
        title="放弃未保存的浏览器设置？"
        description="离开此页面会丢失当前配置修改。"
        confirmLabel="放弃并离开"
        onCancel={controller.cancelRouteChange}
        onConfirm={controller.discardAndProceed}
      />
    </>
  );
}
