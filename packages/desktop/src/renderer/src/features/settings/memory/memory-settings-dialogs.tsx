import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogHeader } from "@renderer/shared/ui/dialog-header";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { type FormEvent, forwardRef, useImperativeHandle, useRef, useState } from "react";
import type {
  MemoryEntryCollection,
  MemoryEntrySummary,
  MemoryEntryTarget,
} from "../../../../../shared/memory-settings-contracts.ts";
import { MemoryEntryEditor } from "./memory-entry-editor.tsx";
import type { MemorySettingsController } from "./use-memory-settings-controller.ts";

interface EntryEditorState {
  mode: "add" | "replace";
  target: MemoryEntryTarget;
  projectId?: string;
  projectName?: string;
  entryId?: string;
  initialContent: string;
  sessionId: number;
}

interface PendingDelete {
  target: MemoryEntryTarget;
  projectId?: string;
  entryId: string;
}

export interface MemorySettingsDialogsHandle {
  openAdd(collection: MemoryEntryCollection): void;
  openReplace(collection: MemoryEntryCollection, entry: MemoryEntrySummary): void;
  requestDelete(target: PendingDelete): void;
}

interface MemorySettingsDialogsProps {
  controller: MemorySettingsController;
  busy: boolean;
}

export const MemorySettingsDialogs = forwardRef<MemorySettingsDialogsHandle, MemorySettingsDialogsProps>(
  ({ controller, busy }, ref) => {
    const [editor, setEditor] = useState<EntryEditorState>();
    const [pendingDelete, setPendingDelete] = useState<PendingDelete>();
    const [editorHasContent, setEditorHasContent] = useState(false);
    const editorContentRef = useRef("");
    const editorSessionId = useRef(0);

    useImperativeHandle(
      ref,
      () => ({
        openAdd(collection) {
          setEditor({
            target: collection.target,
            projectId: collection.projectId,
            projectName: collection.projectName,
            mode: "add",
            initialContent: "",
            sessionId: ++editorSessionId.current,
          });
          editorContentRef.current = "";
          setEditorHasContent(false);
        },
        openReplace(collection, entry) {
          setEditor({
            target: collection.target,
            projectId: collection.projectId,
            projectName: collection.projectName,
            mode: "replace",
            entryId: entry.id,
            initialContent: entry.content,
            sessionId: ++editorSessionId.current,
          });
          editorContentRef.current = entry.content;
          setEditorHasContent(entry.content.trim().length > 0);
        },
        requestDelete(target) {
          setPendingDelete(target);
        },
      }),
      [],
    );

    async function submitEntry(event: FormEvent<HTMLFormElement>): Promise<void> {
      event.preventDefault();
      if (!editor || !editorContentRef.current.trim()) return;
      const success = await controller.mutateEntry({
        action: editor.mode,
        target: editor.target,
        projectId: editor.projectId,
        entryId: editor.entryId,
        content: editorContentRef.current,
      });
      if (success) setEditor(undefined);
    }

    return (
      <>
        <Dialog open={editor !== undefined} onOpenChange={(open) => !open && setEditor(undefined)}>
          {editor ? (
            <DialogContent
              className="memory-entry-dialog w-[min(72rem,calc(100vw-48px))] max-w-none gap-0 p-0 max-[480px]:w-[calc(100vw-16px)]"
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <DialogHeader className="memory-entry-dialog-header">
                <DialogTitle>{editor.mode === "add" ? "新增记忆" : "编辑记忆"}</DialogTitle>
                <DialogDescription>
                  {editor.projectName ? `项目：${editor.projectName}` : "保存到持久记忆"}
                </DialogDescription>
              </DialogHeader>
              <form className="memory-entry-form" onSubmit={(event) => void submitEntry(event)}>
                <MemoryEntryEditor
                  key={editor.sessionId}
                  initialContent={editor.initialContent}
                  onChange={(content) => {
                    editorContentRef.current = content;
                    const hasContent = content.trim().length > 0;
                    setEditorHasContent((current) => (current === hasContent ? current : hasContent));
                  }}
                />
                <DialogFooter className="memory-entry-dialog-footer" variant="actions">
                  <Button type="button" variant="outline" onClick={() => setEditor(undefined)}>
                    取消
                  </Button>
                  <Button type="submit" disabled={!editorHasContent || busy}>
                    保存
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          ) : null}
        </Dialog>

        <ConfirmDialog
          open={pendingDelete !== undefined}
          title="删除这条记忆？"
          description="删除后会同步更新记忆搜索索引。"
          confirmLabel="删除"
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={() => {
            if (!pendingDelete) return;
            void controller
              .mutateEntry({ action: "remove", ...pendingDelete })
              .then((success) => success && setPendingDelete(undefined));
          }}
        />
        <ConfirmDialog
          open={controller.routeBlocked}
          title="放弃未保存的记忆设置？"
          description="离开此页面会丢失当前配置修改。"
          confirmLabel="放弃并离开"
          onCancel={controller.cancelRouteChange}
          onConfirm={controller.discardAndProceed}
        />
      </>
    );
  },
);

MemorySettingsDialogs.displayName = "MemorySettingsDialogs";
