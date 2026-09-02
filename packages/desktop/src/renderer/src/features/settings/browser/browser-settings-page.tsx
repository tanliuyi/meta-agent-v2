import { Select } from "@renderer/components/assistant-ui/select/select";
import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { Input } from "@renderer/shared/ui/input";
import { Switch } from "@renderer/shared/ui/switch";
import Eraser from "lucide-react/dist/esm/icons/eraser.mjs";
import Globe2 from "lucide-react/dist/esm/icons/globe-2.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useState } from "react";
import type { BrowserSettings } from "../../../../../shared/browser-settings-contracts.ts";
import { parseSiteListInput } from "../../../../../shared/browser-site-policy.ts";
import { BrowserMediaPermissionsDialog } from "./browser-media-permissions-dialog.tsx";
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

function siteEntries(settings: BrowserSettings): Array<{ site: string; mode: "allow" | "block" }> {
  const sites = new Set([...settings.allowSites, ...settings.blockSites]);
  return [...sites].sort().map((site) => ({
    site,
    mode: settings.blockSites.includes(site) ? "block" : "allow",
  }));
}

const SITE_APPROVAL_OPTIONS = [
  { value: "always-allow", label: "始终允许" },
  { value: "always-ask", label: "始终询问" },
  { value: "always-deny", label: "始终拒绝" },
] as const;

const HISTORY_OPTIONS = [
  { value: "always-ask", label: "始终询问" },
  { value: "always-allow", label: "始终允许" },
  { value: "always-deny", label: "始终拒绝" },
] as const;

const SENSITIVE_ACTION_OPTIONS = [
  { value: "all", label: "始终询问" },
  { value: "unlisted-sites", label: "仅未允许站点询问" },
] as const;

