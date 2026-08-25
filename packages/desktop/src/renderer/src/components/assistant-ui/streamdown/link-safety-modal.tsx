import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { useCallback, useEffect, useRef } from "react";
import type { LinkSafetyModalProps } from "streamdown";
import { useOpenWorkbenchFileInPanel, useSessionScope } from "../../session-context.tsx";

export function LinkSafetyModal({ url, isOpen, onClose }: LinkSafetyModalProps) {
  const { record } = useSessionScope();
  const openInApp = useOpenWorkbenchFileInPanel();
  const openedLocalUrl = useRef<string | null>(null);
  const localFileLink = isLocalFileLink(url);
  const openLink = useCallback(() => {
    void window.desktop.links
      .open(record.identity.projectId, url)
      .then((result) => {
        if (!result.openInApp || !result.path) return;
        openInApp(result.path);
      })
      .catch((error: unknown) => {
        console.error("Failed to open link:", error);
      });
    onClose();
  }, [onClose, openInApp, record.identity.projectId, url]);

  useEffect(() => {
    if (!isOpen || !localFileLink || openedLocalUrl.current === url) return;
    openedLocalUrl.current = url;
    openLink();
  }, [isOpen, localFileLink, openLink, url]);

  useEffect(() => {
    if (!isOpen) openedLocalUrl.current = null;
  }, [isOpen]);

  if (localFileLink) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-3 sm:max-w-lg">
        <DialogTitle>打开外部链接？</DialogTitle>
        <DialogDescription className="break-all">{url}</DialogDescription>
        <DialogFooter variant="actions">
          <DialogClose asChild>
            <Button variant="ghost">取消</Button>
          </DialogClose>
          <Button onClick={openLink}>打开</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const URI_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-z]:[\\/]/iu;

/** Streamdown 只需对外部链接确认；本地文件引用直接交给主进程解析项目归属。 */
export function isLocalFileLink(url: string): boolean {
  const value = url.trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return false;
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)) return true;
  return value.toLowerCase().startsWith("file:") || !URI_SCHEME_PATTERN.test(value);
}
