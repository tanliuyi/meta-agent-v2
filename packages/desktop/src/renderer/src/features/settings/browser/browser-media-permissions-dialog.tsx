import { Select } from "@renderer/components/assistant-ui/select/select";
import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { Input } from "@renderer/shared/ui/input";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useEffect, useState } from "react";
import type {
  BrowserMediaPermission,
  BrowserMediaPermissionMode,
  BrowserSettings,
} from "../../../../../shared/browser-settings-contracts.ts";
import { isSitePatternValid, normalizeSitePattern } from "../../../../../shared/browser-site-policy.ts";

interface BrowserMediaPermissionsDialogProps {
  open: boolean;
  settings: BrowserSettings;
  onOpenChange(open: boolean): void;
  onChange(change: Partial<BrowserSettings>): void;
}

const MEDIA_OPTIONS = [
  { value: "deny", label: "拒绝" },
  { value: "allow", label: "允许" },
] as const;

export function BrowserMediaPermissionsDialog({
  open,
  settings,
  onOpenChange,
  onChange,
}: BrowserMediaPermissionsDialogProps) {
  const [siteDraft, setSiteDraft] = useState("");
  const [siteError, setSiteError] = useState<string>();

  useEffect(() => {
    if (!open) {
      setSiteDraft("");
      setSiteError(undefined);
    }
  }, [open]);

  const addSite = (): void => {
    const site = normalizeSitePattern(siteDraft);
    if (site === null || !isSitePatternValid(site)) {
      setSiteError("请输入有效的 host 或 host:port");
      return;
    }
    if (settings.mediaPermissions.some((entry) => entry.site === site)) {
      setSiteError("该站点已经存在");
      return;
    }
    onChange({
      mediaPermissions: [...settings.mediaPermissions, { site, camera: "deny", microphone: "deny" }],
    });
    setSiteDraft("");
    setSiteError(undefined);
  };

  const updatePermission = (site: string, field: "camera" | "microphone", value: BrowserMediaPermissionMode): void => {
    onChange({
      mediaPermissions: settings.mediaPermissions.map((entry) =>
        entry.site === site ? { ...entry, [field]: value } : entry,
      ),
    });
  };

  const removeSite = (site: string): void => {
    onChange({
      mediaPermissions: settings.mediaPermissions.filter((entry) => entry.site !== site),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="browser-media-dialog">
        <DialogTitle>网站设置</DialogTitle>
        <DialogDescription>管理内置浏览器中的摄像头和麦克风权限。权限按站点保存。</DialogDescription>
        <div className="browser-media-dialog-body">
          <div className="browser-media-default-row">
            <div className="settings-row-text">
              <span>默认权限</span>
              <p className="settings-row-description">没有网站专属设置时使用此决定。</p>
            </div>
            <Select
              value={settings.mediaDefault}
              options={MEDIA_OPTIONS}
              aria-label="默认摄像头和麦克风权限"
              className="browser-settings-select"
              onValueChange={(value) => onChange({ mediaDefault: value === "allow" ? "allow" : "deny" })}
            />
          </div>
          <div className="browser-media-site-heading">
            <span>网站权限</span>
            <span>摄像头 / 麦克风</span>
          </div>
          <div className="browser-media-site-list">
            {settings.mediaPermissions.length === 0 ? (
              <p className="browser-settings-empty">尚无网站专属权限</p>
            ) : (
              settings.mediaPermissions.map((entry: BrowserMediaPermission) => (
                <div className="browser-media-site-row" key={entry.site}>
                  <span className="browser-media-site-name">{entry.site}</span>
                  <Select
                    value={entry.camera}
                    options={MEDIA_OPTIONS}
                    aria-label={`${entry.site} 摄像头权限`}
                    className="browser-settings-select"
                    onValueChange={(value) =>
                      updatePermission(entry.site, "camera", value === "allow" ? "allow" : "deny")
                    }
                  />
                  <Select
                    value={entry.microphone}
                    options={MEDIA_OPTIONS}
                    aria-label={`${entry.site} 麦克风权限`}
                    className="browser-settings-select"
                    onValueChange={(value) =>
                      updatePermission(entry.site, "microphone", value === "allow" ? "allow" : "deny")
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost-destructive"
                    aria-label={`删除 ${entry.site} 的权限设置`}
                    onClick={() => removeSite(entry.site)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))
            )}
          </div>
          <div className="browser-media-add-row">
            <Input
              value={siteDraft}
              aria-label="添加网站"
              placeholder="example.com 或 localhost:5173"
              onChange={(event) => {
                setSiteDraft(event.target.value);
                setSiteError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addSite();
                }
              }}
            />
            <Button variant="outline" onClick={addSite}>
              添加
            </Button>
          </div>
          {siteError ? <p className="browser-media-dialog-error">{siteError}</p> : null}
        </div>
        <DialogFooter variant="actions">
          <DialogClose asChild>
            <Button>完成</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