export function BrowserSettingsPage() {
  const controller = useBrowserSettingsController();
  const draft = controller.draft;
  const busy = controller.status === "loading" || controller.status === "saving";
  const canSave = controller.dirty && controller.errors.length === 0 && !busy;
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [mediaDialogOpen, setMediaDialogOpen] = useState(false);
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  const [siteDraft, setSiteDraft] = useState("");
  const [siteMode, setSiteMode] = useState<"allow" | "block">("allow");
  const [siteError, setSiteError] = useState<string>();

  if (!draft) {
    return (
      <div className="settings-content">
        <header className="settings-page-heading">
          <div>
            <h2>浏览器</h2>
            <span>{statusText(controller.status, controller.dirty)}</span>
          </div>
        </header>
        {controller.error ? (
          <div className="settings-page-message" data-tone="error" role="alert">
            {controller.error}
          </div>
        ) : null}
        <div className="settings-loading" aria-label="加载浏览器设置" />
      </div>
    );
  }

  const entries = siteEntries(draft);

  const addWebsitePermission = (): void => {
    const parsed = parseSiteListInput(siteDraft);
    if (parsed.length === 0) {
      setSiteError("请输入有效的 host 或 host:port");
      return;
    }
    const allowSites = new Set(draft.allowSites);
    const blockSites = new Set(draft.blockSites);
    for (const site of parsed) {
      if (siteMode === "allow") {
        blockSites.delete(site);
        allowSites.add(site);
      } else {
        allowSites.delete(site);
        blockSites.add(site);
      }
    }
    controller.mutateSettings({ allowSites: [...allowSites].sort(), blockSites: [...blockSites].sort() });
    setSiteDraft("");
    setSiteError(undefined);
    setSiteDialogOpen(false);
  };

  const updateWebsitePermission = (site: string, mode: "allow" | "block"): void => {
    const nextAllow = draft.allowSites.filter((entry) => entry !== site);
    const nextBlock = draft.blockSites.filter((entry) => entry !== site);
    controller.mutateSettings({
      allowSites: mode === "allow" ? [...nextAllow, site].sort() : nextAllow,
      blockSites: mode === "block" ? [...nextBlock, site].sort() : nextBlock,
    });
  };

  const removeWebsitePermission = (site: string): void => {
    controller.mutateSettings({
      allowSites: draft.allowSites.filter((entry) => entry !== site),
      blockSites: draft.blockSites.filter((entry) => entry !== site),
    });
  };

  return (
    <>
      <div className="settings-content browser-settings-content">
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

        <section className="browser-settings-hero" aria-labelledby="browser-settings-hero-heading">
          <div className="browser-settings-hero-copy">
            <div className="browser-settings-hero-icon" aria-hidden="true">
              <Globe2 />
            </div>
            <div>
              <h3 id="browser-settings-hero-heading">浏览器</h3>
              <p>让 Agent 控制内置浏览器</p>
            </div>
          </div>
          <Switch
            aria-label="启用内置浏览器"
            checked={draft.enabled}
            onCheckedChange={(enabled) => controller.mutateSettings({ enabled })}
          />
        </section>

        <section className="settings-section" aria-labelledby="browser-general-heading">
          <div className="settings-section-heading">
            <h3 id="browser-general-heading">常规</h3>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span>批注截图</span>
              <p className="settings-row-description">截图可帮助 Agent 理解页面，但会增加套餐用量</p>
            </div>
            <Select
              value={draft.includeScreenshots ? "always" : "never"}
              options={[
                { value: "always", label: "始终包含" },
                { value: "never", label: "从不包含" },
              ]}
              aria-label="批注截图策略"
              className="browser-settings-select"
              onValueChange={(value) => controller.mutateSettings({ includeScreenshots: value === "always" })}
            />
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
              <p className="settings-row-description">DOM 快照树的节点预算，控制发送给 Agent 的上下文规模</p>
            </div>
            <Input
              className="browser-settings-number"
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
              <p className="settings-row-description">浏览器控制命令的超时毫秒数</p>
            </div>
            <Input
              className="browser-settings-number"
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
              <span>下载目录</span>
              <p className="settings-row-description">浏览器下载保存位置；留空使用系统下载目录</p>
            </div>
            <Input
              className="browser-settings-directory"
              aria-label="下载目录"
              placeholder="系统下载目录"
              value={draft.downloadDirectory ?? ""}
              onChange={(event) =>
                controller.mutateSettings({
                  downloadDirectory: event.target.value.trim().length > 0 ? event.target.value.trim() : null,
                })
              }
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span>浏览数据</span>
              <p className="settings-row-description">清除应用内浏览器中的浏览历史记录、网站数据、缓存和下载历史</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setClearConfirmOpen(true)}>
              <Eraser />
              清除所有浏览数据
            </Button>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="browser-permissions-heading">
          <div className="settings-section-heading">
            <h3 id="browser-permissions-heading">权限</h3>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span>网站设置</span>
              <p className="settings-row-description">管理内置浏览器中的摄像头和麦克风权限</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setMediaDialogOpen(true)}>
              <Settings2 />
              管理
            </Button>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span>审批</span>
              <p className="settings-row-description">选择 Agent 在打开网站前是否请求批准</p>
            </div>
            <Select
              value={draft.siteApproval}
              options={SITE_APPROVAL_OPTIONS}
              aria-label="网站访问审批"
              className="browser-settings-select"
              onValueChange={(value) =>
                controller.mutateSettings({
                  siteApproval: value === "always-allow" || value === "always-deny" ? value : "always-ask",
                })
              }
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span>历史记录</span>
              <p className="settings-row-description">选择 Agent 是否可以访问内置浏览器历史记录</p>
            </div>
            <Select
              value={draft.historyAccess}
              options={HISTORY_OPTIONS}
              aria-label="浏览历史访问权限"
              className="browser-settings-select"
              onValueChange={(value) =>
                controller.mutateSettings({
                  historyAccess: value === "always-allow" || value === "always-deny" ? value : "always-ask",
                })
              }
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span>敏感操作</span>
              <p className="settings-row-description">提交表单、购买或删除等操作是否需要再次确认</p>
            </div>
            <Select
              value={draft.confirmSensitiveActions}
              options={SENSITIVE_ACTION_OPTIONS}
              aria-label="敏感操作确认"
              className="browser-settings-select"
              onValueChange={(value) =>
                controller.mutateSettings({
                  confirmSensitiveActions: value === "unlisted-sites" ? "unlisted-sites" : "all",
                })
              }
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span>本地站点免确认</span>
              <p className="settings-row-description">对 localhost、127.0.0.1 和 ::1 跳过访问及敏感操作确认</p>
            </div>
            <Switch
              aria-label="本地站点免确认"
              checked={draft.allowLocalhostWithoutConfirmation}
              onCheckedChange={(allowLocalhostWithoutConfirmation) =>
                controller.mutateSettings({ allowLocalhostWithoutConfirmation })
              }
            />
          </div>
        </section>

        <section className="settings-section" aria-labelledby="browser-site-permissions-heading">
          <div className="settings-section-heading browser-settings-section-heading-with-action">
            <div>
              <h3 id="browser-site-permissions-heading">网站权限</h3>
              <p className="settings-row-description">为特定网站覆盖上述默认设置</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setSiteDialogOpen(true)}>
              <Plus />
              添加
            </Button>
          </div>
          <div className="browser-settings-site-list">
            {entries.length === 0 ? (
              <p className="browser-settings-empty">尚无网站专属权限</p>
            ) : (
              entries.map((entry) => (
                <div className="browser-settings-site-row" key={entry.site}>
                  <span className="browser-settings-site-name">{entry.site}</span>
                  <Select
                    value={entry.mode}
                    options={[
                      { value: "allow", label: "允许 Agent 操作" },
                      { value: "block", label: "禁止 Agent 操作" },
                    ]}
                    aria-label={`${entry.site} 的访问权限`}
                    className="browser-settings-site-select"
                    onValueChange={(value) =>
                      updateWebsitePermission(entry.site, value === "block" ? "block" : "allow")
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost-destructive"
                    aria-label={`删除 ${entry.site} 的网站权限`}
                    onClick={() => removeWebsitePermission(entry.site)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <Dialog
        open={siteDialogOpen}
        onOpenChange={(open) => {
          setSiteDialogOpen(open);
          if (!open) {
            setSiteDraft("");
            setSiteError(undefined);
          }
        }}
      >
        <DialogContent className="browser-site-dialog">
          <DialogTitle>添加网站权限</DialogTitle>
          <DialogDescription>输入 host 或 host:port。该设置会覆盖默认的网站审批策略。</DialogDescription>
          <div className="browser-site-dialog-form">
            <label htmlFor="browser-site-pattern">网站</label>
            <Input
              id="browser-site-pattern"
              value={siteDraft}
              placeholder="example.com 或 localhost:5173"
              onChange={(event) => {
                setSiteDraft(event.target.value);
                setSiteError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addWebsitePermission();
                }
              }}
            />
            <label htmlFor="browser-site-mode">访问权限</label>
            <Select
              value={siteMode}
              options={[
                { value: "allow", label: "允许 Agent 操作" },
                { value: "block", label: "禁止 Agent 操作" },
              ]}
              id="browser-site-mode"
              aria-label="网站访问权限"
              className="browser-site-dialog-select"
              onValueChange={(value) => setSiteMode(value === "block" ? "block" : "allow")}
            />
            {siteError ? <p className="browser-media-dialog-error">{siteError}</p> : null}
          </div>
          <DialogFooter variant="actions">
            <DialogClose asChild>
              <Button variant="ghost">取消</Button>
            </DialogClose>
            <Button onClick={addWebsitePermission}>添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BrowserMediaPermissionsDialog
        open={mediaDialogOpen}
        settings={draft}
        onOpenChange={setMediaDialogOpen}
        onChange={controller.mutateSettings}
      />
      <ConfirmDialog
        open={clearConfirmOpen}
        title="清除浏览数据？"
        description="将清除全部会话浏览器分区中的 Cookie、缓存、下载记录与所有站点的登录状态，正在打开的标签页会保持。"
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
